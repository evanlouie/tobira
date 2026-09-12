import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import { err, ok, ResultAsync, type Result } from "neverthrow";
import { match } from "ts-pattern";

import type { AppError } from "../utils/errors.ts";
import { isNonEmptyString } from "../utils/strings.ts";
import {
  checkNotAuthOrChallengeResponse,
  checkResponseStatus,
  kagiHeaders,
  mapFetchError,
  safeFetch,
  type RequestOptions,
} from "./http.ts";

const MAX_SEARCH_LIMIT = 50;

export interface SearchResult {
  t: 0;
  url: string;
  title: string;
  snippet: string;
  publishedDate?: string;
}

export interface SearchResponse {
  data: SearchResult[];
}

type SearchPageKind = "results" | "no-results" | "unexpected";

const validateSearchInput = (query: string, token: string, limit: number): Result<void, AppError> =>
  match({ query, token, limit })
    .when(
      ({ query }) => !isNonEmptyString(query),
      () =>
        err({
          type: "ValidationError" as const,
          message: "Search query is required and must be a string",
        }),
    )
    .when(
      ({ token }) => !isNonEmptyString(token),
      () =>
        err({
          type: "ValidationError" as const,
          message: "Session token is required and must be a string",
        }),
    )
    .when(
      ({ limit }) => limit < 1 || limit > MAX_SEARCH_LIMIT || !Number.isInteger(limit),
      () =>
        err({
          type: "ValidationError" as const,
          message: `Limit must be an integer between 1 and ${MAX_SEARCH_LIMIT}`,
        }),
    )
    .otherwise(() => ok(undefined));

/** Performs a Kagi web search by scraping the HTML results page and parsing structured results. */
export function search(
  query: string,
  token: string,
  limit: number = 10,
  options: RequestOptions = {},
): ResultAsync<SearchResponse, AppError> {
  return validateSearchInput(query, token, limit)
    .asyncAndThen(() =>
      safeFetch(`https://kagi.com/html/search?q=${encodeURIComponent(query)}`, {
        headers: kagiHeaders(token),
        signal: options.signal,
      }),
    )
    .andThen((response) =>
      checkResponseStatus(response).asyncAndThen(() =>
        ResultAsync.fromPromise(response.text(), mapFetchError).andThen((html) =>
          checkNotAuthOrChallengeResponse(response, html)
            .andThen(() => parseSearchResults(html, limit))
            .map((results) => ({ data: results })),
        ),
      ),
    );
}

function classifySearchPage($: cheerio.CheerioAPI): SearchPageKind {
  return match({
    hasModernResults: $(".search-result").length > 0,
    hasGroupedResults: $(".sr-group .__srgi").length > 0,
    bodyText: $("body").text().replaceAll(/\s+/g, " ").toLowerCase(),
  })
    .with({ hasModernResults: true }, () => "results" as const)
    .with({ hasGroupedResults: true }, () => "results" as const)
    .when(
      ({ bodyText }) =>
        bodyText.includes("no results") ||
        bodyText.includes("couldn't find any results") ||
        bodyText.includes("did not match any"),
      () => "no-results" as const,
    )
    .otherwise(() => "unexpected" as const);
}

function extractResults(
  $: cheerio.CheerioAPI,
  itemSelector: string,
  titleSelector: string,
  limit: number,
): SearchResult[] {
  const results: SearchResult[] = [];

  $(itemSelector).each((_, element) =>
    match(results.length >= limit)
      .with(true, () => false)
      .with(false, () => {
        const $el = $(element);
        return match(extractResult($el, $el.find(titleSelector).first()))
          .with(null, () => undefined)
          .otherwise((result) => {
            results.push(result);
            return undefined;
          });
      })
      .exhaustive(),
  );

  return results;
}

function parseSearchResults(html: string, limit: number): Result<SearchResult[], AppError> {
  try {
    const $ = cheerio.load(html);

    return match(classifySearchPage($))
      .with("no-results", () => ok([]))
      .with("unexpected", () =>
        err({
          type: "ParseError" as const,
          message: "Failed to parse search results - unexpected HTML structure",
        }),
      )
      .with("results", () => {
        const modernResults = extractResults($, ".search-result", ".__sri_title_link", limit);
        const groupedResults = match(limit - modernResults.length)
          .with(0, () => [])
          .otherwise((remaining) =>
            extractResults($, ".sr-group .__srgi", ".__srgi-title a", remaining),
          );

        return ok([...modernResults, ...groupedResults]);
      })
      .exhaustive();
  } catch (cause) {
    return err({
      type: "ParseError" as const,
      message: "Failed to parse search results - unexpected HTML structure",
      cause,
    });
  }
}

const normalizeText = (value: string): string => value.replaceAll(/\s+/g, " ").trim();

const leadingPublishedDatePattern =
  /^(Today|Yesterday|\d+\s+(?:minutes?|hours?|days?|weeks?|months?|years?)\s+ago|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+\d{1,2},\s+\d{4}|(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}|\d{4}-\d{2}-\d{2})\b/i;

function extractPublishedDateAndSnippet($description: cheerio.Cheerio<AnyNode>): {
  publishedDate?: string;
  snippet: string;
} {
  const $content = $description.clone();
  $content.find(".summarize-link").remove();

  const spanDate = normalizeText($content.find(".__sri-time").first().text());
  const snippetWithoutDate = normalizeText($content.find(".__sri-time").remove().end().text());

  if (spanDate !== "") return { publishedDate: spanDate, snippet: snippetWithoutDate };

  const snippet = snippetWithoutDate;
  const leadingDate = snippet.match(leadingPublishedDatePattern)?.[0];

  return match(leadingDate)
    .with(undefined, () => ({ snippet }))
    .otherwise((publishedDate) => ({
      publishedDate,
      snippet: normalizeText(snippet.slice(publishedDate.length)),
    }));
}

function extractResult(
  $element: cheerio.Cheerio<AnyNode>,
  titleLink: cheerio.Cheerio<AnyNode>,
): SearchResult | null {
  try {
    const title = normalizeText(titleLink.text());
    const url = titleLink.attr("href");
    const { publishedDate, snippet } = extractPublishedDateAndSnippet(
      $element.find(".__sri-desc").first(),
    );

    return match({ title, url })
      .when(
        ({ title, url }) => title === "" || url === undefined || url === "",
        () => null,
      )
      .otherwise(({ title, url }) => ({
        t: 0 as const,
        url: url!,
        title,
        snippet,
        ...(publishedDate === undefined ? {} : { publishedDate }),
      }));
  } catch {
    return null;
  }
}

export const __testing = { parseSearchResults };
