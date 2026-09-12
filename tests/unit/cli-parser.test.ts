import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Array, Effect, Layer, Option, Ref } from "effect";
import { TestConsole } from "effect/testing";
import { Command } from "effect/unstable/cli";
import { makeCli } from "../../src/cli/parser.ts";
import { Action } from "../../src/domain.ts";

const testLayer = Layer.merge(BunServices.layer, TestConsole.layer);
const parse = Effect.fnUntraced(function* (args: ReadonlyArray<string>) {
  const action = yield* Ref.make(Option.none<Action>());
  yield* Command.runWith(
    makeCli((value) => Ref.set(action, Option.some(value))),
    { version: "1.3.0", renderErrors: false },
  )(args);
  return yield* Ref.get(action);
}, Effect.provide(testLayer));

describe("Effect CLI", () => {
  test.each(
    Array.map([["--help"], ["--version"], ["search", "--help"], ["mcp", "-h"]], (args) => ({
      args,
    })),
  )("handles built-ins without dispatch: $args", async ({ args }) => {
    expect(await Effect.runPromise(parse(args))).toEqual(Option.none());
  });

  test("dispatches search with typed limits", async () => {
    expect(
      await Effect.runPromise(parse(["search", "bun cli parser", "kagi examples", "--limit", "5"])),
    ).toEqual(
      Option.some(
        Action.Search({
          input: { queries: ["bun cli parser", "kagi examples"], limit: Option.some(5) },
        }),
      ),
    );
  });

  test("supports inline limits and literal operands after --", async () => {
    expect(await Effect.runPromise(parse(["search", "--limit=2", "--", "-query"]))).toEqual(
      Option.some(Action.Search({ input: { queries: ["-query"], limit: Option.some(2) } })),
    );
  });

  test("preserves summary aliases and optional values", async () => {
    expect(
      await Effect.runPromise(
        parse([
          "summary",
          "https://example.com/article",
          "--summary-type=article",
          "--length=digest",
          "--target-language=EN",
        ]),
      ),
    ).toEqual(
      Option.some(
        Action.Summarize({
          input: {
            url: "https://example.com/article",
            summary_type: Option.some("article"),
            summary_length: Option.some("digest"),
            target_language: Option.some("EN"),
          },
        }),
      ),
    );
  });

  test.each(
    Array.map(
      [
        ["search"],
        ["search", "query", "--limit", "0"],
        ["search", "query", "--limit", "1.5"],
        ["search", " "],
        ["search", "query", "--unknown"],
        ["summarize"],
        ["summarize", "not-a-url"],
        ["summarize", "https://example.com", "--type", "nope"],
        ["summarize", "https://example.com", "--type", "eli5", "--length", "digest"],
        ["mcp", "--unknown"],
      ],
      (args) => ({ args }),
    ),
  )("rejects invalid invocations: $args", async ({ args }) => {
    const exit = await Effect.runPromise(Effect.exit(parse(args)));
    expect(exit._tag).toBe("Failure");
  });

  test("dispatches MCP", async () => {
    expect(await Effect.runPromise(parse(["mcp"]))).toEqual(Option.some(Action.Mcp()));
  });
});
