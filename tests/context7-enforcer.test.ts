import { expect, test } from 'claude-code/testing'

import { ask, contextOf, defaultMcp, down, MANY_PKG, NEXT_PKG, rig, start } from './helpers'

const PRIMARY = 'plugin:context7:context7'
const FALLBACK = 'claude.ai Context7'
const QUERY_DOCS = 'mcp__plugin_context7_context7__query-docs'
const spawnArgs = (prompt: string) => ({
  tool_use_id: 't1',
  prompt,
  description: 'task',
  subagentType: 'general-purpose',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'm',
  background: false,
  fork: false,
}) as never

// ---------------------------------------------------------------- documentation-dependent task

test('a library task gets docs: resolve, version from package.json, query-docs, injected context', async ($, on) => {
  const r = rig(on, { '/proj/package.json': NEXT_PKG })
  await start($)
  await ask($, 'Add middleware to my Next.js app that redirects unauthenticated users to /login')

  expect(r.calls.map(c => c.tool)).toEqual(['resolve-library-id', 'query-docs'])
  expect(r.calls.every(c => c.server === PRIMARY)).toBe(true)
  // 14.2.3 in package.json maps onto a version Context7 really lists (v14.2.35), never an invented one.
  expect(r.calls[1]?.args['libraryId']).toBe('/vercel/next.js/v14.2.35')
  expect(String(r.calls[1]?.args['query'])).toContain('middleware')

  const ctx = contextOf(r)
  expect(ctx).toContain('<context7-enforcer>')
  expect(ctx).toContain('/vercel/next.js/v14.2.35')
  expect(ctx).toContain('DOCS for /vercel/next.js/v14.2.35')
  expect(r.submitted[0]?.text).toBe('Add middleware to my Next.js app that redirects unauthenticated users to /login')
  expect(r.statuses.at(-1)).toMatch(/Next\.js@v14\.2\.35✓/)
})

test('the query leaves the machine without code, e-mail addresses or tokens', async ($, on) => {
  const r = rig(on, { '/proj/package.json': NEXT_PKG })
  await start($)
  await ask($, 'Configure Next.js redirects. ```const KEY="sk-live-abcdefghijklmnop"``` mail me at a@b.com token ghp_abcdefghij1234567')

  const q = String(r.calls[0]?.args['query'])
  expect(q).not.toContain('sk-live')
  expect(q).not.toContain('a@b.com')
  expect(q).not.toContain('ghp_')
})

// ---------------------------------------------------------------- tasks that need no Context7

test('git, navigation, simple text edits and project-only tasks trigger no lookup', async ($, on) => {
  const r = rig(on, { '/proj/package.json': NEXT_PKG })
  await start($)
  for (const text of [
    'git commit all changes with a short message',
    'ls src and show me the tree',
    'fix the typo in the README',
    'rename the helper function parseOrder to parseCartOrder in utils.ts',
    'Refactor the pricing calculation so discounts apply before tax',
  ]) {
    await ask($, text)
  }
  expect(r.calls).toEqual([])
  expect(r.submitted.every(s => s.context.length === 0)).toBe(true)
})

test('disabled mode: no lookups, no context, no blocking', { options: { mode: 'disabled' } }, async ($, on) => {
  const r = rig(on, { '/proj/package.json': NEXT_PKG })
  on('tool.call', () => ({ result: {} }))
  await start($)
  await ask($, 'Add middleware to my Next.js app')
  const edit = await $.tool.call({ tool: 'Edit', file_path: '/proj/a.ts', old_string: 'a', new_string: 'b' })
  expect(r.calls).toEqual([])
  expect(edit.deny).toBeUndefined()
})

// ---------------------------------------------------------------- missing MCP connection

test('missing MCP: falls back, then degrades gracefully, never losing the prompt', async ($, on) => {
  const r = rig(on, { '/proj/package.json': NEXT_PKG })
  r.mcp.handler = down
  await start($)
  await ask($, 'Add middleware to my Next.js app')

  expect(r.calls.map(c => c.server)).toEqual([PRIMARY, FALLBACK]) // the other existing server was tried
  expect(r.submitted[0]?.text).toBe('Add middleware to my Next.js app')
  expect(contextOf(r)).toContain('No documentation could be retrieved')
  expect(contextOf(r)).toContain('mcp_unavailable')
  expect(contextOf(r)).not.toContain('/vercel/next.js') // nothing invented
  expect(r.statuses.at(-1)).toMatch(/✗ mcp_unavailable/)
  expect(r.toasts.at(-1)).toContain('Next.js')

  // circuit breaker: the next prompt does not wait on a server known to be down
  const before = r.calls.length
  await ask($, 'Add an API route to my Next.js app')
  expect(r.calls.length).toBe(before)
})

test('the fallback server answers when the primary is down', async ($, on) => {
  const r = rig(on, { '/proj/package.json': NEXT_PKG })
  r.mcp.handler = c => {
    if (c.server === PRIMARY) return down()
    return { content: [{ type: 'text', text: c.tool === 'resolve-library-id' ? '' : 'FALLBACK DOCS' }], isError: false }
  }
  // resolve through the fallback needs a real answer
  const base = r.mcp.handler
  r.mcp.handler = c =>
    c.server !== PRIMARY && c.tool === 'resolve-library-id'
      ? { content: [{ type: 'text', text: '- Title: Next.js\n- Context7-compatible library ID: /vercel/next.js\n- Versions: v14.2.35' }], isError: false }
      : base(c)
  await start($)
  await ask($, 'Add middleware to my Next.js app')
  expect(contextOf(r)).toContain('FALLBACK DOCS')
  expect(contextOf(r)).toContain(FALLBACK)
})

// ---------------------------------------------------------------- failed lookups

test('an unmatched library is unsupported: no query-docs, no invented ID', async ($, on) => {
  const r = rig(on, { '/proj/package.json': NEXT_PKG })
  // 1. resolve answers with libraries that do not match: unsupported, and no query-docs is attempted
  r.mcp.handler = c => ({ content: [{ type: 'text', text: c.tool === 'resolve-library-id' ? 'Available Libraries:\n\n- Title: Something Unrelated\n- Context7-compatible library ID: /other/thing\n- Source Reputation: Low' : 'x' }], isError: false })
  await start($)
  await ask($, 'Add middleware to my Next.js app')
  expect(r.calls.map(c => c.tool)).toEqual(['resolve-library-id'])
  expect(r.statuses.at(-1)).toMatch(/Next\.js.*–/)
  expect(contextOf(r)).toContain('unsupported')
  expect(contextOf(r)).not.toContain('/other/thing')
})

test('a failing query-docs is a failed lookup, not a crash', async ($, on) => {
  const r = rig(on, { '/proj/package.json': NEXT_PKG })
  r.mcp.handler = c =>
    c.tool === 'query-docs' ? { content: [{ type: 'text', text: 'Internal server error' }], isError: true } : { content: [{ type: 'text', text: '- Title: Next.js\n- Context7-compatible library ID: /vercel/next.js\n- Versions: v14.2.35' }], isError: false }
  await start($)
  await ask($, 'Add middleware to my Next.js app')
  expect(r.statuses.at(-1)).toMatch(/Next\.js@14\.2\.3.* failed/)
  expect(contextOf(r)).toContain('failed')
  expect(r.submitted).toHaveLength(1)
})

test('a rate limit starts a cooldown instead of hammering the server', async ($, on) => {
  const r = rig(on, { '/proj/package.json': NEXT_PKG })
  r.mcp.handler = () => ({ content: [{ type: 'text', text: '429 Too Many Requests' }], isError: true })
  await start($)
  await ask($, 'Add middleware to my Next.js app')
  expect(r.calls).toHaveLength(1) // a rate limit is not retried on the other server
  expect(r.statuses.at(-1)).toMatch(/rate_limited/)
  await ask($, 'Add an API route to my Next.js app')
  expect(r.calls).toHaveLength(1)
  r.clock.now += 61_000 // cooldown over
  r.mcp.handler = defaultMcp
  await ask($, 'Add a server action to my Next.js app')
  expect(r.statuses.at(-1)).toMatch(/Next\.js@v14\.2\.35✓/)
})

test('a hung server times out', { options: { timeoutMs: 1000 } }, async ($, on) => {
  const r = rig(on, { '/proj/package.json': NEXT_PKG })
  r.timer.fires = true
  r.mcp.handler = () => new Promise(() => undefined) as never
  await start($)
  await ask($, 'Add middleware to my Next.js app')
  expect(r.statuses.at(-1)).toMatch(/timeout/)
  expect(r.submitted).toHaveLength(1)
})

// ---------------------------------------------------------------- strict mode

const EDIT = { tool: 'Edit', file_path: '/proj/src/app.ts', old_string: 'a', new_string: 'b' } as const

test('strict: code edits are blocked while docs are missing, allowed once docs arrive', { options: { mode: 'strict' } }, async ($, on) => {
  const r = rig(on, { '/proj/package.json': NEXT_PKG })
  on('tool.call', () => ({ result: {} }))
  r.mcp.handler = down
  await start($)
  await ask($, 'Add middleware to my Next.js app')

  const blocked = await $.tool.call(EDIT)
  expect(blocked.deny).toContain('strict')
  expect(blocked.deny).toContain('Next.js')
  expect(blocked.deny).toContain('mcp__plugin_context7_context7__query-docs')
  expect((await $.tool.call({ tool: 'Write', file_path: '/proj/src/new.py', content: 'x' })).deny).toBeDefined()

  // non-code files are never gated
  expect((await $.tool.call({ tool: 'Edit', file_path: '/proj/notes.md', old_string: 'a', new_string: 'b' })).deny).toBeUndefined()

  // the model fetches the docs itself: that satisfies the requirement
  await $.tool.call({ tool: QUERY_DOCS, libraryId: '/vercel/next.js/v14.2.35', query: 'middleware redirects' })
  expect((await $.tool.call(EDIT)).deny).toBeUndefined()
  expect(r.statuses.at(-1)).toMatch(/Next\.js.*✓/)
})

test('strict: a failed model-side lookup does not unlock edits', { options: { mode: 'strict' } }, async ($, on) => {
  const r = rig(on, { '/proj/package.json': NEXT_PKG })
  on('tool.call', (_, e) => (e.tool === QUERY_DOCS ? { result: { content: [{ type: 'text', text: 'boom' }] }, isError: true } : { result: {} }))
  r.mcp.handler = down
  await start($)
  await ask($, 'Add middleware to my Next.js app')
  await $.tool.call({ tool: QUERY_DOCS, libraryId: '/vercel/next.js', query: 'x' })
  expect((await $.tool.call(EDIT)).deny).toBeDefined()
})

test('strict: docs retrieved by the mod unlock edits at once; unsupported libraries never deadlock', { options: { mode: 'strict' } }, async ($, on) => {
  const r = rig(on, { '/proj/package.json': NEXT_PKG })
  on('tool.call', () => ({ result: {} }))
  await start($)
  await ask($, 'Add middleware to my Next.js app')
  expect((await $.tool.call(EDIT)).deny).toBeUndefined()

  r.store.clear()
  r.mcp.handler = c =>
    c.tool === 'resolve-library-id'
      ? { content: [{ type: 'text', text: 'Available Libraries:\n\n- Title: Other\n- Context7-compatible library ID: /o/o' }], isError: false }
      : down()
  await ask($, 'Add middleware to my Next.js app, again')
  expect((await $.tool.call(EDIT)).deny).toBeUndefined() // nothing the model could ever retrieve
})

test('strict: /context7 bypass waives the requirement for the task; a task without libraries is never blocked', { options: { mode: 'strict' } }, async ($, on) => {
  const r = rig(on, { '/proj/package.json': NEXT_PKG })
  on('tool.call', () => ({ result: {} }))
  r.mcp.handler = down
  await start($)
  await ask($, 'Add middleware to my Next.js app')
  expect((await $.tool.call(EDIT)).deny).toBeDefined()

  const out = await $.command.run({ command: 'context7', args: 'bypass', origin: { kind: 'composer' } } as never)
  expect(String((out as { text?: string }).text)).toContain('waived')
  expect((await $.tool.call(EDIT)).deny).toBeUndefined()

  await ask($, 'Refactor the pricing calculation so discounts apply before tax')
  expect((await $.tool.call(EDIT)).deny).toBeUndefined()
})

test('advisory mode never blocks edits', async ($, on) => {
  const r = rig(on, { '/proj/package.json': NEXT_PKG })
  on('tool.call', () => ({ result: {} }))
  r.mcp.handler = down
  await start($)
  await ask($, 'Add middleware to my Next.js app')
  expect((await $.tool.call(EDIT)).deny).toBeUndefined()
})

// ---------------------------------------------------------------- multiple libraries

test('several libraries in one task: each resolved, versioned and tracked', async ($, on) => {
  const r = rig(on, { '/proj/package.json': MANY_PKG })
  await start($)
  await ask($, 'Build a signup form with Next.js, Prisma and Zod validation, storing users in the database')

  const resolved = r.calls.filter(c => c.tool === 'resolve-library-id').map(c => String(c.args['libraryName']))
  expect(resolved.sort()).toEqual(['Next.js', 'Prisma', 'Zod'])
  const queried = r.calls.filter(c => c.tool === 'query-docs').map(c => String(c.args['libraryId']))
  expect(queried).toContain('/vercel/next.js/v14.2.35')
  expect(queried).toContain('/colinhacks/zod/v3.23.8')
  const ctx = contextOf(r)
  expect(ctx).toContain('DOCS for /vercel/next.js/v14.2.35')
  expect(ctx).toContain('DOCS for /colinhacks/zod/v3.23.8')
  expect(r.statuses.at(-1)).toMatch(/Next\.js.*Zod|zod/i)

  const status = await $.command.run({ command: 'context7', args: '', origin: { kind: 'composer' } } as never)
  expect(String((status as { text?: string }).text)).toContain('/colinhacks/zod/v3.23.8')
})

test('maxLibraries caps the lookups and says what was skipped', { options: { maxLibraries: 2 } }, async ($, on) => {
  const r = rig(on, { '/proj/package.json': MANY_PKG })
  await start($)
  await ask($, 'Build a signup form with Next.js, Prisma and Zod validation')
  expect(r.calls.filter(c => c.tool === 'query-docs')).toHaveLength(2)
  const status = await $.command.run({ command: 'context7', args: '', origin: { kind: 'composer' } } as never)
  expect(String((status as { text?: string }).text)).toContain('skipped')
})

// ---------------------------------------------------------------- cache

test('a repeated lookup is served from the cache until it expires', { options: { cacheTtlHours: 1 } }, async ($, on) => {
  const r = rig(on, { '/proj/package.json': NEXT_PKG })
  await start($)
  await ask($, 'Add middleware to my Next.js app')
  const first = r.calls.length
  expect(first).toBe(2)
  await ask($, 'Add middleware to my Next.js app')
  expect(r.calls.length).toBe(first)
  expect(contextOf(r)).toContain('cache')
  expect(r.statuses.at(-1)).toMatch(/Next\.js@v14\.2\.35✓/)

  r.clock.now += 61 * 60_000 // past the one-hour lifetime
  await ask($, 'Add middleware to my Next.js app')
  expect(r.calls.length).toBe(first + 2)
})

test('cacheTtlHours 0 disables the cache; failures are never cached', { options: { cacheTtlHours: 0 } }, async ($, on) => {
  const r = rig(on, { '/proj/package.json': NEXT_PKG })
  await start($)
  await ask($, 'Add middleware to my Next.js app')
  await ask($, 'Add middleware to my Next.js app')
  expect(r.calls).toHaveLength(4)
})

test('failures are not cached', async ($, on) => {
  const r = rig(on, { '/proj/package.json': NEXT_PKG })
  r.mcp.handler = c => (c.tool === 'query-docs' ? { content: [{ type: 'text', text: 'Internal server error' }], isError: true } : defaultMcp(c))
  await start($)
  await ask($, 'Add middleware to my Next.js app')
  r.mcp.handler = defaultMcp
  await ask($, 'Add middleware to my Next.js app')
  expect(contextOf(r)).toContain('DOCS for')
})

// ---------------------------------------------------------------- subagents

test('a subagent is handed the task documentation and its own libraries', async ($, on) => {
  const r = rig(on, { '/proj/package.json': NEXT_PKG })
  const spawned: string[] = []
  on('agent.spawn', (_, e) => {
    spawned.push(e.prompt)
    return { model: 'm', agentId: 'a1' }
  })
  await start($)
  await ask($, 'Add middleware to my Next.js app')
  await $.agent.spawn(spawnArgs('Implement the redirect in middleware.ts using Next.js and zod'))

  expect(spawned).toHaveLength(1)
  expect(spawned[0]).toContain('Implement the redirect in middleware.ts')
  expect(spawned[0]).toContain('DOCS for /vercel/next.js/v14.2.35')
  expect(spawned[0]).toContain('DOCS for /colinhacks/zod/v3.23.8')
})

test('a subagent with a project-only task gets nothing extra', async ($, on) => {
  const r = rig(on, { '/proj/package.json': NEXT_PKG })
  const spawned: string[] = []
  on('agent.spawn', (_, e) => {
    spawned.push(e.prompt)
    return { model: 'm' }
  })
  await start($)
  await $.agent.spawn(spawnArgs('Read src/pricing.ts and summarise the discount rules'))
  expect(r.calls).toEqual([])
  expect(spawned[0]).toBe('Read src/pricing.ts and summarise the discount rules')
})

// ---------------------------------------------------------------- review findings

test('a rejected mcp.call (no protocol answer) counts as unreachable: fallback tried, cooldown starts', async ($, on) => {
  const r = rig(on, { '/proj/package.json': NEXT_PKG })
  r.mcp.handler = () => {
    throw new Error('Unknown MCP server: plugin:context7:context7') // the kit turns a throw into a rejected call
  }
  await start($)
  await ask($, 'Add middleware to my Next.js app')
  expect(r.calls.map(c => c.server)).toEqual([PRIMARY, FALLBACK])
  expect(r.statuses.at(-1)).toMatch(/mcp_unavailable/)
  await ask($, 'Add an API route to my Next.js app')
  expect(r.calls).toHaveLength(2)
})

test('prompts that merely contain git/navigation/comment words still get documentation', async ($, on) => {
  const r = rig(on, { '/proj/package.json': JSON.stringify({ dependencies: { express: '4.19.2', firebase: '10.0.0', '@prisma/client': '6.1.0', '@supabase/supabase-js': '2.0.0' } }) })
  on('tool.call', () => ({ result: {} }))
  await start($)
  const prompts = [
    'Push notifications with Firebase Cloud Messaging for the web app',
    'Find the Prisma syntax for a many-to-many relation',
    'Open a WebSocket with Socket.IO in Express',
    'Add a comment section using Supabase realtime',
  ]
  for (const text of prompts) {
    const before = r.calls.length
    await ask($, text)
    expect(r.calls.length).toBeGreaterThan(before)
  }
})

test('git operations with git vocabulary are still skipped', async ($, on) => {
  const r = rig(on, { '/proj/package.json': NEXT_PKG })
  await start($)
  for (const text of ['push the Next.js branch to origin', 'git rebase onto main for the react app', 'merge the PR for the Next.js upgrade']) await ask($, text)
  expect(r.calls).toEqual([])
})

test('a multi-line PEP 621 pyproject pins the version', async ($, on) => {
  const r = rig(on, { '/proj/pyproject.toml': '[project]\nname = "x"\ndependencies = [\n  "fastapi>=0.110",\n  "uvicorn[standard]==0.30.1",\n]\n\n[project.optional-dependencies]\ndev = [\n  "pytest>=8",\n]\n' })
  r.mcp.handler = c =>
    c.tool === 'resolve-library-id'
      ? { content: [{ type: 'text', text: 'Available Libraries:\n\n- Title: FastAPI\n- Context7-compatible library ID: /fastapi/fastapi\n- Source Reputation: High\n- Versions: 0.110.0, 0.115.0' }], isError: false }
      : defaultMcp(c)
  await start($)
  await ask($, 'Add a dependency-injected endpoint to my FastAPI app')
  const status = await $.command.run({ command: 'context7', args: '', origin: { kind: 'composer' } } as never)
  expect(String((status as { text?: string }).text)).toContain('fastapi wants 0.110')
  expect(r.calls[1]?.args['libraryId']).toBe('/fastapi/fastapi/0.110.0')
  expect(r.calls[1]?.args['language']).toBe('Python')
})
