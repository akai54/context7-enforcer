import type { McpToolResult } from 'claude-code'

import type { VersionMatch } from './types'

export type ResolveEntry = {
  title: string
  id: string
  versions: string[]
  reputation?: string
  score: number
}

/** Text of an MCP result: its text blocks joined. */
export function textOf(res: McpToolResult): string {
  return res.content
    .map(b => (b && typeof b === 'object' && 'text' in b && typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n')
}

/**
 * Reads resolve-library-id's text answer:
 * blocks separated by `----------`, each with `- Title:`, `- Context7-compatible library ID:`,
 * `- Versions:`, ... Anything that does not carry an ID in `/org/project` form is dropped,
 * so an ID can only come from the server's own answer.
 */
export function parseResolve(text: string): ResolveEntry[] {
  const out: ResolveEntry[] = []
  for (const block of text.split(/^-{5,}\s*$/m)) {
    const id = /library ID:\s*(\/[\w.-]+\/[^\s]+)/i.exec(block)?.[1]
    const title = /Title:\s*(.+)/i.exec(block)?.[1]?.trim()
    if (!id || !title) continue
    const versions = (/Versions:\s*(.+)/i.exec(block)?.[1] ?? '')
      .split(',')
      .map(v => v.trim())
      .filter(Boolean)
    out.push({
      title,
      id,
      versions,
      reputation: /Source Reputation:\s*(\w+)/i.exec(block)?.[1],
      score: Number(/Benchmark Score:\s*([\d.]+)/i.exec(block)?.[1] ?? 0),
    })
  }
  return out
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/** Does a resolve entry plausibly describe the library we asked for? */
export function entryMatches(entry: ResolveEntry, name: string): boolean {
  const n = norm(name.replace(/^@/, ''))
  const last = norm(name.split('/').pop() ?? name)
  const title = norm(entry.title)
  const id = norm(entry.id)
  const hay = title + '|' + id
  if (n.length >= 3 && (hay.includes(n) || (title.length >= 4 && n.includes(title)))) return true
  if (last.length >= 3 && hay.includes(last)) return true
  const tokens = name.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3)
  return tokens.length > 1 && tokens.every(t => hay.includes(t))
}

/** Best matching entry (server order is relevance; prefer a trusted source among matches), or undefined. */
export function pickEntry(entries: ResolveEntry[], name: string): ResolveEntry | undefined {
  const matches = entries.filter(e => entryMatches(e, name))
  return matches.find(e => /^(high|medium)$/i.test(e.reputation ?? '')) ?? matches[0]
}

const UNSTABLE = /canary|beta|alpha|rc|next|pre|dev|nightly|__branch__|snapshot/i

const parts = (tag: string): [number, number | undefined, number | undefined] | undefined => {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(tag)
  if (!m) return undefined
  return [Number(m[1]), m[2] === undefined ? undefined : Number(m[2]), m[3] === undefined ? undefined : Number(m[3])]
}

const newest = (a: string, b: string): number => {
  const [pa, pb] = [parts(a), parts(b)]
  if (!pa || !pb) return 0
  return pa[0] - pb[0] || (pa[1] ?? 0) - (pb[1] ?? 0) || (pa[2] ?? 0) - (pb[2] ?? 0)
}

/**
 * Maps the project's version onto a version Context7 really lists. When none
 * fits, the base ID is used and nothing is invented.
 */
export function pickVersion(
  entry: ResolveEntry,
  requested?: string,
): { id: string; version?: string; match: VersionMatch } {
  if (!requested) return { id: entry.id, match: 'unversioned' }
  const want = parts(requested)
  const stable = entry.versions.filter(v => !UNSTABLE.test(v) && parts(v))
  if (!want) return { id: entry.id, match: 'none' }
  const sameMajor = stable.filter(v => parts(v)?.[0] === want[0])
  const exact = sameMajor.find(v => {
    const p = parts(v)
    return p !== undefined && p[1] === want[1] && p[2] === want[2] && want[1] !== undefined && want[2] !== undefined
  })
  if (exact) return { id: `${entry.id}/${exact}`, version: exact, match: 'exact' }
  if (want[1] !== undefined) {
    const minor = sameMajor.filter(v => parts(v)?.[1] === want[1]).sort(newest).pop()
    if (minor) return { id: `${entry.id}/${minor}`, version: minor, match: 'minor' }
  }
  const major = [...sameMajor].sort(newest).pop()
  if (major) return { id: `${entry.id}/${major}`, version: major, match: 'major' }
  return { id: entry.id, match: 'none' }
}

export type FailureKind = 'rate_limited' | 'unsupported' | 'mcp_unavailable' | 'timeout' | 'failed'

/** Sorts an MCP error (thrown message or error-result text) into a status. */
export function classifyError(message: string): FailureKind {
  const m = message.toLowerCase()
  if (/\b429\b|rate.?limit|too many requests|quota/.test(m)) return 'rate_limited'
  if (/timed? ?out|timeout/.test(m)) return 'timeout'
  if (/(library|libraries|documentation).{0,40}(not found|no match)|no (libraries|results|documentation) found/.test(m))
    return 'unsupported'
  if (
    /no such server|unknown server|not connected|not configured|disconnected|econn|enotfound|unavailable|needs auth|unauthori[sz]ed|\b40[13]\b|\b50[234]\b|connect|removed by plugin|no mcp server|is not connected|not found/.test(
      m,
    )
  )
    return 'mcp_unavailable'
  return 'failed'
}
