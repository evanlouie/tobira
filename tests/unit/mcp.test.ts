import { describe, expect, test } from "bun:test";
import {
  Array,
  Deferred,
  Effect,
  Layer,
  Option,
  Queue,
  Ref,
  Schema,
  Sink,
  Stdio,
  Stream,
} from "effect";
import { Kagi } from "../../src/kagi/client.ts";
import { serverLayer, startMcpServer } from "../../src/mcp/server.ts";
import { RateLimitError } from "../../src/utils/errors.ts";
import { authTest } from "../helpers.ts";

const Json = Schema.fromJsonString(Schema.Json);
const Reply = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.OptionFromOptionalKey(Schema.Int),
    result: Schema.OptionFromOptionalKey(Schema.Unknown),
    error: Schema.OptionFromOptionalKey(
      Schema.Struct({ code: Schema.Int, message: Schema.String }),
    ),
  }),
);
const ToolResult = Schema.Struct({
  isError: Schema.OptionFromOptionalKey(Schema.Boolean),
  content: Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })),
});

describe("MCP stdio protocol", () => {
  test("treats stdin EOF as a clean shutdown", () =>
    Effect.runPromise(
      startMcpServer.pipe(
        Effect.provide(
          Layer.mergeAll(
            Stdio.layerTest({}),
            authTest,
            Layer.succeed(Kagi, {
              search: () => Effect.die("not used"),
              summarize: () => Effect.die("not used"),
            }),
          ),
        ),
        Effect.timeout("5 seconds"),
      ),
    ));

  test("initializes, lists Schema inputs, returns plain text, and reports tool errors", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const input = yield* Queue.unbounded<Uint8Array>();
        const output = yield* Queue.unbounded<Uint8Array>();
        const replies = yield* Queue.unbounded<typeof Reply.Type>();
        const encoder = new TextEncoder();
        const transport = Stdio.layerTest({
          stdin: Stream.fromQueue(input),
          stdout: () =>
            Sink.forEach((chunk: string | Uint8Array) =>
              Queue.offer(output, typeof chunk === "string" ? encoder.encode(chunk) : chunk),
            ),
        });
        yield* Effect.forkScoped(
          Stream.fromQueue(output).pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.mapEffect((line) => Schema.decodeEffect(Reply)(line)),
            Stream.runForEach((reply) => Queue.offer(replies, reply)),
          ),
        );
        const searchCalls = yield* Ref.make(0);
        const kagi = Layer.succeed(Kagi, {
          search: () =>
            Ref.update(searchCalls, (count) => count + 1).pipe(
              Effect.as({
                data: [
                  {
                    title: "Example",
                    url: "https://example.com",
                    snippet: "Snippet",
                    publishedDate: Option.none(),
                  },
                ],
              }),
            ),
          summarize: () => Effect.fail(new RateLimitError({ message: "rate limited" })),
        });
        // The stdio protocol interrupts its owning fiber when stdin closes.
        const ready = yield* Deferred.make<void>();
        yield* Effect.forkScoped(
          Effect.gen(function* () {
            yield* Layer.build(
              serverLayer.pipe(Layer.provide(Layer.mergeAll(transport, authTest, kagi))),
            );
            yield* Deferred.succeed(ready, void 0);
            return yield* Effect.never;
          }).pipe(Effect.scoped),
        );
        yield* Deferred.await(ready);

        const send = (value: Schema.Json) =>
          Schema.encodeEffect(Json)(value).pipe(
            Effect.flatMap((line) => Queue.offer(input, encoder.encode(`${line}\n`))),
          );
        const request = Effect.fnUntraced(function* (
          id: number,
          method: string,
          params: Schema.Json,
        ) {
          yield* send({ jsonrpc: "2.0", id, method, params });
          while (true) {
            const reply = yield* Queue.take(replies);
            if (Option.contains(reply.id, id)) return reply;
          }
        });
        const initialized = yield* request(1, "initialize", {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        });
        expect(Option.isNone(initialized.error)).toBe(true);
        expect(Option.isSome(initialized.result)).toBe(true);
        yield* send({ jsonrpc: "2.0", method: "notifications/initialized" });

        const list = yield* request(2, "tools/list", {});
        const tools = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            tools: Schema.Array(
              Schema.Struct({ name: Schema.String, inputSchema: Schema.JsonObject }),
            ),
          }),
        )(Option.getOrThrow(list.result));
        expect(Array.map(tools.tools, ({ name }) => name)).toEqual([
          "kagi_search_fetch",
          "kagi_summarizer",
        ]);
        expect(tools.tools[0]?.inputSchema).toMatchObject({
          type: "object",
          required: ["queries"],
          properties: { limit: { type: "integer", minimum: 1, maximum: 50 } },
        });

        const search = yield* request(3, "tools/call", {
          name: "kagi_search_fetch",
          arguments: { queries: ["example"] },
        });
        const result = yield* Schema.decodeUnknownEffect(ToolResult)(
          Option.getOrThrow(search.result),
        );
        expect(result.content[0]?.text).toContain("1: Example\nhttps://example.com");
        expect(result.content[0]?.text).not.toStartWith('"');

        const summary = yield* request(4, "tools/call", {
          name: "kagi_summarizer",
          arguments: { url: "https://example.com" },
        });
        const error = yield* Schema.decodeUnknownEffect(ToolResult)(
          Option.getOrThrow(summary.result),
        );
        expect(error.isError).toEqual(Option.some(true));
        expect(error.content).toEqual([{ type: "text", text: "Error: rate limited" }]);

        const invalid = yield* request(5, "tools/call", {
          name: "kagi_search_fetch",
          arguments: { queries: [" "], limit: 99 },
        });
        const invalidResult = yield* Schema.decodeUnknownEffect(ToolResult)(
          Option.getOrThrow(invalid.result),
        );
        expect(invalidResult.isError).toEqual(Option.some(true));
        expect(yield* Ref.get(searchCalls)).toBe(1);
      }).pipe(Effect.scoped, Effect.timeout("5 seconds")),
    );
  });
});
