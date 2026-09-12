import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Boolean, Effect, Layer, Stdio } from "effect";
import { TestConsole } from "effect/testing";
import { runCli } from "../../src/cli/app.ts";
import { Kagi } from "../../src/kagi/client.ts";
import { RateLimitError } from "../../src/utils/errors.ts";
import { authTest } from "../helpers.ts";

const runSearchCli = (queries: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const code = yield* runCli;
    return { code, stdout: yield* TestConsole.logLines, stderr: yield* TestConsole.errorLines };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        BunServices.layer,
        Stdio.layerTest({ args: Effect.succeed(["search", ...queries]) }),
        TestConsole.layer,
        authTest,
        Layer.succeed(Kagi, {
          search: (query) =>
            Boolean.match(query === "failed", {
              onTrue: () => Effect.fail(new RateLimitError({ message: "rate limited" })),
              onFalse: () => Effect.succeed({ data: [] }),
            }),
          summarize: () => Effect.die("not used"),
        }),
      ),
    ),
  );

describe("CLI search exit behavior", () => {
  test("all query failures produce exit 1 and diagnostics on stderr only", async () => {
    const result = await Effect.runPromise(runSearchCli(["failed", "failed"]));
    expect(result.code).toBe(1);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toEqual([expect.stringContaining("All search queries failed.")]);
    expect(result.stderr).toEqual([expect.stringContaining('Query "failed": rate limited')]);
  });

  test("partial batches remain successful and retain query diagnostics", async () => {
    const result = await Effect.runPromise(runSearchCli(["failed", "empty"]));
    expect(result.code).toBe(0);
    expect(result.stderr).toEqual([]);
    expect(result.stdout).toEqual([expect.stringContaining('Results for search query "empty"')]);
    expect(result.stdout).toEqual([expect.stringContaining('Query "failed": rate limited')]);
  });

  test("valid queries with zero results produce exit 0", async () => {
    const result = await Effect.runPromise(runSearchCli(["empty"]));
    expect(result.code).toBe(0);
    expect(result.stderr).toEqual([]);
    expect(result.stdout).toEqual([expect.stringContaining('Results for search query "empty"')]);
  });
});
