import { compile, selectAll, selectOne } from "css-select";
import { type AnyNode, type Document, type Element, hasChildren, isText } from "domhandler";
import { Array, Data, Effect, Filter, Match, Option, Schema, String } from "effect";
import { DomUtils, parseDocument } from "htmlparser2";
import { SearchResult } from "../domain.ts";
import { ParseError } from "../utils/errors.ts";

export type { SearchResult, SearchResponse } from "../domain.ts";

type SearchPage = Data.TaggedEnum<{
  Results: { readonly data: ReadonlyArray<SearchResult> };
  NoResults: {};
  Unexpected: {};
}>;
const SearchPage = Data.taggedEnum<SearchPage>();
const normalizeText = (value: string): string => String.trim(String.replace(/\s+/g, " ")(value));
const nonEmpty = Schema.decodeUnknownOption(Schema.NonEmptyString);

// css-select queries the descendants of the root. Absence becomes Option at this HTML boundary.
const selectElements = (query: string, root: AnyNode): ReadonlyArray<Element> =>
  selectAll<AnyNode, Element>(query, root);
const selectFirst =
  (query: string) =>
  (root: AnyNode): Option.Option<Element> =>
    Option.fromNullishOr(selectOne<AnyNode, Element>(query, root));

const isSnippetMetadata = compile<AnyNode, Element>(".summarize-link, .__sri-time");

/** Text content without the summarize links and date badges that Kagi renders in snippets. */
const snippetText: (node: AnyNode) => string = Match.type<AnyNode>().pipe(
  Match.when(isSnippetMetadata, () => ""),
  Match.when(isText, ({ data }) => data),
  Match.when(hasChildren, ({ children }) => Array.join(Array.map(children, snippetText), "")),
  Match.orElse(() => ""),
);

/** htmlparser2 adds no implicit body, so markup without one falls back to the whole document. */
const pageText = (document: Document): string =>
  selectFirst("body")(document).pipe(
    Option.map(DomUtils.textContent),
    Option.getOrElse(() => DomUtils.textContent(document)),
  );

function classifySearchPage(document: Document, limit: number): SearchPage {
  return Array.match(selectElements(".search-result, .sr-group .__srgi", document), {
    onNonEmpty: () =>
      SearchPage.Results({
        data: Array.take(
          Array.appendAll(
            extractResults(document, ".search-result", ".__sri_title_link"),
            extractResults(document, ".sr-group .__srgi", ".__srgi-title a"),
          ),
          limit,
        ),
      }),
    onEmpty: () =>
      Array.findFirst(["no results", "couldn't find any results", "did not match any"], (marker) =>
        String.includes(marker)(String.toLowerCase(normalizeText(pageText(document)))),
      ).pipe(
        Option.match({
          onSome: () => SearchPage.NoResults(),
          onNone: () => SearchPage.Unexpected(),
        }),
      ),
  });
}

const leadingPublishedDatePattern =
  /^(Today|Yesterday|\d+\s+(?:minutes?|hours?|days?|weeks?|months?|years?)\s+ago|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+\d{1,2},\s+\d{4}|(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}|\d{4}-\d{2}-\d{2})\b/i;

type DateSource = Data.TaggedEnum<{
  Metadata: { readonly date: string };
  SnippetPrefix: { readonly date: string };
  Missing: {};
}>;
const DateSource = Data.taggedEnum<DateSource>();

function extractPublishedDateAndSnippet(description: Option.Option<Element>) {
  const spanDate = description.pipe(
    Option.flatMap(selectFirst(".__sri-time")),
    Option.map((time) => normalizeText(DomUtils.textContent(time))),
    Option.flatMap(nonEmpty),
  );
  const snippet = description.pipe(
    Option.map((content) => normalizeText(snippetText(content))),
    Option.getOrElse(() => ""),
  );
  const source = spanDate.pipe(
    Option.map((date) => DateSource.Metadata({ date })),
    Option.orElse(() =>
      String.match(leadingPublishedDatePattern)(snippet).pipe(
        Option.flatMap(Array.head),
        Option.map((date) => DateSource.SnippetPrefix({ date })),
      ),
    ),
    Option.getOrElse(() => DateSource.Missing()),
  );
  return DateSource.$match(source, {
    Metadata: ({ date }) => ({ publishedDate: Option.some(date), snippet }),
    SnippetPrefix: ({ date }) => ({
      publishedDate: Option.some(date),
      snippet: normalizeText(String.slice(date.length)(snippet)),
    }),
    Missing: () => ({ publishedDate: Option.none<string>(), snippet }),
  });
}

function extractResult(element: Element, titles: string): Option.Option<SearchResult> {
  const { publishedDate, snippet } = extractPublishedDateAndSnippet(
    selectFirst(".__sri-desc")(element),
  );
  // Missing attributes are decoded at the HTML boundary, not propagated into the domain.
  return selectFirst(titles)(element).pipe(
    Option.flatMap((titleLink) =>
      Schema.decodeUnknownOption(SearchResult)({
        title: normalizeText(DomUtils.textContent(titleLink)),
        url: DomUtils.getAttributeValue(titleLink, "href"),
        snippet,
        publishedDate: Option.getOrUndefined(publishedDate),
      }),
    ),
  );
}

function extractResults(document: Document, items: string, titles: string) {
  return Array.filterMap(
    selectElements(items, document),
    Filter.fromPredicateOption((element: Element) => extractResult(element, titles)),
  );
}

export const parseSearchResults = Effect.fn("parseSearchResults")(function* (
  html: string,
  limit: number,
) {
  const document = yield* Effect.try({
    try: () => parseDocument(html),
    catch: () =>
      new ParseError({
        message: "Failed to parse search results - unexpected HTML structure",
      }),
  });
  return yield* SearchPage.$match(classifySearchPage(document, limit), {
    NoResults: () => Effect.succeed<ReadonlyArray<SearchResult>>([]),
    Unexpected: () =>
      Effect.fail(
        new ParseError({
          message: "Failed to parse search results - unexpected HTML structure",
        }),
      ),
    Results: ({ data }) => Effect.succeed(data),
  });
});
