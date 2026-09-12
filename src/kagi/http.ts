import {
  Array,
  Boolean,
  Context,
  Data,
  Effect,
  Layer,
  Match,
  Option,
  Redacted,
  Schema,
  String,
} from "effect";
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

type ResponseDisposition = Data.TaggedEnum<{
  Accepted: {};
  InvalidSession: {};
  RateLimited: {};
  Unsuccessful: { readonly status: number };
  BrowserVerification: {};
}>;
const ResponseDisposition = Data.taggedEnum<ResponseDisposition>();

const acceptResponse = ResponseDisposition.$match({
  Accepted: () => Effect.void,
  InvalidSession: () => Effect.fail(new AuthError({ message: "Invalid or expired session token" })),
  RateLimited: () =>
    Effect.fail(new RateLimitError({ message: "Kagi rate limit exceeded; try again later" })),
  Unsuccessful: ({ status }) =>
    Effect.fail(new HttpError({ status: Option.some(status), message: `HTTP ${status}` })),
  BrowserVerification: () =>
    Effect.fail(
      new KagiChallengeError({
        message:
          "Kagi requires additional browser verification; refresh your session token or complete the challenge in a browser",
      }),
    ),
});

/** HTTP status codes are translated into domain dispositions only at this boundary. */
const classifyStatus = (status: number): ResponseDisposition =>
  Match.value(status).pipe(
    Match.when(Match.is(401, 403), () => ResponseDisposition.InvalidSession()),
    Match.when(429, () => ResponseDisposition.RateLimited()),
    Match.when(
      (status) => Boolean.or(status < 200, status >= 300),
      (status) => ResponseDisposition.Unsuccessful({ status }),
    ),
    Match.orElse(() => ResponseDisposition.Accepted()),
  );

export const checkResponseStatus = (status: number): Effect.Effect<void, AppError> =>
  acceptResponse(classifyStatus(status));

export const checkNotAuthOrChallengeResponse = (
  url: string,
  body: Option.Option<string>,
): Effect.Effect<void, AppError> =>
  acceptResponse(
    Option.some(url).pipe(
      Option.filter(isAuthOrChallengeUrl),
      Option.map(() => ResponseDisposition.BrowserVerification()),
      Option.orElse(() =>
        body.pipe(
          Option.filter(isAuthOrChallengeBody),
          Option.map(() => ResponseDisposition.BrowserVerification()),
        ),
      ),
      Option.getOrElse(() => ResponseDisposition.Accepted()),
    ),
  );

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
