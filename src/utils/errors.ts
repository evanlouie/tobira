import { Data, Inspectable, Option, Schema } from "effect";

interface ErrorDetails {
  readonly message: string;
}

/** Yieldable errors support Effect.catchTag and retain native Error stack traces. */
export class AuthError extends Data.TaggedError("AuthError")<ErrorDetails> {}
export class TokenFileError extends Data.TaggedError("TokenFileError")<ErrorDetails> {}
export class ValidationError extends Data.TaggedError("ValidationError")<ErrorDetails> {}
export class HttpError extends Data.TaggedError("HttpError")<
  ErrorDetails & {
    readonly status: Option.Option<number>;
  }
> {}
export class RateLimitError extends Data.TaggedError("RateLimitError")<ErrorDetails> {}
export class NetworkError extends Data.TaggedError("NetworkError")<ErrorDetails> {}
export class TimeoutError extends Data.TaggedError("TimeoutError")<ErrorDetails> {}
export class ParseError extends Data.TaggedError("ParseError")<ErrorDetails> {}
export class KagiChallengeError extends Data.TaggedError("KagiChallengeError")<ErrorDetails> {}

export type AppError =
  | AuthError
  | TokenFileError
  | ValidationError
  | HttpError
  | RateLimitError
  | NetworkError
  | TimeoutError
  | ParseError
  | KagiChallengeError;

const Message = Schema.Struct({ message: Schema.OptionFromOptionalNullOr(Schema.Unknown) });

export const errorMessage = (error: unknown): string =>
  Schema.decodeUnknownOption(Message)(error).pipe(
    Option.flatMap(({ message }) => message),
    Option.getOrElse(() => error),
    Inspectable.toStringUnknown,
  );

export const formatAppError = (error: AppError): string => `Error: ${error.message}`;
