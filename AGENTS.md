# AGENTS.md

## Commands

```bash
bun install                  # Install dependencies and patch TypeScript/Oxlint for Effect
bun run start                # Show CLI help
bun run dev                  # Show CLI help with the Bun inspector
bun run typecheck            # Check application and test types
bun run lint                 # Type-aware Oxlint with Effect's recommended rules
bun run fmt                  # Format application and tests
bun test                     # Offline tests; live integrations skip by default
bun run test:integration      # Live Kagi tests; requires a session token
bunx @modelcontextprotocol/inspector bun src/index.ts mcp
```

## Effect conventions

This is an Effect v4 application running on Bun. `effect` and `@effect/platform-bun` are pinned to `4.0.0-rc.115`.

Read `repos/effect/LLMS.md` before changing Effect code. The existing Git subtree under `repos/effect/` is a read-only reference. Inspect its examples and source, but check the installed RC declarations when the upstream snapshot differs. Runtime imports must come from installed packages, never from `repos/`.

- Use Effect for control flow, concurrency, cancellation, and resource management. Define reusable operations with `Effect.fn` and use `Effect.gen` for inline programs.
- Define services with `Context.Service` and inject implementations through layers. Compose live services in `src/services.ts`.
- Use `Option` for absent domain values. Decode and encode external data with `Schema`. Nullable values belong only at external library or serialization boundaries.
- Use `Data.TaggedEnum` for domain variants and actions, with exhaustive `$match` dispatch. Errors extend `Data.TaggedError`, not `Data.TaggedEnum`.
- Prefer Effect's standard-library modules over native JavaScript collection, configuration, timing, and filesystem APIs. Cheerio remains the HTML parsing boundary.

JavaScript boolean logic operators (`&&`, `||`, `!`, `&&=`, and `||=`) and ternary expressions are banned in application and test code. Use Effect's `Boolean` module instead. Use `Boolean.match` for conditional values and lazy branches. `Boolean.and` and `Boolean.or` evaluate both arguments, so use `Boolean.match` when short-circuiting matters. Keep type narrowing through `Option` combinators rather than adding casts. These rules do not apply to the read-only vendored subtree.

Model domain decisions as types before writing branches. Prefer exclusive tagged variants over boolean flags, counters, or optional fields whose combinations need interpretation. Decode external values into those variants at the boundary, then use exhaustive dispatch. Use `Option` and non-empty collections for presence and cardinality. Do not replace an `if` tree with a `Boolean.match` tree without fixing the model. Reserve boolean predicates for boundary classification and low-level runtime checks.

## Architecture

The CLI and MCP adapters call shared Effect runners. No separate MCP SDK, Zod, neverthrow, or ts-pattern dependency is needed.

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Bun runtime entry point, action dispatch, exit codes, and stderr diagnostics |
| `src/domain.ts` | Schema codecs and tagged actions, summary styles, and sources |
| `src/services.ts` | Live Auth, HTTP, Kagi, and Bun layer composition |
| `src/cli/parser.ts` | Effect CLI commands, typed flags, aliases, and generated help |
| `src/mcp/server.ts` | Effect MCP stdio server and Schema-derived tool registration |
| `src/kagi/client.ts` | Injectable Kagi search and summarization service |
| `src/kagi/http.ts` | Authenticated Effect HttpClient calls and response validation |
| `src/kagi/search.ts` | Cheerio search-page parser |
| `src/kagi/summarize.ts` | Outgoing summary encoding and NUL-delimited frame parser |
| `src/tools/` | Shared runners with ordered concurrent search and timeouts |
| `src/utils/` | Authentication, error classes, formatting, and timeout composition |

## Behavior to preserve

Authentication resolves per operation, in this order:

1. A non-empty `KAGI_SESSION_TOKEN` environment value.
2. A non-empty `~/.kagi_session_token` file.

Tokens remain `Redacted` until constructing the Kagi cookie. Do not include tokens or authenticated request objects in diagnostics.

Search accepts one to ten queries and limits results to between 1 and 50 per query. `Effect.forEach` runs queries concurrently while preserving input order and partial failures. Result numbers continue across queries. Search timeouts are 10 seconds per query; summary timeouts are 60 seconds. Both interrupt the underlying HTTP request.

`SummarizerInput` is a codec from the external field union to a typed URL summary request. The article variant alone carries a length. CLI flags first encode through `SummarizerFields`, then decode through this codec before action dispatch. MCP uses the same codec. Encoding emits the explicit summary style, including the default article style.

Summary frames are snapshots, not deltas. The parser reduces frames through `Empty`, `Unreadable`, `Pending`, `Ready`, and `Rejected` states. Metadata and invalid frames preserve valid progress. New output replaces the previous snapshot. Rejection is terminal and retains the first rejection message.

MCP exposes `kagi_search_fetch` and `kagi_summarizer`. Generate its input JSON Schema from the same codecs used for validation. Return plain-text content, not JSON-quoted strings. Operational failures set `isError: true`. Keep stdout reserved for protocol messages. Stdin EOF shuts the server down cleanly.

## Tests and tooling

`bunfig.toml` limits test discovery to `tests/`. `tsconfig.json` excludes the vendored subtree. Offline tests inject ConfigProvider, FileSystem, HttpClient, Kagi, and Stdio services rather than changing global state. Use TestClock for deterministic timeout tests.

`bun install` runs `effect-tsgo patch --oxlint`. `.oxlintrc.json` extends the recommended Effect preset. The TypeScript language-service plugin delegates diagnostics to Oxlint to avoid duplicates. Use the workspace TypeScript version in the editor.
