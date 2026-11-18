import type { Config, Mode } from './types'

const num = (v: unknown, d: number, min: number, max: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : d
  return Math.min(max, Math.max(min, n))
}

const str = (v: unknown, d: string): string => (typeof v === 'string' ? v.trim() : d)

export function parseConfig(o: Readonly<Record<string, unknown>>): Config {
  const m = o['mode']
  const mode: Mode = m === 'strict' || m === 'disabled' || m === 'advisory' ? m : 'advisory'
  return {
    mode,
    server: str(o['server'], 'plugin:context7:context7') || 'plugin:context7:context7',
    fallbackServer: str(o['fallbackServer'], 'claude.ai Context7'),
    cacheTtlMs: num(o['cacheTtlHours'], 24, 0, 24 * 365) * 3_600_000,
    maxLibraries: Math.round(num(o['maxLibraries'], 3, 1, 8)),
    timeoutMs: num(o['timeoutMs'], 15000, 1000, 120000),
    maxDocChars: num(o['maxDocChars'], 16000, 2000, 80000),
    cooldownMs: num(o['cooldownSec'], 60, 0, 3600) * 1000,
  }
}

/** `plugin:context7:context7` -> `plugin_context7_context7`, as tool names spell it. */
export const toolPrefix = (server: string): string => `mcp__${server.replace(/[^A-Za-z0-9_-]/g, '_')}__`
