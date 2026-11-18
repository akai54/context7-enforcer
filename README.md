# context7-enforcer

A Claude Code mod that makes Claude read current library documentation before it
works, without being asked. It calls the Context7 MCP server you already have
(`plugin:context7:context7`; `claude.ai Context7` as fallback) through `$.mcp.call`.
It does **not** declare, install or start any MCP server.

## What it does

1. **`prompt.submit`** – skips git, navigation, simple text edits and prompts that
   name no library. Otherwise it detects libraries from the prompt (known framework
   names, dependencies named in the prompt, `import`/`npm i`/`pip install` lines) and
   pins their versions from `package.json`, `requirements.txt`, `pyproject.toml`,
   `go.mod`, `Cargo.toml`, `composer.json` and `Gemfile` in the session directory.
2. For each library (up to `maxLibraries`, in parallel) it runs `resolve-library-id`,
   accepts only a result whose title/ID matches the library, maps the project version
   onto a version Context7 really lists (`/org/project/vX`, else the base ID), then runs
   `query-docs` with a task-specific query. The documentation is added to the model's
   context as a `<context7-enforcer>` block.
3. **`agent.spawn`** – a subagent's prompt gets the task's documentation (and docs for
   libraries only its own prompt names). Forks and resumed agents are left alone.
4. **Strict mode** – `Edit`/`Write`/`NotebookEdit` on code files are denied while a
   detected library's documentation is missing (server down, rate limit, timeout,
   failed query). The deny text tells the model to call Context7's `resolve-library-id`
   and `query-docs` itself; a successful call by the model (or a subagent) unlocks
   the edit. Libraries Context7 does not know (`unsupported`) never block.
5. **Tracking** – per task: library, requested/resolved version, status
   (`ok`, `cached`, `model`, `waived`, `unsupported`, `mcp_unavailable`, `rate_limited`,
   `timeout`, `failed`, `skipped`), documentation source and error. The last 20 tasks
   are kept in `$.store` (no prompt text, only its length).
6. **Status line** – `ctx7[adv] Next.js@v14.2.35✓ · Prisma@v6.1.0✓ · zod✗ rate_limited`.
   A toast appears when a library's docs could not be fetched.

## Install

The mod lives in a Claude Code mods folder. For a one-off session:

```bash
claude --plugin-dir /path/to/context7-enforcer
```

To keep it, publish it from the session that built it, or copy the folder into a
plugin marketplace repository (`.claude-plugin/marketplace.json`) and run
`/plugin install context7-enforcer --marketplace <owner>/<repo>`.

Requirements: the Context7 MCP server must already be listed by `/mcp`.

## Configure

Fields appear in `/config` (as plugin options) or in `settings.json` under
`pluginConfigs["context7-enforcer"].options`.

| Option | Default | Meaning |
| --- | --- | --- |
| `mode` | `advisory` | `advisory` injects docs; `strict` also blocks code edits until docs exist; `disabled` does nothing |
| `server` | `plugin:context7:context7` | server name exactly as `/mcp` lists it |
| `fallbackServer` | `claude.ai Context7` | existing server tried when the first is unreachable; empty disables |
| `cacheTtlHours` | `24` | reuse of successful lookups; `0` disables the cache |
| `maxLibraries` | `3` | libraries per task (1-8); the rest are recorded as `skipped` |
| `timeoutMs` | `15000` | per MCP call; a slow server cannot stall the prompt |
| `maxDocChars` | `16000` | documentation budget per task, split across libraries |
| `cooldownSec` | `60` | after a rate limit, lookups pause this long (an unreachable server: at most 10 s) |

Command: `/context7` shows mode, servers, cache size, the current task and recent
tasks. `/context7 bypass` waives strict mode for the current task (the escape hatch
when Context7 is down). `/context7 clear-cache` empties the cache.

## Privacy

The query sent to Context7 is the library name plus the prompt with fenced code,
inline backticks, URLs, e-mail addresses and token-like strings removed, cut to 300
characters. Prompt text itself is never stored; only library names and outcomes.

## Tests and validation

```bash
claude plugin validate /path/to/context7-enforcer
claude plugin test /path/to/context7-enforcer
```

`tests/` covers documentation-dependent tasks, tasks needing no Context7, a missing
or failing MCP connection, rate limits and timeouts, unsupported libraries, strict
mode, several libraries, the cache and subagents. The engine is simulated by the
test kit; no real Context7 call is made.

## Limitations

- **Detection is heuristic.** It needs the prompt to name a library (or a dependency
  from a manifest, or an import). A request such as "add authentication" that never
  names the library you use is not looked up; hand-add the library name or ask Claude
  to call Context7. Very short or common-word dependency names (`next`, `zod`, `rich`)
  count only via known aliases (`Next.js`, `Zod`) or backticks.
- **Only the session's working directory** is read for manifests, not sub-packages of
  a monorepo; lockfiles are not read (the manifest range's first version is used).
- **`resolve-library-id` is parsed from text.** If Context7 changes that format, libraries
  show as `unsupported` and nothing is injected (never a guessed ID). The version
  mapping falls back from exact to same minor to same major to the base ID, and the
  injected header says which one applied.
- **Strict mode guards the `Edit`, `Write` and `NotebookEdit` tools on code files.**
  It does not stop edits made through `Bash` (`sed -i`, redirects) or other tools, and
  a library the prompt never named is never required. It is a guardrail, not a sandbox.
- **Startup race.** MCP servers connect in the background; a prompt sent in the first
  seconds of a session (or the only prompt of `claude -p`) can find Context7 not yet
  connected. The lookup then degrades to `mcp_unavailable` (the prompt still goes
  through, strict mode waits for the model's own call) and is retried after 10 s.
- **Latency.** Lookups run before the model starts; cache hits and the timeout bound it.
  Concurrent resolve calls can hit Context7's rate limit; the mod then pauses lookups
  (`cooldownSec`) and reports `rate_limited`.
- **Subagents** receive docs through their spawn prompt. Strict mode applies to them via
  the task ledger of the latest typed prompt; a subagent started before any prompt has
  its own libraries tracked under a new task.
- The cache is one JSON blob in `$.store`, capped at 80 entries / about 1.5 MB, oldest
  evicted first. Failures are never cached.
- Task state lives in memory: a hot reload of the mod resets the current task (history
  and cache survive).
