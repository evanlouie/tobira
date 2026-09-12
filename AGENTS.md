# AGENTS.md

This file provides guidance to LLM agents when working with code in this repository.

## Common Commands

### Development

```bash
bun install        # Install dependencies
bun run start      # Show CLI help
bun run dev        # Show CLI help with Bun inspector
bun run typecheck  # Type-check with tsc
bun run lint       # Lint with oxlint
bun run fmt        # Format with oxfmt
```

### Testing & Debugging

```bash
bun test                                                  # Run unit tests; live integrations skip by default
bun run test:integration                                  # Run live Kagi integration tests with KAGI_INTEGRATION=1
bunx @modelcontextprotocol/inspector bun src/index.ts mcp # Launch MCP Inspector at localhost:5173
```

## Architecture Overview

This is a **CLI-first Kagi session-token client** with an optional Model Context Protocol (MCP) server mode. The CLI exposes direct search/summarize commands and can start an MCP stdio server for Claude Desktop/Code. It uses session tokens (not API keys) with an inlined Kagi client under `src/kagi/`. Use Bun as the runtime.

### Core Architecture Pattern

**CLI Structure**: The main entry point (`src/index.ts`) parses CLI commands. The `mcp` command starts the MCP server from `src/mcp/server.ts`, which uses the `@modelcontextprotocol/sdk` and stdio transport.

**Tool-Based Architecture**: Each capability has a shared plain-text runner plus an MCP wrapper:

- `runSearch` / `kagi_search_fetch` - Multi-query concurrent search
- `runSummarizer` / `kagi_summarizer` - URL summarization

**Token Resolution System**: Authentication follows the same pattern as `kagi-ken-cli` with priority-based token resolution:

1. `KAGI_SESSION_TOKEN` environment variable
2. `~/.kagi_session_token` file

### Key Components

**`src/index.ts`** - CLI entry point that:

- Parses `search`, `summarize`, and `mcp` commands
- Dispatches to shared tool runners
- Prints CLI output/errors and sets exit codes

**`src/tools/`** - Shared tool implementations:

- Each tool exports a plain-text runner for the CLI, an MCP handler wrapper, and a config object
- MCP handlers return MCP-compliant response format with `content` array
- Input validation uses direct Zod schema objects (not `z.object()`) for MCP input schemas

**`src/kagi/`** - Inlined Kagi HTTP client:

- `http.ts` - Request handling, response validation, auth/challenge detection
- `search.ts` - Search client and HTML parser
- `summarize.ts` - Summarizer client and streaming response parser

**`src/utils/auth.ts`** - Token resolution that mirrors `kagi-ken-cli`:

- `resolveToken()` - Priority-based token resolution
- `readTokenFromFile()` - File-based token reading
- Comprehensive error messages for missing tokens

**`src/utils/formatting.ts`** - Result formatting:

- `formatSearchResults()` - Matches official Kagi MCP output format
- Results with `t === 1` (related searches) are filtered out; only `t === 0` (actual results) are included

### Critical Implementation Details

**MCP Schema Format**: Input schemas must be plain objects with Zod validators as values, NOT `z.object()` wrappers:

```js
// Correct
export const schema = {
  queries: z.array(z.string()).min(1),
};

// Incorrect
export const schema = z.object({
  queries: z.array(z.string()).min(1),
});
```

**Concurrent Search Processing**: Search tool runs multiple queries concurrently with individual timeouts, maintaining result order and partial success handling.

**Result Formatting Compatibility**: Output format precisely matches the official Python Kagi MCP server to ensure tool interface compatibility across implementations.

## Dependencies

- Use Bun as the runtime
- ES modules (`"type": "module"` in `package.json`)
- `@modelcontextprotocol/sdk` - MCP server implementation
- `cheerio` - Kagi search HTML parsing
- `neverthrow` - Typed result/error flow
- `zod` - Input validation schemas

## Configuration

Requires Kagi session token via environment variable or file. The CLI and MCP mode automatically detect the token source and provide clear error messages for setup issues.
