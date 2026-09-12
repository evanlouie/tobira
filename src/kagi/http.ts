import { Array, Context, Effect, Layer, Match, Option, Redacted, Schema, String } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { Auth } from "../utils/auth.ts";
import {
  AuthError,
  HttpError,
  KagiChallengeError,
  NetworkError,
  RateLimitError,
  type AppError,
} from "../utils/errors.ts";

export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15";
const challengePaths = ["/login", "/signin", "/sign-in", "/auth", "/turnstile", "/challenge"];
const challengeMarkers = [
  "cf-turnstile",
  "turnstile",
  "browser verification",
  "verify you are human",
  "sign in to kagi",
  "login to kagi",
  "kagi login",
];

export const isAuthOrChallengeUrl = (url: string): boolean => {
  const pathname = Schema.decodeOption(Schema.URLFromString)(url).pipe(
    Option.map((url) => url.pathname),
    Option.getOrElse(() => url),
    String.toLowerCase,
  );
  return Array.some(challengePaths, (path) => String.includes(path)(pathname));
};
export const isAuthOrChallengeBody = (body: string): boolean =>
  Array.some(challengeMarkers, (marker) => String.includes(marker)(String.toLowerCase(body)));
export const isHtmlDocument = (body: string): boolean => /<!doctype html|<html[\s>]/i.test(body);

export const checkResponseStatus = (status: number): Effect.Effect<void, AppError> =>
  Match.value(status).pipe(
    Match.when(Match.is(401, 403), () =>
      Effect.fail(new AuthError({ message: "Invalid or expired session token" })),
    ),
    Match.when(429, () =>
      Effect.fail(new RateLimitError({ message: "Kagi rate limit exceeded; try again later" })),
    ),
    Match.when(
      (status) => status < 200 || status >= 300,
      (status) =>
        Effect.fail(new HttpError({ status: Option.some(status), message: `HTTP ${status}` })),
    ),
    Match.orElse(() => Effect.void),
  );

export const checkNotAuthOrChallengeResponse = (
  url: string,
  body: Option.Option<string>,
): Effect.Effect<void, AppError> =>
  isAuthOrChallengeUrl(url) || Option.exists(body, isAuthOrChallengeBody)
    ? Effect.fail(
        new KagiChallengeError({
          message:
            "Kagi requires additional browser verification; refresh your session token or complete the challenge in a browser",
        }),
      )
    : Effect.void;

/** HttpClient owns request cancellation, including interruption while reading the body. */
export class KagiHttp extends Context.Service<
  KagiHttp,
  {
    readonly text: (
      request: HttpClientRequest.HttpClientRequest,
    ) => Effect.Effect<string, AppError>;
  }
>()("tobira/KagiHttp") {
  static readonly layer = Layer.effect(
    KagiHttp,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const auth = yield* Auth;
      const text = Effect.fn("KagiHttp.text")(function* (
        request: HttpClientRequest.HttpClientRequest,
      ) {
        const token = yield* auth.token;
        const response = yield* client
          .execute(
            request.pipe(
              HttpClientRequest.setHeaders({
                "User-Agent": USER_AGENT,
                Cookie: `kagi_session=${Redacted.value(token)}`,
              }),
            ),
          )
          .pipe(
            Effect.mapError(
              () => new NetworkError({ message: "Network error: Unable to connect to Kagi" }),
            ),
          );
        yield* checkResponseStatus(response.status);
        yield* checkNotAuthOrChallengeResponse(response.url, Option.none());
        const body = yield* response.text.pipe(
          Effect.mapError(
            () => new NetworkError({ message: "Network error: Unable to read Kagi response" }),
          ),
        );
        yield* checkNotAuthOrChallengeResponse(response.url, Option.some(body));
        return body;
      });
      return KagiHttp.of({ text });
    }),
  );
}
