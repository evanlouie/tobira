import { Console, Effect, Match, Option } from "effect";
import { Command } from "effect/unstable/cli";
import pkg from "../../package.json";
import { Action } from "../domain.ts";
import { startMcpServer } from "../mcp/server.ts";
import { runSearch } from "../tools/search.ts";
import { runSummarizer } from "../tools/summarizer.ts";
import { errorMessage } from "../utils/errors.ts";
import { formatSearchBatch } from "../utils/formatting.ts";
import { makeCli } from "./parser.ts";

interface ExitReport {
  readonly code: 1 | 2;
  readonly diagnostic: Option.Option<string>;
}

const dispatch = Action.$match({
  Search: ({ input }) =>
    runSearch(input).pipe(Effect.map(formatSearchBatch), Effect.flatMap(Console.log)),
  Summarize: ({ input }) => runSummarizer(input).pipe(Effect.flatMap(Console.log)),
  Mcp: () => startMcpServer,
});

/** Return the exit code as a value; only the process entry point writes process.exitCode. */
export const runCli = makeCli(dispatch).pipe(
  Command.run({ version: pkg.version }),
  Effect.as(0),
  Effect.catch((error) =>
    Effect.gen(function* () {
      // ShowHelp already carries a rendered diagnostic; other failures still need reporting.
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
      return report.code;
    }),
  ),
);
