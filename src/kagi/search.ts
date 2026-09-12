import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import { Array, Data, Effect, Option, Schema, String } from "effect";
import { SearchResult } from "../domain.ts";
import { ParseError } from "../utils/errors.ts";

export type { SearchResult, SearchResponse } from "../domain.ts";

type SearchPage = Data.TaggedEnum<{ Results: {}; NoResults: {}; Unexpected: {} }>;
const SearchPage = Data.taggedEnum<SearchPage>();
const normalizeText = (value: string): string => String.trim(String.replace(/\s+/g, " ")(value));
const nonEmpty = Schema.decodeUnknownOption(Schema.NonEmptyString);

function classifySearchPage($: cheerio.CheerioAPI): SearchPage {
  if ($(".search-result, .sr-group .__srgi").length > 0) return SearchPage.Results();
  const text = String.toLowerCase(normalizeText($("body").text()));
  return Array.some(["no results", "couldn't find any results", "did not match any"], (marker) =>
    String.includes(marker)(text),
  )
    ? SearchPage.NoResults()
    : SearchPage.Unexpected();
}

const leadingPublishedDatePattern =
  /^(Today|Yesterday|\d+\s+(?:minutes?|hours?|days?|weeks?|months?|years?)\s+ago|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+\d{1,2},\s+\d{4}|(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}|\d{4}-\d{2}-\d{2})\b/i;

function extractPublishedDateAndSnippet(description: cheerio.Cheerio<AnyNode>) {
  const content = description.clone();
  content.find(".summarize-link").remove();
  const spanDate = nonEmpty(normalizeText(content.find(".__sri-time").first().text()));
  const snippet = normalizeText(content.find(".__sri-time").remove().end().text());
  if (Option.isSome(spanDate)) return { publishedDate: spanDate, snippet };
  const date = String.match(leadingPublishedDatePattern)(snippet).pipe(Option.flatMap(Array.head));
  return {
    publishedDate: date,
    snippet: Option.match(date, {
      onNone: () => snippet,
      onSome: (date) => normalizeText(String.slice(date.length)(snippet)),
    }),
  };
}

function extractResult(
  element: cheerio.Cheerio<AnyNode>,
  titleLink: cheerio.Cheerio<AnyNode>,
): Option.Option<SearchResult> {
  const { publishedDate, snippet } = extractPublishedDateAndSnippet(
    element.find(".__sri-desc").first(),
  );
  // Cheerio's nullable attributes are decoded at the HTML boundary, not propagated into the domain.
  return Schema.decodeUnknownOption(SearchResult)({
    title: normalizeText(titleLink.text()),
    url: titleLink.attr("href"),
    snippet,
    publishedDate: Option.getOrUndefined(publishedDate),
  });
}

function extractResults($: cheerio.CheerioAPI, items: string, titles: string) {
  return Array.getSomes(
    Array.map($(items).toArray(), (element) =>
      extractResult($(element), $(element).find(titles).first()),
    ),
  );
}

export const parseSearchResults = Effect.fn("parseSearchResults")(function* (
  html: string,
  limit: number,
) {
  const $ = yield* Effect.try({
    try: () => cheerio.load(html),
    catch: () =>
      new ParseError({
        message: "Failed to parse search results - unexpected HTML structure",
      }),
  });
  return yield* SearchPage.$match(classifySearchPage($), {
    NoResults: () => Effect.succeed<ReadonlyArray<SearchResult>>([]),
    Unexpected: () =>
      Effect.fail(
        new ParseError({
          message: "Failed to parse search results - unexpected HTML structure",
        }),
      ),
    Results: () =>
      Effect.succeed(
        Array.take(
          Array.appendAll(
            extractResults($, ".search-result", ".__sri_title_link"),
            extractResults($, ".sr-group .__srgi", ".__srgi-title a"),
          ),
          limit,
        ),
      ),
  });
});
