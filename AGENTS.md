# AGENTS.md

## Commands

```bash
bun install                  # Install dependencies and patch TypeScript/Oxlint for Effect
bun run start                # Show CLI help
bun run dev                  # Show CLI help with the Bun inspector
bun run typecheck            # Check application and test types
bun run lint                 # Type-aware Effect linting for source and tests
bun run fmt                  # Format application and tests
bun test                     # Offline tests; live integrations skip by default
bun run test:integration      # Live Kagi tests; requires a session token
bunx @modelcontextprotocol/inspector bun src/index.ts mcp
```

## Coding style

These conventions apply to application and test code, not the read-only vendored copy of Effect. Effect idioms take precedence over ordinary TypeScript conventions.

### Model the domain before writing control flow

- Start with types that express the domain's valid values, states, and actions. Make invalid combinations unrepresentable rather than checking for them throughout the application.
- Use `Data.TaggedEnum` heavily for mutually exclusive variants, actions, events, and state transitions. Dispatch exhaustively with `$match` so adding a variant exposes missing handlers at compile time. When variants also need runtime validation, define them once with `Schema.TaggedUnion`, infer the type, and use that type with `Data.taggedEnum`.
- Give each variant only its relevant data. An article can carry a length; keypoints cannot. A ready summary carries output; a rejected summary carries a message, never both.
- Use `Option` for presence and absence, and non-empty collection types when cardinality matters. Avoid collections of flags, counters, and optional fields that require callers to reconstruct the state.
- Keep transformations and state reducers pure. Prefer immutable values and inferred types. Avoid `any`, non-null assertions, and casts that bypass domain constraints.

Use `Effect<A, E>` for computations and `Result<A, E>` for completed success or failure values. Do not recreate generic success/failure unions with `Data.TaggedEnum`. Reserve custom tagged variants for domain distinctions such as complete versus partial batches. Use `Effect.result` only when failures must be collected as values; keep aggregate failures in the outer Effect error channel.

### Branch on domain values, not incidental conditions

Treat `if` and `if/else` trees as a modelling smell. First identify the domain distinction, encode it as a type, and then dispatch on that value. Do not mechanically replace an `if` tree with a `Boolean.match` tree.

- Use tagged dispatch for domain variants, `Option.match` for absence, and collection matching for empty versus non-empty values.
- JavaScript boolean logic operators `&&`, `||`, `!`, `&&=`, and `||=` are banned. Use Effect's `Boolean` module instead.
- Ternary expressions are banned. Use `Boolean.match` when the decision genuinely is boolean, rather than a domain distinction waiting to be named.
- `Boolean.and` and `Boolean.or` evaluate both arguments. Preserve short-circuiting with lazy `Boolean.match` branches when evaluation performs work or requires a precondition.
- Reserve raw boolean predicates for boundary classification and low-level runtime checks. Preserve type narrowing through tagged or `Option` dispatch, not assertions. Comparisons such as `===` and `<` remain valid for classification.

### Validate and normalize at boundaries

- Decode external inputs and encode external outputs with `Schema`. Share codecs between CLI and MCP rather than duplicating validation logic.
- Convert external strings, optional fields, and defaults into domain values before dispatch. Domain operations should consume valid requests, not repeatedly interpret raw options.
- Use `Option` instead of `null` or `undefined` inside the application. Nullable values are allowed only where external libraries or wire formats require them; convert them at that boundary.
- Define expected errors with `Data.TaggedError`, never `Data.TaggedEnum`. Keep them in Effect's typed error channel and handle them with tag-based recovery. Yield error instances directly in generators.
- Keep credentials `Redacted` until the authenticated request boundary. Do not expose them in validation errors, logs, or tracing attributes.

### Use Effect as the standard library

- Prefer Effect modules over native JavaScript equivalents, including `Array`, `Boolean`, `Number`, `String`, and `Record`. Check Effect's API before adding a helper or dependency.
- Use Effect for asynchronous control flow, concurrency, cancellation, timeouts, and resource management. Keep promises and runtime execution at integration boundaries, not in domain operations.
- Define reusable effectful operations with `Effect.fn`; use `Effect.fnUntraced` where tracing adds no value and `Effect.gen` for inline programs.
- Define services with `Context.Service` and inject implementations through layers. Compose live services in `src/services.ts`. Use Effect's configuration, filesystem, path, HTTP, CLI, and MCP modules.
- Keep designs simple. Add types that express real distinctions, not wrappers around every value. htmlparser2 and css-select remain the HTML parsing boundary because Effect does not replace an HTML parser.

## Effect version and reference

This is an Effect v4 application running on Bun. `effect` and `@effect/platform-bun` are pinned to `4.0.4`. Upgrade them together, and move `repos/effect/` to the matching `effect@<version>` release tag in the same change.

Read `repos/effect/LLMS.md` before changing Effect code. `repos/effect/` is a read-only copy of the `effect@4.0.4` release tag. Inspect its examples and source. Runtime imports must come from installed packages, never from `repos/`.

## Architecture

The CLI and MCP adapters call shared Effect runners. No separate MCP SDK, Zod, neverthrow, or ts-pattern dependency is needed.

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Bun runtime entry point and process exit code |
| `src/domain.ts` | Schema codecs and tagged actions, summary styles, and sources |
| `src/services.ts` | Live Auth, HTTP, Kagi, and Bun layer composition |
| `src/cli/parser.ts` | Effect CLI commands, typed flags, aliases, and generated help |
| `src/cli/app.ts` | Action dispatch, boundary formatting, stderr diagnostics, and exit codes as values |
| `src/mcp/server.ts` | Effect MCP stdio server and Schema-derived tool registration |
| `src/kagi/client.ts` | Injectable Kagi search and summarization service |
| `src/kagi/http.ts` | Authenticated Effect HttpClient calls and response validation |
| `src/kagi/search.ts` | htmlparser2 and css-select search-page parser |
| `src/kagi/summarize.ts` | Outgoing summary encoding and NUL-delimited frame parser |
| `src/tools/` | Shared runners with ordered concurrent search and timeouts |
| `src/utils/` | Authentication, error classes, formatting, and timeout composition |

## Behavior to preserve

Authentication resolves per operation, in this order:

1. A non-empty `KAGI_SESSION_TOKEN` environment value.
2. A non-empty `~/.kagi_session_token` file.

Tokens remain `Redacted` until constructing the Kagi cookie. Do not include tokens or authenticated request objects in diagnostics.

Search accepts one to ten queries and limits results to between 1 and 50 per query. `SearchInput` preserves the non-empty query constraint in its TypeScript type. `Effect.forEach` runs queries concurrently while preserving input order and partial failures. Result numbers continue across queries. Search timeouts are 10 seconds per query; summary timeouts are 60 seconds. Both interrupt the underlying HTTP request. `KagiHttp.text` uses `HttpClient.withScope` and a per-call `Effect.scoped` boundary so early status or challenge failures release unread responses. The scope must include body consumption, not only request execution.

`runSearch` returns a typed `SearchBatch.Complete` or `SearchBatch.Partial`, each with at least one successful query. A valid response with zero results is a successful query. If every query fails, `AllQueriesFailed` carries a non-empty list of indexed query failures in the error channel. Authentication failures remain separate errors. Each query outcome pairs its index and query text with `Result<SearchResponse, AppError>`. `Effect.result` captures typed failures for aggregation; defects and interruption are not converted into query outcomes.

CLI and MCP format batches only after the outcome is established. All-failed batches produce CLI exit code 1 with stderr diagnostics and MCP `isError: true`. Partial batches remain successful and retain their per-query diagnostics. Preserve query indices so duplicate queries retain their positions.

`SummarizerInput` is a codec from the external field union to a typed URL summary request. The article variant alone carries a length. CLI flags first encode through `SummarizerFields`, then decode through this codec before action dispatch. MCP uses the same codec. Encoding emits the explicit summary style, including the default article style.

Summary frames are snapshots, not deltas. The parser reduces frames through `Empty`, `Unreadable`, `Pending`, `Ready`, and `Rejected` states. Metadata and invalid frames preserve valid progress. New output replaces the previous snapshot. Rejection is terminal and retains the first rejection message.

MCP exposes `kagi_search_fetch` and `kagi_summarizer`. Generate its input JSON Schema from the same codecs used for validation. Return plain-text content, not JSON-quoted strings. Operational failures set `isError: true`. Keep stdout reserved for protocol messages. Stdin EOF shuts the server down cleanly.

## Tests and tooling

`bunfig.toml` limits test discovery to `tests/`. `tsconfig.json` excludes `repos/`. Offline tests inject ConfigProvider, FileSystem, HttpClient, Kagi, and Stdio services rather than changing global state. Use TestClock for deterministic timeout tests. Use `Stream.toQueue` for the MCP test reply decoder so decode failures and stream completion reach the consumer instead of becoming timeouts.

`bun install` runs `effect-tsgo patch --oxlint`. The patch fails on Oxlint versions that the installed `@effect/tsgo` does not support, so `oxlint` is pinned to an exact version. Raise the pin only after a `@effect/tsgo` release supports the newer Oxlint. `.oxlintrc.json` extends the recommended Effect preset for both source and tests. Test files disable only `effecttsgo/async-function` and `effecttsgo/schema-sync` to allow Bun test callbacks and direct synchronous schema assertions. `effecttsgo/schema-sync-in-effect` remains enabled; use effectful decoders inside generators. The TypeScript language-service plugin delegates diagnostics to Oxlint to avoid duplicates. Use the workspace TypeScript version in the editor.
