import { describe, expect, test } from "bun:test";
import { ConfigProvider, Effect, FileSystem, Layer, Path, PlatformError, Redacted } from "effect";
import { Auth, resolveToken } from "../../src/utils/auth.ts";

const authLayer = (env: Record<string, string>, read: FileSystem.FileSystem["readFileString"]) =>
  Auth.layer.pipe(
    Layer.provide(Layer.merge(Path.layer, FileSystem.layerNoop({ readFileString: read }))),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
  );

describe("Auth", () => {
  test("prefers the trimmed environment token without reading the file", async () => {
    const token = await Effect.runPromise(
      resolveToken.pipe(
        Effect.provide(
          authLayer({ KAGI_SESSION_TOKEN: "  env-token  " }, () =>
            Effect.die("must not read file"),
          ),
        ),
      ),
    );
    expect(Redacted.value(token)).toBe("env-token");
    expect(String(token)).not.toContain("env-token");
  });

  test("falls back to a trimmed token file for blank environment values", async () => {
    const token = await Effect.runPromise(
      resolveToken.pipe(
        Effect.provide(
          authLayer({ HOME: "/home/test", KAGI_SESSION_TOKEN: "   " }, (path) => {
            expect(path).toBe("/home/test/.kagi_session_token");
            return Effect.succeed("  file-token\n");
          }),
        ),
      ),
    );
    expect(Redacted.value(token)).toBe("file-token");
  });

  test("distinguishes missing tokens from unreadable files", async () => {
    for (const [reason, tag] of [
      ["NotFound", "AuthError"],
      ["PermissionDenied", "TokenFileError"],
    ] as const) {
      const layer = authLayer({ HOME: "/home/test" }, () =>
        Effect.fail(
          PlatformError.systemError({
            _tag: reason,
            module: "FileSystem",
            method: "readFileString",
          }),
        ),
      );
      expect(
        await Effect.runPromise(resolveToken.pipe(Effect.flip, Effect.provide(layer))),
      ).toMatchObject({ _tag: tag });
    }
  });

  test("rejects an empty token file", async () => {
    const layer = authLayer({ HOME: "/home/test" }, () => Effect.succeed("\n"));
    expect(
      await Effect.runPromise(resolveToken.pipe(Effect.flip, Effect.provide(layer))),
    ).toMatchObject({ _tag: "AuthError" });
  });
});
