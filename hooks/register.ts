import type { Register } from 'claude-code'

import { parseConfig, toolPrefix } from './lib/config'
import { skipReason } from './lib/detect'
import { finish, gather, runCommand } from './lib/engine'
import type { Env } from './lib/engine'
import { newRuntime } from './lib/lookup'
import { begin, formatContext, markModelRetrieval, newLedger, pending, statusLine } from './lib/tracker'

// Edits to these files are "code modification"; docs, notes and data are not gated.
const CODE_FILE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|kts|rb|php|cs|swift|vue|svelte|scala|dart|c|cc|cpp|h|hpp|ipynb)$/i

export const register: Register = (on, options) => {
  const cfg = parseConfig(options)
  const rt = newRuntime(cfg)
  const ledger = newLedger()
  const prefixes = rt.servers.map(toolPrefix)

  const env: Env = { cfg, rt, ledger }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'context7',
      description: 'Context7 enforcer: status, bypass (waive strict mode for this task), clear-cache',
      argumentHint: '[status|bypass|clear-cache]',
    })
    return next(e)
  })

  // 1. Every typed prompt: detect libraries, fetch documentation, add it to the model's context.
  on('prompt.submit', async ($, e, next) => {
    const kind = e.origin?.kind
    const isTyped = kind === undefined || kind === 'composer' || kind === 'bridge' || kind === 'sdk' || kind === 'slack-ping' || kind === 'unclassified' || (kind === 'plugin' && e.origin?.kind === 'plugin' && e.origin.asUser === true)
    if (cfg.mode === 'disabled' || e.command || e.isMeta || !isTyped) return next(e)

    const task = begin(ledger, await $.clock.now(), e.text.length)
    const skip = skipReason(e.text)
    if (skip) {
      task.skipReason = skip
      $.ui.status(undefined)
      return next(e)
    }
    await gather($, env, e.text, task)
    if (task.libs.length === 0) {
      task.skipReason = 'no-library'
      $.ui.status(undefined)
      return next(e)
    }
    await finish($, env, task)
    const block = formatContext(task, cfg)
    return next(block ? { ...e, context: [...(e.context ?? []), block] } : e)
  }).catch(($, e, next) => {
    // A failed lookup must never lose the user's prompt; strict mode then waits for the model's own lookup.
    for (const l of ledger.current?.libs ?? []) if (l.status === 'failed' && !l.error) l.error = 'internal error'
    return next(e)
  })

  // 2. Subagents never see the parent's prompt-time context: hand them the task's documentation.
  on('agent.spawn', async ($, e, next) => {
    if (cfg.mode === 'disabled' || e.resume || e.subagentType === 'fork' || skipReason(e.prompt) !== undefined) return next(e)
    const task = ledger.current ?? begin(ledger, await $.clock.now(), e.prompt.length)
    await gather($, env, e.prompt, task)
    $.ui.status(statusLine(task, cfg))
    const block = formatContext(task, cfg, 'Up-to-date documentation the parent session retrieved through the Context7 MCP server')
    return next(block ? { ...e, prompt: `${e.prompt}\n\n${block}` } : e)
  }).catch(($, e, next) => next(e))

  // 3. The model asked Context7 itself: that satisfies strict mode.
  const queryDocs = new RegExp('^(?:' + prefixes.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')query-docs$')
  on('tool.call', { tool: queryDocs }, async ($, e, next) => {
    // This mod's own lookups pass through here too (`$.mcp.call` raises tool.call); only the model's count.
    if (next.origin.plugin === $.plugin.name) return next(e)
    const ran = await next(e)
    const raw = e as unknown as { tool: string; libraryId?: unknown; agentId?: string }
    // The error flag is core's `isError`, or the MCP result's own when a hook answered with it.
    const failed = ran.isError === true || (ran.result as { isError?: unknown } | undefined)?.isError === true
    if (ran.deny === undefined && !failed && typeof raw.libraryId === 'string' && ledger.current) {
      const server = raw.tool.slice(5, raw.tool.lastIndexOf('__'))
      markModelRetrieval(ledger.current, raw.libraryId, await $.clock.now(), server, raw.agentId)
      $.ui.status(statusLine(ledger.current, cfg))
    }
    return ran
  }).catch(($, e, next) => next(e))

  // 4. Strict mode: no code edits while a detected library's documentation is missing.
  const blockedBy = (path: string): { deny: string } | undefined => {
    const wait = pending(ledger.current)
    if (cfg.mode !== 'strict' || wait.length === 0 || !CODE_FILE.test(path)) return undefined
    const q = prefixes[0]
    return {
      deny:
        `context7-enforcer (strict): documentation for ${wait.map(l => `${l.name} (${l.status})`).join(', ')} was not retrieved. ` +
        `Call ${q}resolve-library-id and ${q}query-docs for ${wait.length > 1 ? 'each of them' : 'it'}, then retry this edit. ` +
        `If Context7 is unreachable, ask the user to run /context7 bypass.`,
    }
  }
  on('tool.call', { tool: 'Edit' }, ($, e, next) => blockedBy(e.file_path) ?? next(e)).catch(($, e, next) => next(e))
  on('tool.call', { tool: 'Write' }, ($, e, next) => blockedBy(e.file_path) ?? next(e)).catch(($, e, next) => next(e))
  on('tool.call', { tool: 'NotebookEdit' }, ($, e, next) => blockedBy(e.notebook_path + '.ipynb') ?? next(e)).catch(($, e, next) => next(e))

  // 5. /context7 [status|bypass|clear-cache]
  on('command.run', { command: 'context7' }, ($, e) => runCommand($, env, e.args))
}
