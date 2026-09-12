#!/usr/bin/env bun
import { BunRuntime } from "@effect/platform-bun";
import { Cause, Console, Effect, Layer, Logger } from "effect";
import { Command } from "effect/unstable/cli";
import pkg from "../package.json";
import { makeCli } from "./cli/parser.ts";
import { Action } from "./domain.ts";
import { startMcpServer } from "./mcp/server.ts";
import { AppLive } from "./services.ts";
import { runSearch } from "./tools/search.ts";
import { runSummarizer } from "./tools/summarizer.ts";
import { errorMessage } from "./utils/errors.ts";

const dispatch = Action.$match({
  Search: ({ input }) => runSearch(input).pipe(Effect.flatMap(Console.log)),
  Summarize: ({ input }) => runSummarizer(input).pipe(Effect.flatMap(Console.log)),
  Mcp: () => startMcpServer,
});

makeCli(dispatch).pipe(
  Command.run({ version: pkg.version }),
  Effect.catch((error) =>
    Effect.gen(function* () {
      // Effect CLI has already rendered ShowHelp. Operational failures get a short message.
      if (error._tag !== "ShowHelp") yield* Console.error(`Error: ${errorMessage(error)}`);
      yield* Effect.sync(() => {
        process.exitCode = error._tag === "ShowHelp" || error._tag === "ValidationError" ? 2 : 1;
      });
    }),
  ),
  Effect.provide(
    Layer.merge(AppLive, Logger.layer([Logger.withConsoleError(Logger.formatSimple)])),
  ),
  Effect.tapCause((cause) =>
    Cause.hasInterruptsOnly(cause) ? Effect.void : Console.error(Cause.pretty(cause)),
  ),
  BunRuntime.runMain({ disableErrorReporting: true }),
);
