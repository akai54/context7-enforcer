// Everything that takes `$` lives here as plain top-level functions, which is the
// only way `claude plugin validate` lets a hooks module hand `$` to a helper.
import { cacheClear, cacheStats } from './cache'
import { findCandidates, MANIFESTS } from './detect'
import { lookupLibrary } from './lookup'
import type { Runtime } from './lookup'
import { compact, describe, isDone, pending, record, statusLine } from './tracker'
import type { Ledger } from './tracker'
import type { Api, Config, Dep, Task } from './types'

export type Env = { cfg: Config; rt: Runtime; ledger: Ledger }

export const HISTORY = 'c7e:history'

/** Dependencies the project's manifests declare, from the session's working directory. */
export async function readDeps($: Api): Promise<Map<string, Dep>> {
  const deps = new Map<string, Dep>()
  let cwd = ''
  try {
    cwd = await $.session.cwd()
  } catch {
    return deps
  }
  for (const [file, parse] of MANIFESTS) {
    try {
      const path = `${cwd.replace(/\/$/, '')}/${file}`
      if (await $.fs.exists(path)) parse(String(await $.fs.read(path)), deps)
    } catch {
      /* an unreadable manifest only means fewer versions to go on */
    }
  }
  return deps
}

/** Detects the libraries in `text` and looks them up (in parallel, at most maxLibraries). */
export async function gather($: Api, env: Env, text: string, task: Task): Promise<void> {
  const { cfg, rt } = env
  const cands = findCandidates(text, await readDeps($)).filter(c => !task.libs.some(l => l.key === c.key))
  for (const c of cands.slice(cfg.maxLibraries)) {
    record(task, { name: c.display, key: c.key, status: 'skipped', error: `over the ${cfg.maxLibraries}-library limit`, at: task.at })
  }
  const results = await Promise.all(cands.slice(0, cfg.maxLibraries).map(c => lookupLibrary($, cfg, rt, c, text)))
  for (const r of results) record(task, r.record, r.docs)
}

/** Status line, a toast for libraries that failed, and the stored history row. */
export async function finish($: Api, env: Env, task: Task): Promise<void> {
  $.ui.status(statusLine(task, env.cfg))
  const bad = task.libs.filter(l => !isDone(l.status) && l.status !== 'skipped' && l.status !== 'unsupported')
  if (bad.length) $.ui.toast(`Context7: no docs for ${bad.map(l => `${l.name} (${l.status})`).join(', ')}`)
  try {
    const old = await $.store.get(HISTORY)
    const rows = Array.isArray(old) ? old : []
    await $.store.set(HISTORY, [...rows.filter(r => r?.id !== task.id).slice(-19), compact(task)])
  } catch {
    /* history is a convenience */
  }
}

/** `/context7 [status|bypass|clear-cache]` */
export async function runCommand($: Api, env: Env, args: string): Promise<{ text: string }> {
  const { cfg, rt, ledger } = env
  const arg = args.trim().toLowerCase()
  if (arg === 'clear-cache') {
    await cacheClear($)
    return { text: 'Context7 cache cleared.' }
  }
  if (arg === 'bypass') {
    const task = ledger.current
    if (!task) return { text: 'No task yet: nothing to bypass.' }
    const waived = pending(task)
    task.waived = true
    task.libs = task.libs.map(l => (waived.includes(l) ? { ...l, status: 'waived' as const, source: 'waived by the user' } : l))
    $.ui.status(statusLine(task, cfg))
    return { text: `Strict mode waived for task #${task.id}${waived.length ? ': ' + waived.map(l => l.name).join(', ') : ''}.` }
  }
  const stats = await cacheStats($)
  const history = await $.store.get(HISTORY)
  const rows = Array.isArray(history)
    ? history.slice(-5).map(h => `  #${h.id}: ${(h.libs ?? []).map((l: { name: string; status: string }) => `${l.name} ${l.status}`).join(', ') || h.skipReason || 'no libraries'}`)
    : []
  return {
    text: [
      `context7-enforcer: mode ${cfg.mode}, servers ${rt.servers.join(' -> ') || '(none)'}, cache ${stats.entries} entries / ${Math.round(stats.bytes / 1024)} KiB, ttl ${Math.round(cfg.cacheTtlMs / 3_600_000)}h`,
      ledger.current ? describe(ledger.current) : 'no task yet',
      ...(rows.length ? ['recent tasks:', ...rows] : []),
    ].join('\n'),
  }
}
