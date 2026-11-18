import type { Hook } from 'claude-code'

/** The engine interface `$` every hook receives. */
export type Api = Parameters<Hook<'prompt.submit'>>[0]

export type Mode = 'advisory' | 'strict' | 'disabled'

export type Status =
  | 'ok' // retrieved from Context7 by this mod
  | 'cached' // served from the mod's cache
  | 'model' // the model retrieved it itself through the Context7 tools
  | 'waived' // the person ran /context7 bypass
  | 'unsupported' // Context7 has no matching library
  | 'mcp_unavailable'
  | 'rate_limited'
  | 'timeout'
  | 'failed'
  | 'skipped' // detected but over the per-task limit

export type VersionMatch = 'exact' | 'minor' | 'major' | 'none' | 'unversioned'

export type Config = {
  mode: Mode
  server: string
  fallbackServer: string
  cacheTtlMs: number
  maxLibraries: number
  timeoutMs: number
  maxDocChars: number
  cooldownMs: number
}

export type Dep = { name: string; version?: string; manifest: string }

export type Candidate = {
  /** Lowercase dedupe key. */
  key: string
  /** The name given to resolve-library-id. */
  display: string
  /** Version found in a project manifest, as written there. */
  version?: string
  manifest?: string
  source: 'manifest' | 'alias' | 'import'
  language?: string
}

export type LibRecord = {
  name: string
  key: string
  requestedVersion?: string
  resolvedVersion?: string
  versionMatch?: VersionMatch
  libraryId?: string
  status: Status
  /** Where the documentation came from. */
  source?: string
  server?: string
  error?: string
  chars?: number
  agentId?: string
  at: number
}

export type Task = {
  id: number
  at: number
  promptChars: number
  skipReason?: string
  libs: LibRecord[]
  docs: Record<string, string>
  waived: boolean
}
