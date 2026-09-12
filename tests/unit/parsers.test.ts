import { describe, expect, test } from "bun:test";
import { Array, Effect, Option, Schema } from "effect";
import {
  SearchInput,
  SearchResult,
  SummarizerInput,
  SummarySource,
  SummaryStyle,
} from "../../src/domain.ts";
import { parseSearchResults } from "../../src/kagi/search.ts";
import {
  parseStreamingSummary,
  reduceFrame,
  SummaryFrame,
  SummaryState,
} from "../../src/kagi/summarize.ts";
import { formatSearchResults } from "../../src/utils/formatting.ts";

const resultHtml = (name: string, description = `Snippet ${name}`) => `
  <div class="search-result">
    <a class="__sri_title_link" href="https://example.com/${name}">Example ${name}</a>
    <div class="__sri-desc">${description}</div>
  </div>`;
const parse = (html: string, limit = 10) =>
  Effect.runSync(parseSearchResults(`<html><body>${html}</body></html>`, limit));
const summary = (data: string) => Effect.runSync(parseStreamingSummary(data));

describe("search parser", () => {
  test("parses organic results and applies the limit", () => {
    expect(parse(resultHtml("a") + resultHtml("b"), 1)).toEqual([
      {
        title: "Example a",
        url: "https://example.com/a",
        snippet: "Snippet a",
        publishedDate: Option.none(),
      },
    ]);
  });

  test.each([
    ["", Option.none<string>()],
    ['<span class="__sri-time --new">Today</span>', Option.some("Today")],
    ["Apr 22, 2026", Option.some("Apr 22, 2026")],
    ["2026-04-22", Option.some("2026-04-22")],
  ])("extracts dates and removes summarize links: %s", (dateHtml, publishedDate) => {
    const results = parse(
      resultHtml(
        "a",
        `${dateHtml} Learn to Summarize <a class="summarize-link" href="/summarizer">Summarize</a>`,
      ),
    );
    expect(results).toEqual([
      {
        title: "Example a",
        url: "https://example.com/a",
        snippet: "Learn to Summarize",
        publishedDate,
      },
    ]);
  });

  test("fills the remaining limit with grouped results", () => {
    const results = parse(
      resultHtml("a") +
        `
      <div class="sr-group">
        <div class="__srgi"><div class="__srgi-title"><a href="https://example.com/b">Example b</a></div><div class="__sri-desc">Snippet b</div></div>
        <div class="__srgi"><div class="__srgi-title"><a href="https://example.com/c">Example c</a></div></div>
      </div>`,
      2,
    );
    expect(Array.map(results, ({ title }) => title)).toEqual(["Example a", "Example b"]);
  });

  test("skips malformed results without consuming the limit", () => {
    expect(
      parse(
        '<div class="search-result"><a class="__sri_title_link">Missing URL</a></div>' +
          resultHtml("a"),
        1,
      ),
    ).toHaveLength(1);
  });

  test("distinguishes no results from an unrecognized page", () => {
    expect(parse("No results found for this search.")).toEqual([]);
    expect(
      Effect.runSync(Effect.flip(parseSearchResults("<html><body>login shell</body></html>", 10))),
    ).toMatchObject({ _tag: "ParseError" });
  });

  test("formats dates, missing dates, and continuous result numbers", () => {
    const text = formatSearchResults(
      ["empty", "first", "second", "missing"],
      [
        { data: [] },
        { data: parse(resultHtml("a", '<span class="__sri-time">Today</span> First')) },
        { data: parse(resultHtml("b")) },
      ],
    );
    expect(text).toContain("Published Date: Today");
    expect(text).toContain("Published Date: Not Available");
    expect(text).toContain("1: Example a");
    expect(text).toContain("2: Example b");
    expect(text).toContain('Results for search query "missing"');
  });
});

describe("summary frame parser", () => {
  test.each([
    [
      'new_message.json:{"state":"generating"}\u0000final:{"output_data":{"markdown":"Summary"}}',
      "Summary",
    ],
    [
      '{"md":"Draft"}\u0000{"output_data":{"markdown":"Final summary"}}\u0000{"state":"done"}',
      "Final summary",
    ],
    ['{"md":"Markdown summary"}', "Markdown summary"],
    ['broken\u0000{"md":"Valid"}\u0000{"md":12}', "Valid"],
  ])("uses the latest valid snapshot: %s", (input, output) => {
    expect(summary(input)).toEqual({ output });
  });

  test.each([
    ["\u0000", "ParseError", "No summary data received"],
    ["not json", "ParseError", "Failed to parse summary response"],
    ['{"state":"done"}', "ParseError", "Empty summary received"],
    [
      '{"md":"Draft"}\u0000{"state":"error","reply":"Could not summarize"}',
      "HttpError",
      "Could not summarize",
    ],
    ["<!doctype html><html></html>", "ParseError", "Unexpected HTML response from Kagi summarizer"],
  ])("rejects invalid responses: %s", (input, tag, message) => {
    expect(Effect.runSync(Effect.flip(parseStreamingSummary(input)))).toMatchObject({
      _tag: tag,
      message,
    });
  });
});

describe("summary state transitions", () => {
  test("distinguishes absent, unreadable, and pending content", () => {
    const unreadable = reduceFrame(SummaryState.Empty(), SummaryFrame.Invalid());
    expect(unreadable).toEqual(SummaryState.Unreadable());
    expect(reduceFrame(unreadable, SummaryFrame.Metadata())).toEqual(SummaryState.Pending());
    expect(reduceFrame(SummaryState.Pending(), SummaryFrame.Invalid())).toEqual(
      SummaryState.Pending(),
    );
  });

  test("keeps the latest snapshot and makes rejection terminal", () => {
    const draft = reduceFrame(SummaryState.Pending(), SummaryFrame.Output({ text: "Draft" }));
    const ready = reduceFrame(draft, SummaryFrame.Output({ text: "Final" }));
    expect(ready).toEqual(SummaryState.Ready({ output: "Final" }));
    expect(reduceFrame(ready, SummaryFrame.Metadata())).toEqual(ready);
    expect(reduceFrame(ready, SummaryFrame.Invalid())).toEqual(ready);
    const rejected = reduceFrame(ready, SummaryFrame.Rejected({ message: "Denied" }));
    expect(rejected).toEqual(SummaryState.Rejected({ message: "Denied" }));
    expect(reduceFrame(rejected, SummaryFrame.Output({ text: "Too late" }))).toEqual(rejected);
    expect(reduceFrame(rejected, SummaryFrame.Rejected({ message: "Another error" }))).toEqual(
      rejected,
    );
  });
});

describe("boundary schemas", () => {
  test.each(["keypoints", "eli5"] as const)(
    "rejects article length on %s at the boundary",
    (summary_type) => {
      const wire = { url: "https://example.com", summary_type, target_language: "EN" } as const;
      const decoded = Schema.decodeSync(SummarizerInput)(wire);
      expect(Schema.encodeSync(SummarizerInput)(decoded)).toEqual(wire);
      expect(
        Option.isNone(
          Schema.decodeUnknownOption(SummarizerInput)({ ...wire, summary_length: "digest" }),
        ),
      ).toBe(true);
    },
  );

  test("trims queries and represents missing fields as Option", () => {
    const input = Schema.decodeSync(SearchInput)({ queries: ["  kagi search  "] });
    expect(input).toEqual({ queries: ["kagi search"], limit: Option.none() });
    expect(Schema.encodeSync(SearchInput)(input)).toEqual({ queries: ["kagi search"] });
    expect(
      Schema.encodeSync(SearchResult)({
        title: "Example",
        url: "https://example.com",
        snippet: "",
        publishedDate: Option.none(),
      }),
    ).toEqual({ title: "Example", url: "https://example.com", snippet: "" });
  });

  test.each([
    { queries: ["   "] },
    { queries: [] },
    { queries: Array.makeBy(11, (i) => `q${i}`) },
    { queries: ["ok"], limit: 51 },
    { queries: ["ok"], limit: 1.5 },
    { queries: [123] },
    { queries: ["ok"], limit: null },
  ])("rejects invalid search input: %j", (input) => {
    expect(Option.isNone(Schema.decodeUnknownOption(SearchInput)(input))).toBe(true);
  });

  test("decodes defaults into an article request and encodes canonical wire fields", () => {
    const input = Schema.decodeSync(SummarizerInput)({
      url: "https://example.com",
      summary_length: "digest",
    });
    expect(input).toEqual({
      source: SummarySource.Url({ input: "https://example.com" }),
      style: SummaryStyle.Article({ length: Option.some("digest") }),
      language: Option.none(),
    });
    expect(Schema.encodeSync(SummarizerInput)(input)).toEqual({
      url: "https://example.com",
      summary_type: "article",
      summary_length: "digest",
    });
    expect(
      Option.isNone(
        Schema.decodeUnknownOption(SummarizerInput)({
          url: "https://example.com",
          summary_type: "eli5",
          summary_length: "digest",
        }),
      ),
    ).toBe(true);
    expect(Option.isNone(Schema.decodeOption(SummarizerInput)({ url: "not a URL" }))).toBe(true);
  });
});
