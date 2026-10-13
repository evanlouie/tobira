import { Console, Effect } from "effect";
import { Command } from "effect/cli";
import pkg from "../../package.json";
import { Action } from "../domain.ts";
import { startMcpServer } from "../mcp/server.ts";
import { runSearch } from "../tools/search.ts";
import { runSummarizer } from "../tools/summarizer.ts";
import { errorMessage } from "../utils/errors.ts";
import { formatSearchBatch } from "../utils/formatting.ts";
import { makeCli } from "./parser.ts";

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
  Effect.catchTags({
    // Effect CLI has already rendered ShowHelp.
    ShowHelp: () => Effect.succeed(2),
    ValidationError: (error) => Console.error(`Error: ${error.message}`).pipe(Effect.as(2)),
  }),
  Effect.catch((error) => Console.error(`Error: ${errorMessage(error)}`).pipe(Effect.as(1))),
);
