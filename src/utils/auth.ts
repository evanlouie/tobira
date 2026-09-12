import {
  Config,
  ConfigProvider,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Schema,
} from "effect";
import { NonEmptyText } from "../domain.ts";
import { AuthError, TokenFileError, type AppError } from "./errors.ts";

const Token = Schema.RedactedFromValue(NonEmptyText);
const decodeToken = Schema.decodeUnknownOption(Token);
const missingToken = new AuthError({
  message:
    "No valid Kagi session token found. Please either:\n" +
    "1. Set KAGI_SESSION_TOKEN environment variable, or\n" +
    "2. Save your token to ~/.kagi_session_token file\n\n" +
    "Get your token from: https://kagi.com/settings?p=api",
});

export class Auth extends Context.Service<
  Auth,
  {
    readonly token: Effect.Effect<Redacted.Redacted<string>, AppError>;
  }
>()("tobira/Auth") {
  static readonly layer = Layer.effect(
    Auth,
    Effect.gen(function* () {
      const provider = yield* ConfigProvider.ConfigProvider;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // Resolve per operation so replacing an expired token does not require restarting MCP.
      const token = Effect.gen(function* () {
        const env = yield* Config.option(Config.String("KAGI_SESSION_TOKEN"));
        const fromEnv = Option.flatMap(env, decodeToken);
        if (Option.isSome(fromEnv)) return fromEnv.value;

        const home = yield* Config.String("HOME").pipe(
          Config.orElse(() => Config.String("USERPROFILE")),
        );
        const contents = yield* fs.readFileString(path.join(home, ".kagi_session_token")).pipe(
          Effect.asSome,
          Effect.catchReason("PlatformError", "NotFound", () =>
            Effect.succeed(Option.none<string>()),
          ),
          Effect.mapError(
            () => new TokenFileError({ message: "Failed to read ~/.kagi_session_token" }),
          ),
        );
        return yield* Effect.fromOption(Option.flatMap(contents, decodeToken)).pipe(
          Effect.mapError(() => missingToken),
        );
      }).pipe(
        Effect.catchTag("ConfigError", () => Effect.fail(missingToken)),
        Effect.provideService(ConfigProvider.ConfigProvider, provider),
      );
      return Auth.of({ token });
    }),
  );
}

export const resolveToken = Effect.flatMap(Auth, ({ token }) => token);
