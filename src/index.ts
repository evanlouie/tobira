#!/usr/bin/env bun
import { BunRuntime } from "@effect/platform-bun";
import { Boolean, Cause, Console, Effect, Layer, Logger, Match, Option } from "effect";
import { Command } from "effect/unstable/cli";
import pkg from "../package.json";
import { makeCli } from "./cli/parser.ts";
import { Action } from "./domain.ts";
import { startMcpServer } from "./mcp/server.ts";
import { AppLive } from "./services.ts";
import { runSearch } from "./tools/search.ts";
import { runSummarizer } from "./tools/summarizer.ts";
import { errorMessage } from "./utils/errors.ts";

interface ExitReport {
  readonly code: 1 | 2;
  readonly diagnostic: Option.Option<string>;
}

const dispatch = Action.$match({
  Search: ({ input }) => runSearch(input).pipe(Effect.flatMap(Console.log)),
  Summarize: ({ input }) => runSummarizer(input).pipe(Effect.flatMap(Console.log)),
  Mcp: () => startMcpServer,
});

makeCli(dispatch).pipe(
  Command.run({ version: pkg.version }),
  Effect.catch((error) =>
    Effect.gen(function* () {
      // ShowHelp already carries a rendered diagnostic; validation and operational failures do not.
      const report: ExitReport = Match.value(error).pipe(
        Match.tag("ShowHelp", () => ({ code: 2 as const, diagnostic: Option.none<string>() })),
        Match.tag("ValidationError", (error) => ({
          code: 2 as const,
          diagnostic: Option.some(error.message),
        })),
        Match.orElse((error) => ({
          code: 1 as const,
          diagnostic: Option.some(errorMessage(error)),
        })),
      );
      yield* Option.match(report.diagnostic, {
        onNone: () => Effect.void,
        onSome: (message) => Console.error(`Error: ${message}`),
      });
      yield* Effect.sync(() => {
        process.exitCode = report.code;
      });
    }),
  ),
  Effect.provide(
    Layer.merge(AppLive, Logger.layer([Logger.withConsoleError(Logger.formatSimple)])),
  ),
  Effect.tapCause((cause) =>
    Boolean.match(Cause.hasInterruptsOnly(cause), {
      onTrue: () => Effect.void,
      onFalse: () => Console.error(Cause.pretty(cause)),
    }),
  ),
  BunRuntime.runMain({ disableErrorReporting: true }),
);
