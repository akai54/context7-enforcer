import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

export const NEXT_RESOLVE = `Available Libraries:

- Title: Next.js
- Context7-compatible library ID: /vercel/next.js
- Description: Next.js enables you to create full-stack web applications.
- Code Snippets: 7541
- Source Reputation: High
- Benchmark Score: 80.82
- Versions: v14.3.0-canary.87, v13.5.11, v12.3.7, v14.2.35, v15.5.28, v16.2.9, __branch__01-02-copy_58398
----------
- Title: Learn Next.js
- Context7-compatible library ID: /vercel/next-learn
- Description: starter templates
- Code Snippets: 265
- Source Reputation: High
- Benchmark Score: 68.19`

const resolveFor = (name: string): string => {
  const n = name.toLowerCase()
  if (n.includes('next')) return NEXT_RESOLVE
  if (n.includes('prisma'))
    return `Available Libraries:\n\n- Title: Prisma\n- Context7-compatible library ID: /prisma/prisma\n- Code Snippets: 900\n- Source Reputation: High\n- Benchmark Score: 70\n- Versions: v5.22.0, v6.1.0`
  if (n.includes('zod'))
    return `Available Libraries:\n\n- Title: Zod\n- Context7-compatible library ID: /colinhacks/zod\n- Code Snippets: 500\n- Source Reputation: High\n- Benchmark Score: 90\n- Versions: v3.23.8`
  if (n.includes('react'))
    return `Available Libraries:\n\n- Title: React\n- Context7-compatible library ID: /facebook/react\n- Code Snippets: 2000\n- Source Reputation: High\n- Benchmark Score: 85\n- Versions: v18.3.1, v19.0.0`
  return `Available Libraries:\n\n- Title: Something Unrelated\n- Context7-compatible library ID: /other/thing\n- Code Snippets: 1\n- Source Reputation: Low\n- Benchmark Score: 1`
}

export type McpCall = { server: string; tool: string; args: Record<string, unknown> }

export type Rig = {
  calls: McpCall[]
  statuses: (string | undefined)[]
  toasts: string[]
  /** What reached the engine's own prompt handling. */
  submitted: { text: string; context: readonly string[] }[]
  files: Record<string, string>
  store: Map<string, unknown>
  clock: { now: number }
  /** True makes every $.clock.sleep (the lookup timeout) fire at once. */
  timer: { fires: boolean }
  /** Override how the fake MCP answers. */
  mcp: { handler: (c: McpCall) => unknown }
}

const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], isError })

export const down = () => ({ content: [{ type: 'text' as const, text: 'MCP server not connected' }], isError: true })

export const defaultMcp = (c: McpCall) => {
  if (c.tool === 'resolve-library-id') return text(resolveFor(String(c.args['libraryName'])))
  return text(`DOCS for ${String(c.args['libraryId'])}: use the documented API.`)
}

/** Registers the engine's bottom (what answers beneath the mod) before the first call on `$`. */
export function rig(on: On, files: Record<string, string> = {}): Rig {
  const r: Rig = {
    calls: [],
    statuses: [],
    toasts: [],
    submitted: [],
    files: { ...files },
    store: new Map(),
    clock: { now: 1_000_000 },
    timer: { fires: false },
    mcp: { handler: defaultMcp },
  }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'context7' } }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('fs.exists', (_, e) => ({ value: `/proj/${e.path.split('/').pop()}` in r.files || e.path in r.files }))
  on('fs.read', (_, e) => ({ value: r.files[e.path] ?? r.files[`/proj/${e.path.split('/').pop()}`] ?? '' }))
  on('store.get', (_, e) => ({ value: r.store.get(e.key) }))
  on('store.set', (_, e) => {
    r.store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    r.store.delete(e.key)
    return { value: undefined }
  })
  on('clock.now', () => ({ value: r.clock.now }))
  on('clock.sleep', () => (r.timer.fires ? { value: undefined } : new Promise(() => undefined)))
  on('ui.status', (_, e) => {
    r.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    r.toasts.push(e.text)
    return { value: undefined }
  })
  on('mcp.call', async (_, e) => {
    const c: McpCall = { server: e.server, tool: e.tool, args: e.args }
    r.calls.push(c)
    const out = await r.mcp.handler(c)
    return { value: out } as never
  })
  on('prompt.submit', (_, e) => {
    r.submitted.push({ text: e.text, context: e.context ?? [] })
    return { text: e.text, ...(e.context ? { context: e.context } : {}) }
  })
  return r
}

export const NEXT_PKG = JSON.stringify({ dependencies: { next: '^14.2.3', react: '18.3.1' }, devDependencies: { zod: '^3.23.8' } })
export const MANY_PKG = JSON.stringify({ dependencies: { next: '14.2.3', '@prisma/client': '^6.1.0', zod: '^3.23.8' } })

export const start = ($: Engine) => $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
export const ask = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'plugin', name: 'test', asUser: true } })
export const contextOf = (r: Rig): string => r.submitted.at(-1)?.context.join('\n') ?? ''
