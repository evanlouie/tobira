import {
  Boolean,
  Cause,
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Schema,
  Stdio,
  Stream,
} from "effect";
import { McpProtocol, McpSchema, McpServer, Tool } from "effect/unstable/ai";
import pkg from "../../package.json";
import { Kagi } from "../kagi/client.ts";
import { runSearch, searchToolConfig } from "../tools/search.ts";
import { runSummarizer, summarizerToolConfig } from "../tools/summarizer.ts";
import { Auth } from "../utils/auth.ts";
import { formatAppError, type AllQueriesFailed, type AppError } from "../utils/errors.ts";
import { formatSearchBatch } from "../utils/formatting.ts";

/** Use raw MCP registration to preserve plain text, rather than JSON-stringifying tool output. */
const registerTool = Effect.fn("registerTool")(function* <A, I>(
  config: {
    readonly name: string;
    readonly title: string;
    readonly description: string;
    readonly inputSchema: Schema.Codec<A, I>;
  },
  run: (input: A) => Effect.Effect<string, AppError | AllQueriesFailed, Kagi | Auth>,
) {
  const server = yield* McpServer.McpServer;
  const services = yield* Effect.context<Kagi | Auth>();
  // MCP arguments are objects, including codecs whose wire schema is a union of objects.
  const inputSchema = yield* Schema.decodeEffect(McpSchema.ToolJsonSchema)({
    ...Tool.getJsonSchemaFromSchema(config.inputSchema),
    type: "object",
  }).pipe(Effect.orDie);
  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: config.name,
      title: config.title,
      description: config.description,
      inputSchema,
    }),
    annotations: Context.empty(),
    handle: (payload: unknown) =>
      Schema.decodeUnknownEffect(config.inputSchema)(payload).pipe(
        Effect.mapError((error) => new McpSchema.InvalidParams({ message: error.message })),
        Effect.flatMap((input) =>
          run(input).pipe(
            Effect.match({
              onFailure: (error) =>
                new McpSchema.CallToolResult({
                  isError: true,
                  content: [{ type: "text", text: formatAppError(error) }],
                }),
              onSuccess: (text) =>
                new McpSchema.CallToolResult({ content: [{ type: "text", text }] }),
            }),
          ),
        ),
        Effect.provideContext(services),
      ),
  });
});

export const toolsLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* registerTool(searchToolConfig, (input) =>
      runSearch(input).pipe(Effect.map(formatSearchBatch)),
    );
    yield* registerTool(summarizerToolConfig, runSummarizer);
  }),
);

export const serverLayer = toolsLayer.pipe(
  Layer.provide(
    McpServer.layerStdio({
      name: "tobira",
      version: pkg.version,
      protocols: [
        McpProtocol.v2025_11_25,
        McpProtocol.v2025_06_18,
        McpProtocol.v2025_03_26,
        McpProtocol.v2024_11_05,
      ],
    }),
  ),
);

export const startMcpServer = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  const ended = yield* Deferred.make<void>();
  const transport = Stdio.make({
    ...stdio,
    stdin: stdio.stdin.pipe(Stream.onEnd(Deferred.succeed(ended, void 0))),
  });
  // Effect's stdio protocol interrupts its owning fiber at EOF. Keep that fiber
  // separate so a client disconnect is a clean exit, not process exit code 130.
  const server = yield* Effect.forkScoped(
    Layer.launch(serverLayer).pipe(Effect.provideService(Stdio.Stdio, transport)),
  );
  yield* Effect.raceFirst(Fiber.join(server), Deferred.await(ended)).pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        const endedNormally = yield* Boolean.match(Cause.hasInterruptsOnly(cause), {
          onTrue: () => Deferred.isDone(ended),
          onFalse: () => Effect.succeed(false),
        });
        return yield* Boolean.match(endedNormally, {
          onTrue: () => Effect.void,
          onFalse: () => Effect.failCause(cause),
        });
      }),
    ),
  );
}).pipe(Effect.scoped);
