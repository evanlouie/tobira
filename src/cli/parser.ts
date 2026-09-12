import { Effect, Schema } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import {
  Action,
  ARTICLE_SUMMARY_LENGTHS,
  NonEmptyText,
  SearchInput,
  SearchLimit,
  SUMMARY_TYPES,
  SUPPORTED_LANGUAGES,
  SummarizerFields,
  SummarizerInput,
  Url,
} from "../domain.ts";
import { ValidationError } from "../utils/errors.ts";

/** Effect CLI handles tokenization, aliases, help, and version. Handlers receive domain actions. */
export const makeCli = <E, R>(dispatch: (action: Action) => Effect.Effect<void, E, R>) => {
  const search = Command.make(
    "search",
    {
      queries: Argument.String("query").pipe(
        Argument.withSchema(NonEmptyText),
        Argument.variadic({ min: 1, max: 10 }),
      ),
      limit: Flag.Int("limit").pipe(
        Flag.withSchema(SearchLimit),
        Flag.optional,
        Flag.withDescription("Results per query (default: 10, max: 50)."),
      ),
    },
    (input) =>
      Schema.decodeUnknownEffect(Schema.toType(SearchInput))(input).pipe(
        Effect.mapError((error) => new ValidationError({ message: error.message })),
        Effect.flatMap((input) => dispatch(Action.Search({ input }))),
      ),
  ).pipe(Command.withDescription("Search Kagi for one to ten queries."));

  const summarize = Command.make(
    "summarize",
    {
      url: Argument.String("url").pipe(Argument.withSchema(Url)),
      summary_type: Flag.Literals("type", SUMMARY_TYPES).pipe(
        Flag.withAlias("summary-type"),
        Flag.optional,
      ),
      summary_length: Flag.Literals("length", ARTICLE_SUMMARY_LENGTHS).pipe(Flag.optional),
      target_language: Flag.Literals("language", SUPPORTED_LANGUAGES).pipe(
        Flag.withAlias("target-language"),
        Flag.optional,
      ),
    },
    (input) =>
      Schema.encodeEffect(SummarizerFields)(input).pipe(
        Effect.flatMap((fields) => Schema.decodeUnknownEffect(SummarizerInput)(fields)),
        Effect.mapError((error) => new ValidationError({ message: error.message })),
        Effect.flatMap((input) => dispatch(Action.Summarize({ input }))),
      ),
  ).pipe(
    Command.withAlias("summary"),
    Command.withDescription("Summarize a URL using Kagi Summarizer."),
  );

  const mcp = Command.make("mcp", {}, () => dispatch(Action.Mcp())).pipe(
    Command.withDescription("Start the MCP stdio server."),
  );
  return Command.make("tobira").pipe(
    Command.withDescription("Kagi search and summarization using a session token."),
    Command.withSubcommands([search, summarize, mcp]),
  );
};
