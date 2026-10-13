import { Context, Effect, Layer, Schema } from "effect";
import { HttpClientRequest } from "effect/http";
import {
  NonEmptyText,
  SearchLimit,
  SummarySource,
  Url,
  type SearchResponse,
  type SummaryRequest,
} from "../domain.ts";
import { ValidationError, type AppError } from "../utils/errors.ts";
import { KagiHttp } from "./http.ts";
import { parseSearchResults } from "./search.ts";
import { buildSummaryRequest, parseStreamingSummary } from "./summarize.ts";

const SearchRequest = Schema.Struct({ q: NonEmptyText, limit: SearchLimit });

export class Kagi extends Context.Service<
  Kagi,
  {
    readonly search: (query: string, limit: number) => Effect.Effect<SearchResponse, AppError>;
    readonly summarize: (request: SummaryRequest) => Effect.Effect<string, AppError>;
  }
>()("tobira/Kagi") {
  static readonly layer = Layer.effect(
    Kagi,
    Effect.gen(function* () {
      const http = yield* KagiHttp;
      const search = Effect.fn("Kagi.search")(function* (query: string, limit: number) {
        const input = yield* Schema.decodeEffect(SearchRequest)({ q: query, limit }).pipe(
          Effect.mapError(
            () =>
              new ValidationError({
                message: "Search requires a non-empty query and an integer limit between 1 and 50",
              }),
          ),
        );
        const params = yield* Schema.encodeEffect(SearchRequest)(input).pipe(Effect.orDie);
        const html = yield* http.text(
          HttpClientRequest.get("https://kagi.com/html/search").pipe(
            HttpClientRequest.setUrlParams({ q: params.q }),
          ),
        );
        return { data: yield* parseSearchResults(html, input.limit) };
      });
      const summarize = Effect.fn("Kagi.summarize")(function* (request: SummaryRequest) {
        yield* SummarySource.$match(request.source, {
          Url: ({ input }) => Schema.decodeEffect(Url)(input),
          Text: ({ input }) => Schema.decodeEffect(NonEmptyText)(input),
        }).pipe(
          Effect.mapError(
            () =>
              new ValidationError({
                message: "Summary source must be a valid URL or non-empty text",
              }),
          ),
        );
        const response = yield* http.text(yield* buildSummaryRequest(request));
        return (yield* parseStreamingSummary(response)).output;
      });
      return Kagi.of({ search, summarize });
    }),
  );
}
