import type { McpToolResult } from 'claude-code'

import { cacheGet, cacheSet } from './cache'
import { classifyError, pickEntry, pickVersion, parseResolve, textOf } from './parse'
import type { FailureKind } from './parse'
import type { Api as Engine, Candidate, Config, LibRecord } from './types'

/** Mutable runtime state that lives as long as the module (not persisted). */
export type Runtime = {
  /** Servers to try, in order; a fallback that answered moves to the front. */
  servers: string[]
  blockedUntil: number
  blockedKind?: FailureKind
}

export const newRuntime = (cfg: Config): Runtime => ({
  servers: [cfg.server, cfg.fallbackServer].filter((s, i, a) => s !== '' && a.indexOf(s) === i),
  blockedUntil: 0,
})

class Stage extends Error {
  constructor(
    readonly kind: FailureKind,
    message: string,
  ) {
    super(message)
  }
}

const SHORT_RATE = /rate.?limit|too many requests|quota exceeded/i

/** Calls one Context7 tool with the configured servers, a timeout, and error classification. */
async function call(
  $: Engine,
  cfg: Config,
  rt: Runtime,
  tool: 'resolve-library-id' | 'query-docs',
  args: Record<string, unknown>,
): Promise<{ text: string; server: string }> {
  const now = await $.clock.now()
  if (now < rt.blockedUntil && rt.blockedKind) {
    throw new Stage(rt.blockedKind, `skipped: ${rt.blockedKind} cooldown after an earlier failure`)
  }
  let last: Stage = new Stage('mcp_unavailable', 'no Context7 server configured')
  for (const server of rt.servers) {
    try {
      const res: McpToolResult = await Promise.race([
        $.mcp.call(server, tool, args),
        $.clock.sleep(cfg.timeoutMs).then((): never => {
          throw new Error(`timed out after ${cfg.timeoutMs}ms`)
        }),
      ])
      const text = textOf(res)
      if (res.isError) throw new Stage(classifyError(text), text.slice(0, 200) || 'tool reported an error')
      if (text.length < 400 && SHORT_RATE.test(text)) throw new Stage('rate_limited', text.slice(0, 200))
      if (rt.servers[0] !== server) rt.servers = [server, ...rt.servers.filter(s => s !== server)]
      return { text, server }
    } catch (err) {
      // A rejection (never an `isError` reply) means no protocol-level answer: the server is unreachable.
      const reason = err instanceof Error ? err.message : String(err)
      const kind = classifyError(reason)
      const stage = err instanceof Stage ? err : new Stage(kind === 'failed' || kind === 'unsupported' ? 'mcp_unavailable' : kind, reason.slice(0, 200))
      last = stage
      if (stage.kind !== 'mcp_unavailable') break // another server will not fix a rate limit or a missing library
    }
  }
  if ((last.kind === 'rate_limited' || last.kind === 'mcp_unavailable') && cfg.cooldownMs > 0) {
    // A server that is merely still starting up (first prompt of a session) should be retried soon.
    rt.blockedKind = last.kind
    rt.blockedUntil = (await $.clock.now()) + (last.kind === 'mcp_unavailable' ? Math.min(cfg.cooldownMs, 10_000) : cfg.cooldownMs)
  }
  throw last
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/**
 * Query sent to Context7. The prompt is project text, so it is stripped of code,
 * long tokens and e-mail addresses before it leaves the machine.
 */
export function buildQuery(display: string, prompt: string, max = 300): string {
  const text = prompt
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`/g, '')
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, ' ')
    .replace(/https?:\/\/\S*/g, ' ')
    .replace(/\b(?:sk|pk|ghp|gho|xox[bap]|AKIA)[-_A-Za-z0-9]{8,}\b/g, ' ')
    .replace(/[A-Za-z0-9+/=_-]{32,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
  return `${display}: ${text}`.trim()
}

type DocsEntry = { libraryId: string; version?: string; match: LibRecord['versionMatch']; text: string; server: string }
type IdEntry = { libraryId: string; version?: string; match: LibRecord['versionMatch'] }

/** Looks one library up: cache, resolve-library-id, query-docs. Never throws. */
export async function lookupLibrary(
  $: Engine,
  cfg: Config,
  rt: Runtime,
  cand: Candidate,
  prompt: string,
): Promise<{ record: LibRecord; docs?: string }> {
  const base: LibRecord = {
    name: cand.display,
    key: cand.key,
    ...(cand.version ? { requestedVersion: cand.version } : {}),
    status: 'failed',
    at: await $.clock.now(),
  }
  const query = buildQuery(cand.display, prompt)
  const docsKey = `docs|${cand.key}|${cand.version ?? ''}|${norm(query).slice(0, 160)}`
  try {
    const hit = await cacheGet<DocsEntry>($, docsKey, cfg.cacheTtlMs)
    if (hit && hit.text) {
      return {
        record: {
          ...base,
          status: 'cached',
          libraryId: hit.libraryId,
          ...(hit.version ? { resolvedVersion: hit.version } : {}),
          ...(hit.match ? { versionMatch: hit.match } : {}),
          source: `cache (Context7 via ${hit.server})`,
          server: hit.server,
          chars: hit.text.length,
        },
        docs: hit.text,
      }
    }

    // 1. resolve the library ID
    const idKey = `id|${cand.key}|${cand.version ?? ''}`
    let ident = await cacheGet<IdEntry>($, idKey, cfg.cacheTtlMs)
    let server = rt.servers[0] ?? cfg.server
    if (!ident) {
      const r = await call($, cfg, rt, 'resolve-library-id', { libraryName: cand.display, query })
      server = r.server
      const entries = parseResolve(r.text)
      if (entries.length === 0) throw new Stage('unsupported', 'Context7 returned no libraries')
      const entry = pickEntry(entries, cand.display)
      if (!entry) throw new Stage('unsupported', `no Context7 library matches "${cand.display}"`)
      const v = pickVersion(entry, cand.version)
      ident = { libraryId: v.id, ...(v.version ? { version: v.version } : {}), match: v.match }
      await cacheSet($, idKey, ident, cfg.cacheTtlMs)
    }

    // 2. fetch task-specific documentation
    const r = await call($, cfg, rt, 'query-docs', {
      libraryId: ident.libraryId,
      query,
      ...(cand.language ? { language: cand.language } : {}),
    })
    server = r.server
    const text = r.text.slice(0, cfg.maxDocChars)
    if (text.trim() === '') throw new Stage('failed', 'query-docs returned no documentation')
    await cacheSet($, docsKey, { ...ident, text, server } satisfies DocsEntry, cfg.cacheTtlMs)
    return {
      record: {
        ...base,
        status: 'ok',
        libraryId: ident.libraryId,
        ...(ident.version ? { resolvedVersion: ident.version } : {}),
        ...(ident.match ? { versionMatch: ident.match } : {}),
        source: `Context7 via ${server}`,
        server,
        chars: text.length,
      },
      docs: text,
    }
  } catch (err) {
    const stage = err instanceof Stage ? err : new Stage('failed', String(err instanceof Error ? err.message : err).slice(0, 200))
    return { record: { ...base, status: stage.kind, error: stage.message } }
  }
}
