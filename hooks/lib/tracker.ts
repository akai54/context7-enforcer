import type { Config, LibRecord, Status, Task } from './types'

const DONE: ReadonlySet<Status> = new Set(['ok', 'cached', 'model', 'waived'])
/** Statuses that block code edits in strict mode: documentation was wanted and is not here. */
const BLOCKING: ReadonlySet<Status> = new Set(['mcp_unavailable', 'rate_limited', 'timeout', 'failed'])

export const isDone = (s: Status): boolean => DONE.has(s)

export type Ledger = { tasks: Task[]; current: Task | undefined; nextId: number }

export const newLedger = (): Ledger => ({ tasks: [], current: undefined, nextId: 1 })

export function begin(l: Ledger, at: number, promptChars: number): Task {
  const task: Task = { id: l.nextId++, at, promptChars, libs: [], docs: {}, waived: false }
  l.current = task
  l.tasks = [...l.tasks.slice(-24), task]
  return task
}

export function record(task: Task, rec: LibRecord, docs?: string): void {
  task.libs = [...task.libs.filter(x => !(x.key === rec.key && !x.agentId === !rec.agentId)), rec]
  if (docs) task.docs[rec.key] = docs
}

/** Libraries the strict gate still waits for. */
export const pending = (task: Task | undefined): LibRecord[] =>
  !task || task.waived ? [] : task.libs.filter(l => BLOCKING.has(l.status))

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * The model called query-docs itself: mark the libraries that call covers.
 * Returns the records changed or added.
 */
export function markModelRetrieval(task: Task, libraryId: string, at: number, server: string, agentId?: string): LibRecord[] {
  const id = norm(libraryId)
  const touched: LibRecord[] = []
  if (task.libs.some(l => isDone(l.status) && l.libraryId && libraryId.startsWith(l.libraryId))) return touched // already covered
  const covered = task.libs.filter(l => id.includes(norm(l.name)) || id.includes(norm(l.key)) || (l.libraryId && libraryId.startsWith(l.libraryId.split('/').slice(0, 3).join('/'))))
  for (const l of covered) {
    if (isDone(l.status)) continue
    const upd: LibRecord = { ...l, status: 'model', source: `model call via ${server}`, libraryId, at, ...(agentId ? { agentId } : {}) }
    delete upd.error
    task.libs = task.libs.map(x => (x === l ? upd : x))
    touched.push(upd)
  }
  if (covered.length === 0) {
    const rec: LibRecord = { name: libraryId, key: libraryId.toLowerCase(), libraryId, status: 'model', source: `model call via ${server}`, at, ...(agentId ? { agentId } : {}) }
    task.libs = [...task.libs, rec]
    touched.push(rec)
  }
  return touched
}

const mark = (s: Status): string => (isDone(s) ? '✓' : s === 'unsupported' || s === 'skipped' ? '–' : '✗')

/** One short line for `$.ui.status`. */
export function statusLine(task: Task | undefined, cfg: Config): string | undefined {
  if (!task || task.libs.length === 0 || cfg.mode === 'disabled') return undefined
  const shown = task.libs.slice(0, 4).map(l => {
    const v = l.resolvedVersion ?? l.requestedVersion
    return `${l.name}${v ? '@' + v : ''}${mark(l.status)}${isDone(l.status) || l.status === 'unsupported' ? '' : ' ' + l.status}`
  })
  const more = task.libs.length > 4 ? ` +${task.libs.length - 4}` : ''
  return `ctx7[${cfg.mode === 'strict' ? 'strict' : 'adv'}] ${shown.join(' · ')}${more}`
}

/** Human-readable detail of one task, for /context7. */
export function describe(task: Task): string {
  const head = `task #${task.id}${task.skipReason ? ` (no lookup: ${task.skipReason})` : ''}`
  if (task.libs.length === 0) return head
  return [
    head,
    ...task.libs.map(l => {
      const ver = l.requestedVersion ? ` wants ${l.requestedVersion}` : ''
      const got = l.libraryId ? ` -> ${l.libraryId}${l.versionMatch ? ` [version ${l.versionMatch}]` : ''}` : ''
      const src = l.source ? ` | ${l.source}` : ''
      const err = l.error ? ` | error: ${l.error}` : ''
      return `  ${mark(l.status)} ${l.name}${ver}${got} | ${l.status}${src}${err}`
    }),
  ].join('\n')
}

/** What a stored history row keeps: libraries and outcomes, never the prompt text. */
export const compact = (t: Task) => ({
  id: t.id,
  at: t.at,
  promptChars: t.promptChars,
  skipReason: t.skipReason ?? null,
  libs: t.libs.map(l => ({
    name: l.name,
    version: l.resolvedVersion ?? l.requestedVersion ?? null,
    libraryId: l.libraryId ?? null,
    status: l.status,
    source: l.source ?? null,
    error: l.error ?? null,
  })),
})

/**
 * The block added to the model's context. Documentation is split evenly over the
 * libraries that have it; libraries without it are named so the model does not guess.
 */
export function formatContext(task: Task, cfg: Config, intro = 'Up-to-date documentation retrieved automatically through the Context7 MCP server'): string | undefined {
  const withDocs = task.libs.filter(l => task.docs[l.key] && isDone(l.status))
  const missing = task.libs.filter(l => !isDone(l.status) && l.status !== 'skipped')
  if (withDocs.length === 0 && missing.length === 0) return undefined
  const per = Math.floor(cfg.maxDocChars / Math.max(1, withDocs.length))
  const lines = [`<context7-enforcer>`, `${intro}. Prefer it over memory for the APIs below; if it conflicts with the project's own code, the project wins.`]
  for (const l of withDocs) {
    const v = l.resolvedVersion ?? l.requestedVersion
    const note =
      l.requestedVersion && l.versionMatch && l.versionMatch !== 'exact' && l.versionMatch !== 'unversioned'
        ? ` (project uses ${l.requestedVersion}; Context7 version match: ${l.versionMatch})`
        : ''
    lines.push('', `## ${l.name}${v ? ' ' + v : ''} - ${l.libraryId} - ${l.source}${note}`, (task.docs[l.key] ?? '').slice(0, per))
  }
  if (missing.length) {
    lines.push(
      '',
      'No documentation could be retrieved for: ' +
        missing.map(l => `${l.name} (${l.status}${l.error ? ': ' + l.error : ''})`).join('; ') +
        '. Do not invent API details for these: say what you are unsure of' +
        (cfg.mode === 'strict' ? ', or call the Context7 tools (resolve-library-id, then query-docs) yourself.' : '.'),
    )
  }
  lines.push('</context7-enforcer>')
  return lines.join('\n')
}
