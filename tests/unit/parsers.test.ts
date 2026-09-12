import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { search, __testing as searchTesting } from "../../src/kagi/search.ts";
import { summarize, __testing as summarizeTesting } from "../../src/kagi/summarize.ts";
import { searchInputSchema } from "../../src/tools/search.ts";
import { formatSearchResults } from "../../src/utils/formatting.ts";

const searchSchema = z.object(searchInputSchema);

describe("search parser", () => {
  test("parses organic search results", () => {
    const results = searchTesting.parseSearchResults(
      `<html><body>
        <div class="search-result">
          <a class="__sri_title_link" href="https://example.com/a">Example A</a>
          <div class="__sri-desc">Snippet A</div>
        </div>
        <div class="search-result">
          <a class="__sri_title_link" href="https://example.com/b">Example B</a>
          <div class="__sri-desc">Snippet B</div>
        </div>
      </body></html>`,
      1,
    );

    expect(results.isOk()).toBe(true);
    expect(results._unsafeUnwrap()).toEqual([
      { t: 0, url: "https://example.com/a", title: "Example A", snippet: "Snippet A" },
    ]);
  });

  test.each([
    { dateHtml: "", publishedDate: undefined },
    { dateHtml: '<span class="__sri-time --new">Today</span>', publishedDate: "Today" },
    { dateHtml: "Apr 22, 2026", publishedDate: "Apr 22, 2026" },
  ])(
    "excludes summarize links with date metadata $publishedDate",
    ({ dateHtml, publishedDate }) => {
      const results = searchTesting.parseSearchResults(
        `<html><body>
        <div class="search-result">
          <a class="__sri_title_link" href="https://example.com">Example</a>
          <div class="__sri-desc"><div>
            ${dateHtml} Learn to Summarize
            <a class="_0_summarize_page summarize-link" href="/summarizer?url=https%3A//example.com/">Summarize</a>
          </div></div>
        </div>
      </body></html>`,
        10,
      );

      expect(results._unsafeUnwrap()).toEqual([
        {
          t: 0,
          url: "https://example.com",
          title: "Example",
          snippet: "Learn to Summarize",
          ...(publishedDate === undefined ? {} : { publishedDate }),
        },
      ]);
    },
  );

  test("extracts published dates from Kagi result metadata", () => {
    const results = searchTesting.parseSearchResults(
      `<html><body>
        <div class="search-result">
          <a class="__sri_title_link" href="https://example.com/a">Example A</a>
          <div class="__sri-desc">
            <span class="__sri-time --new">Today</span>
            Snippet A
          </div>
        </div>
        <div class="search-result">
          <a class="__sri_title_link" href="https://example.com/b">Example B</a>
          <div class="__sri-desc">Apr 22, 2026 Snippet B</div>
        </div>
      </body></html>`,
      2,
    );

    expect(results.isOk()).toBe(true);
    expect(results._unsafeUnwrap()).toEqual([
      {
        t: 0,
        url: "https://example.com/a",
        title: "Example A",
        snippet: "Snippet A",
        publishedDate: "Today",
      },
      {
        t: 0,
        url: "https://example.com/b",
        title: "Example B",
        snippet: "Snippet B",
        publishedDate: "Apr 22, 2026",
      },
    ]);
  });

  test("formats search results with published dates", () => {
    expect(
      formatSearchResults(["example"], [
        {
          data: [
            {
              t: 0,
              url: "https://example.com/a",
              title: "Example A",
              snippet: "Snippet A",
              publishedDate: "Today",
            },
          ],
        },
      ]),
    ).toContain("Published Date: Today");
  });

  test("parses valid no-results pages as empty results", () => {
    const results = searchTesting.parseSearchResults(
      "<html><body>No results found for this search.</body></html>",
      10,
    );

    expect(results.isOk()).toBe(true);
    expect(results._unsafeUnwrap()).toEqual([]);
  });

  test("fills remaining search limit from grouped results", () => {
    const results = searchTesting.parseSearchResults(
      `<html><body>
        <div class="search-result">
          <a class="__sri_title_link" href="https://example.com/a">Example A</a>
          <div class="__sri-desc">Snippet A</div>
        </div>
        <div class="sr-group">
          <div class="__srgi">
            <div class="__srgi-title"><a href="https://example.com/b">Example B</a></div>
            <div class="__sri-desc">Snippet B</div>
          </div>
          <div class="__srgi">
            <div class="__srgi-title"><a href="https://example.com/c">Example C</a></div>
            <div class="__sri-desc">Snippet C</div>
          </div>
        </div>
      </body></html>`,
      2,
    );

    expect(results.isOk()).toBe(true);
    expect(results._unsafeUnwrap()).toEqual([
      { t: 0, url: "https://example.com/a", title: "Example A", snippet: "Snippet A" },
      { t: 0, url: "https://example.com/b", title: "Example B", snippet: "Snippet B" },
    ]);
  });

  test("returns ParseError on unexpected HTML", () => {
    const result = searchTesting.parseSearchResults("<html><body>login shell</body></html>", 10);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: "ParseError",
      message: "Failed to parse search results - unexpected HTML structure",
    });
  });

  test("enforces direct search limit bounds before fetching", async () => {
    const result = await search("test", "token", 51);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: "ValidationError",
      message: "Limit must be an integer between 1 and 50",
    });
  });

  test("rejects non-string search input before fetching", async () => {
    const queryResult = await search(123 as unknown as string, "token", 1);
    expect(queryResult.isErr()).toBe(true);
    expect(queryResult._unsafeUnwrapErr()).toMatchObject({
      type: "ValidationError",
      message: "Search query is required and must be a string",
    });

    const tokenResult = await search("test", 123 as unknown as string, 1);
    expect(tokenResult.isErr()).toBe(true);
    expect(tokenResult._unsafeUnwrapErr()).toMatchObject({
      type: "ValidationError",
      message: "Session token is required and must be a string",
    });
  });
});

describe("summarizer validation", () => {
  test("rejects non-string summarizer input before fetching", async () => {
    const inputResult = await summarize(123 as unknown as string, "token");
    expect(inputResult.isErr()).toBe(true);
    expect(inputResult._unsafeUnwrapErr()).toMatchObject({
      type: "ValidationError",
      message: "Input is required and must be a string",
    });

    const tokenResult = await summarize("input", 123 as unknown as string);
    expect(tokenResult.isErr()).toBe(true);
    expect(tokenResult._unsafeUnwrapErr()).toMatchObject({
      type: "ValidationError",
      message: "Session token is required and must be a string",
    });
  });
});

describe("summarizer stream parser", () => {
  test("parses final output_data markdown", () => {
    const result = summarizeTesting.parseStreamingSummary(
      'new_message.json:{"state":"generating"}\u0000final:{"output_data":{"markdown":"Summary"}}',
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ output: "Summary" });
  });

  test("uses latest summary frame even with trailing metadata", () => {
    const result = summarizeTesting.parseStreamingSummary(
      '{"md":"Draft"}\u0000{"output_data":{"markdown":"Final summary"}}\u0000{"state":"done"}',
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ output: "Final summary" });
  });

  test("parses md field", () => {
    const result = summarizeTesting.parseStreamingSummary('{"md":"Markdown summary"}');

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ output: "Markdown summary" });
  });

  test("returns Kagi error frames as HttpError", () => {
    const result = summarizeTesting.parseStreamingSummary(
      '{"state":"error","reply":"Could not summarize"}',
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: "HttpError",
      message: "Could not summarize",
    });
  });

  test("returns ParseError on empty stream", () => {
    const result = summarizeTesting.parseStreamingSummary("\u0000");
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: "ParseError",
      message: "No summary data received",
    });
  });
});

describe("search input schema", () => {
  test("trims and accepts non-empty queries", () => {
    const result = searchSchema.parse({ queries: ["  kagi search  "], limit: 1 });
    expect(result.queries).toEqual(["kagi search"]);
  });

  test("rejects whitespace-only and excessive query arrays", () => {
    expect(searchSchema.safeParse({ queries: ["   "] }).success).toBe(false);
    expect(searchSchema.safeParse({ queries: Array.from({ length: 11 }, (_, i) => `q${i}`) }).success).toBe(
      false,
    );
    expect(searchSchema.safeParse({ queries: ["ok"], limit: 51 }).success).toBe(false);
  });
});
