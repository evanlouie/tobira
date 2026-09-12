import { describe, expect, test } from "bun:test";
import { Deferred, Effect, Fiber, Layer, Option, Redacted } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { TestClock } from "effect/testing";
import {
  checkNotAuthOrChallengeResponse,
  checkResponseStatus,
  isAuthOrChallengeBody,
  isAuthOrChallengeUrl,
  isHtmlDocument,
  KagiHttp,
} from "../../src/kagi/http.ts";
import { Auth } from "../../src/utils/auth.ts";
import { withTimeout } from "../../src/utils/timeout.ts";
import { httpTest } from "../helpers.ts";

describe("Kagi HTTP", () => {
  test.each([
    [401, "AuthError"],
    [403, "AuthError"],
    [429, "RateLimitError"],
    [302, "HttpError"],
    [500, "HttpError"],
  ])("maps HTTP %i to %s", (status, tag) => {
    const response = HttpClientResponse.fromWeb(
      HttpClientRequest.get("https://kagi.com/test"),
      new Response(null, { status }),
    );
    expect(Effect.runSync(Effect.flip(checkResponseStatus(response)))).toMatchObject({ _tag: tag });
  });

  test.each([200, 204, 299])("accepts HTTP %i", (status) => {
    const response = HttpClientResponse.fromWeb(
      HttpClientRequest.get("https://kagi.com/test"),
      new Response(null, { status }),
    );
    expect(Effect.runSyncExit(checkResponseStatus(response))._tag).toBe("Success");
  });

  test("detects challenge URLs and bodies", () => {
    expect(isAuthOrChallengeUrl("https://kagi.com/turnstile?r=/html/search%3Fq%3Dtest")).toBe(true);
    expect(isAuthOrChallengeUrl("https://kagi.com/login")).toBe(true);
    expect(isAuthOrChallengeUrl("https://kagi.com/html/search?q=login")).toBe(false);
    expect(isAuthOrChallengeBody('<div class="cf-turnstile"></div>')).toBe(true);
    expect(isAuthOrChallengeBody("Sign in to Kagi to continue")).toBe(true);
    expect(isAuthOrChallengeBody("ordinary search response")).toBe(false);
    expect(isHtmlDocument("<!DOCTYPE html><html></html>")).toBe(true);
    expect(isHtmlDocument('{"state":"done"}')).toBe(false);
  });

  test("detects successful challenge responses", () => {
    for (const [url, body] of [
      ["https://kagi.com/turnstile", Option.none<string>()],
      ["https://kagi.com/html/search", Option.some("turnstile")],
    ] as const) {
      expect(Effect.runSync(Effect.flip(checkNotAuthOrChallengeResponse(url, body)))).toMatchObject(
        { _tag: "KagiChallengeError" },
      );
    }
  });

  test("sets authentication headers and reads successful bodies", async () => {
    const client = HttpClient.make((request) => {
      expect(request.headers.cookie).toBe("kagi_session=test-token");
      expect(request.headers["user-agent"]).toContain("Safari");
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("body")));
    });
    const program = Effect.flatMap(KagiHttp, (http) =>
      http.text(HttpClientRequest.get("https://kagi.com/test")),
    );
    expect(await Effect.runPromise(program.pipe(Effect.provide(httpTest(client))))).toBe("body");
  });

  test("maps synchronous fetch failures without leaking the token", async () => {
    const layer = KagiHttp.layer.pipe(
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(
        Layer.succeed(Auth, { token: Effect.succeed(Redacted.make("secret\ninvalid-header")) }),
      ),
    );
    const error = await Effect.runPromise(
      Effect.flatMap(KagiHttp, (http) =>
        http.text(HttpClientRequest.get("https://kagi.com/test")),
      ).pipe(Effect.flip, Effect.provide(layer)),
    );
    expect(error._tag).toBe("NetworkError");
    expect(error.message).not.toContain("secret");
  });

  test.each([
    { status: 401, url: "https://kagi.com/test", tag: "AuthError" },
    { status: 429, url: "https://kagi.com/test", tag: "RateLimitError" },
    { status: 200, url: "https://kagi.com/login", tag: "KagiChallengeError" },
  ])("releases unread responses on $tag before the service closes", ({ status, url, tag }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const received = yield* Deferred.make<AbortSignal>();
        const client = HttpClient.make((request, _url, signal) => {
          const source = new Response("unread body", { status });
          Object.defineProperty(source, "url", { value: url });
          return Deferred.succeed(received, signal).pipe(
            Effect.as(HttpClientResponse.fromWeb(request, source)),
          );
        });
        yield* Effect.gen(function* () {
          const http = yield* KagiHttp;
          const error = yield* Effect.flip(
            http.text(HttpClientRequest.get("https://kagi.com/test")),
          );
          const signal = yield* Deferred.await(received);
          expect(error._tag).toBe(tag);
          expect(signal.aborted).toBe(true);
        }).pipe(Effect.provide(httpTest(client)));
      }),
    ),
  );

  test("keeps the request alive through body consumption, then closes its scope", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const received = yield* Deferred.make<AbortSignal>();
        const client = HttpClient.make((request, _url, signal) => {
          const response = HttpClientResponse.fromWeb(request, new Response("body"));
          const body = response.text;
          Object.defineProperty(response, "text", {
            value: Effect.gen(function* () {
              expect(signal.aborted).toBe(false);
              return yield* body;
            }),
          });
          return Deferred.succeed(received, signal).pipe(Effect.as(response));
        });
        yield* Effect.gen(function* () {
          const http = yield* KagiHttp;
          expect(yield* http.text(HttpClientRequest.get("https://kagi.com/test"))).toBe("body");
          const signal = yield* Deferred.await(received);
          expect(signal.aborted).toBe(true);
        }).pipe(Effect.provide(httpTest(client)));
      }),
    ));

  test("aborts the HttpClient signal on timeout", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<AbortSignal>();
        const client = HttpClient.make((_request, _url, signal) =>
          Deferred.succeed(started, signal).pipe(Effect.andThen(Effect.never)),
        );
        const request = Effect.flatMap(KagiHttp, (http) =>
          http.text(HttpClientRequest.get("https://kagi.com/test")),
        ).pipe(Effect.provide(httpTest(client)));
        const fiber = yield* Effect.forkChild(Effect.flip(withTimeout(request, 10, "timeout")));
        const signal = yield* Deferred.await(started);
        yield* TestClock.adjust(10);
        expect(yield* Fiber.join(fiber)).toMatchObject({ _tag: "TimeoutError" });
        expect(signal.aborted).toBe(true);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });
});
