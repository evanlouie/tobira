# tobira

An Effect v4 application running on Bun, with an inlined Kagi session-token client. Use the CLI for Kagi Search and Kagi Summarizer, or start the MCP stdio server for Claude and other MCP clients.

- **Search**: Fetch web results from Kagi Search
- **Summarize**: Summarize URLs with Kagi Summarizer
- **MCP mode**: Start an MCP stdio server exposing the search and summarizer tools

Unlike the official Kagi API, which requires separate API access, this project uses your existing Kagi session token.

_"Tobira"_ means _"door"_ in Japanese: a small doorway from your terminal or MCP client into Kagi search and summarization.

## Why?

The [Kagi API](https://help.kagi.com/kagi/api/overview.html) requires a separate API key, which is invite-only at the moment. If you already have a Kagi subscription but no API access, this CLI provides an alternative way to use Kagi's search and summarization features from your terminal, scripts, or MCP-compatible agents.

## Features

- **CLI-first interface** with one executable: `tobira`
- **Search command** with concurrent multi-query processing
- **Summarize command** with configurable summary type, length, and language
- **MCP server command** for Claude Desktop, Claude Code, and other MCP clients
- **Session-token auth** via environment variable or token file
- **Abortable timeouts**: 10 seconds per search query, 60 seconds per summarization
- **Input validation** and explicit invalid-token/browser-verification detection

The CLI supports two methods for using your Kagi session token, in this order:

1. `KAGI_SESSION_TOKEN` environment variable
2. `~/.kagi_session_token` file containing the token string

> [!WARNING]
> **Security Note**: Keep your session token private. It provides access to your Kagi account.

<a href="https://glama.ai/mcp/servers/@evanlouie/tobira">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@evanlouie/tobira/badge" alt="tobira MCP server" />
</a>

## Installation

Bun is required.

### 1. Get Kagi Session Token

1. Visit [Kagi Settings](https://kagi.com/settings/user_details) in your browser
2. Copy the **Session Link**
3. Extract the `token` value from the link
4. Save that value to `~/.kagi_session_token` or pass it as `KAGI_SESSION_TOKEN`

Recommended token file setup:

```bash
printf '%s' 'YOUR_SESSION_TOKEN_HERE' > ~/.kagi_session_token
chmod 600 ~/.kagi_session_token
```

### 2. Run the CLI

From GitHub with `bunx`:

```bash
bunx github:evanlouie/tobira --help
```

From a local clone:

```bash
git clone <repository-url>
cd tobira
bun install
bun src/index.ts --help
```

When installed as a package, the executable is:

```bash
tobira
```

## CLI Usage

```bash
tobira <command> [options]
```

Commands:

```text
search <query...>       Search Kagi. Accepts one or more queries.
summarize <url>         Summarize a URL using Kagi Summarizer.
mcp                     Start the MCP stdio server.
```

Global options:

```text
-h, --help              Show help.
-v, --version           Show version.
```

### Search

```bash
tobira search <query...> [--limit <number>]
```

Examples:

```bash
tobira search "time person of the year 2024"
tobira search "bun cli parser" "kagi search examples" --limit 5
```

Options:

- `--limit <number>`: Maximum number of search results per query. Default: `10`, max: `50`.

Notes:

- Accepts one to ten queries.
- Each positional argument is treated as one complete query.
- Results are numbered continuously across all queries.
- Partial failures retain successful query results and include per-query diagnostics.
- If every query fails, the CLI exits with code `1` and MCP sets `isError: true`. Valid searches with zero results still succeed.

### Summarize

```bash
tobira summarize <url> [--type <type>] [--length <length>] [--language <code>]
```

Examples:

```bash
tobira summarize https://example.com/article
tobira summarize https://example.com/article --type keypoints --language EN
tobira summarize https://example.com/article --type article --length digest --language EN
```

Options:

- `--type <type>`: `article`, `keypoints`, or `eli5`. Default: `article`.
- `--summary-type <type>`: Alias for `--type`.
- `--length <length>`: `headline`, `overview`, `digest`, `medium`, or `long`. Only supported for article summaries.
- `--language <code>`: Target language code, e.g. `EN`, `DE`, `FR`.
- `--target-language <code>`: Alias for `--language`.

### MCP Server Mode

The same executable can start the MCP stdio server:

```bash
tobira mcp
```

MCP mode exposes the same tool names as before:

- `kagi_search_fetch`
- `kagi_summarizer`

#### Claude Desktop

Add this to `claude_desktop_config.json`, which you can open from Claude Desktop via Settings → Developer → Local MCP Servers → Edit Config.

Using token file:

```json
{
  "mcpServers": {
    "tobira": {
      "command": "bunx",
      "args": ["github:evanlouie/tobira", "mcp"]
    }
  }
}
```

Using environment variable:

```json
{
  "mcpServers": {
    "tobira": {
      "command": "bunx",
      "args": ["github:evanlouie/tobira", "mcp"],
      "env": {
        "KAGI_SESSION_TOKEN": "YOUR_SESSION_TOKEN_HERE"
      }
    }
  }
}
```

If installed globally, use:

```json
{
  "mcpServers": {
    "tobira": {
      "command": "tobira",
      "args": ["mcp"]
    }
  }
}
```

[Disable Claude Desktop's built-in websearch](assets/claude-desktop-disable-websearch.png) so it uses this MCP server. You may also add this to your personal preferences/system prompt:

```text
For web searches, use the tobira MCP server's `kagi_search_fetch` tool.
For summarizing a URL, use the tobira MCP server's `kagi_summarizer` tool.
```

#### Claude Code

Using token file:

```bash
claude mcp add tobira --scope user -- bunx github:evanlouie/tobira mcp
```

Using environment variable:

```bash
claude mcp add tobira \
  --scope user \
  --env KAGI_SESSION_TOKEN="YOUR_SESSION_TOKEN_HERE" -- \
  bunx github:evanlouie/tobira mcp
```

Optional Claude Code permission settings:

```json
{
  "permissions": {
    "deny": ["WebSearch"],
    "allow": [
      "mcp__tobira__kagi_search_fetch",
      "mcp__tobira__kagi_summarizer"
    ]
  }
}
```

## MCP Tools

### `kagi_search_fetch`

Fetch web results based on one or more queries using Kagi Search. Results are numbered continuously for easy reference.

**Parameters:**

- `queries` (array of strings): One to ten non-empty search queries
- `limit` (number, optional): Maximum number of results per query. Default: `10`, max: `50`

### `kagi_summarizer`

Summarize content from URLs using the Kagi Summarizer API. Supports various document types including webpages, videos, and audio.

**Parameters:**

- `url` (string): URL to summarize
- `summary_type` (enum): `"keypoints"`, `"eli5"`, or `"article"`. Default: `"article"`
- `summary_length` (enum, optional): Only used with `"article"`; one of `"headline"`, `"overview"`, `"digest"`, `"medium"`, or `"long"`
- `target_language` (string, optional): Language code, e.g. `"EN"`. Defaults to `"EN"`.

## Development

### Architecture

`src/index.ts` runs the app with `BunRuntime.runMain`. `src/services.ts` composes the live layers:

```text
CLI / MCP → shared tool runners → Kagi → KagiHttp → Effect HttpClient
                                           └── Auth → Config / FileSystem / Path
```

| File | Responsibility |
| --- | --- |
| `src/domain.ts` | Schema codecs, optional values, summary styles, and tagged application actions |
| `src/cli/parser.ts` | Effect CLI commands, flags, aliases, and generated help |
| `src/cli/app.ts` | Action dispatch, boundary formatting, diagnostics, and exit codes |
| `src/mcp/server.ts` | Effect MCP stdio transport and Schema-derived tool definitions |
| `src/kagi/client.ts` | Injectable Kagi search and summarization service |
| `src/kagi/http.ts` | Authenticated HTTP requests, response validation, and challenge detection |
| `src/kagi/search.ts` | Cheerio HTML boundary and search-page classification |
| `src/kagi/summarize.ts` | Summary request encoding and NUL-delimited frame decoding |
| `src/tools/` | Shared runners, concurrent searches, partial results, and timeouts |
| `src/utils/` | Authentication, typed errors, formatting, and timeout composition |

Domain values use `Option` for absence. `Data.TaggedEnum` models actions, summary sources and styles, parser states and events, response dispositions, and batch completeness. Per-query outcomes use `Result` with query identity metadata. Expected failures extend `Data.TaggedError`. Schema codecs decode CLI, MCP, HTML, and summary inputs and encode outgoing request fields. Session tokens remain `Redacted` until the HTTP cookie boundary.

Summary inputs decode into typed requests before dispatch. Only the article variant can carry a length; keypoints and eli5 reject that field at the boundary. Encoding emits an explicit summary style, including the default article style.

The summary parser reduces frames through `Empty`, `Unreadable`, `Pending`, `Ready`, and `Rejected` states. Each state carries only its relevant data. Metadata preserves progress, output replaces the previous snapshot, and rejection is terminal.

Searches run with bounded `Effect.forEach` concurrency and preserve query order, including duplicate queries. The search runner returns a typed `Complete` or `Partial` batch with at least one successful query. If every query fails, it raises `AllQueriesFailed` with the individual failures. CLI and MCP format the batch only after its outcome is established.

Effect timeouts interrupt requests and run their finalizers. MCP uses the same runners, returns plain text, and marks operational failures with `isError: true`. Closing stdin shuts down the server cleanly.

### Effect reference and tooling

`effect` and `@effect/platform-bun` are pinned to `4.0.0-rc.115`. The existing `repos/effect/` Git subtree is a read-only upstream reference, not a runtime dependency. Start with `repos/effect/LLMS.md`, then inspect its examples and source. The subtree tracks an upstream `main` snapshot, so check the installed RC declarations when an API differs.

To update the reference from a clean working tree:

```bash
git subtree pull --prefix=repos/effect https://github.com/Effect-TS/effect.git main --squash
```

`bun install` runs `effect-tsgo patch --oxlint`. `.oxlintrc.json` extends Effect's recommended preset, and `tsconfig.json` enables the language-service plugin with diagnostics delegated to Oxlint. Use the workspace TypeScript version in your editor.

Type-checking and test discovery exclude `repos/`; `bun test` runs only this app's tests.

### Local Setup

```bash
git clone <repository-url>
cd tobira
bun install
```

### Run Locally

```bash
bun src/index.ts --help
bun src/index.ts search "site:bun.sh Bun runtime" --limit 3
bun src/index.ts summarize https://example.com --type keypoints
bun src/index.ts mcp
```

### Testing

```bash
bun test                 # Unit tests; live integration tests are skipped by default
bun run test:integration # Opt into live Kagi integration tests
bun run typecheck
bun run lint
```

### Debugging MCP Mode

Use the MCP Inspector to debug the MCP subcommand:

```bash
bunx @modelcontextprotocol/inspector bun ./src/index.ts mcp
```

Then access the inspector at `http://localhost:5173`. If using environment variables, add your `KAGI_SESSION_TOKEN` in the environment variables section of the inspector.

## Author

Carlo Zottmann, <carlo@zottmann.dev>, https://c.zottmann.dev, https://github.com/czottmann.

This project is neither affiliated with nor endorsed by Kagi. I'm just a very happy customer.

> [!TIP]
> I make Shortcuts-related macOS & iOS productivity apps like [Actions For Obsidian](https://actions.work/actions-for-obsidian), [Browser Actions](https://actions.work/browser-actions) (which adds Shortcuts support for several major browsers), and [BarCuts](https://actions.work/barcuts) (a surprisingly useful contextual Shortcuts launcher). Check them out!

## Related Projects

- [czottmann/kagi-ken](https://github.com/czottmann/kagi-ken) - Unofficial session token-based Kagi client, Node
- [czottmann/kagi-ken-cli](https://github.com/czottmann/kagi-ken-cli) - Unofficial Node session token-based CLI tool, Node
- [Official Kagi MCP Server](https://github.com/kagisearch/kagimcp) - Python
- [Model Context Protocol](https://modelcontextprotocol.io/)
