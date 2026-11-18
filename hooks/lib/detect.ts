import type { Candidate, Dep } from './types'

// ---------------------------------------------------------------- skip rules

// "push", "tag", "merge" are common verbs ("push notifications"), so a bare one only counts next to git words.
const GIT_VOCAB = /\b(?:git|branch(?:es)?|commits?|pull\s+request|pr|remote|origin|upstream|staged|stash|rebase|cherry-pick|repo(?:sitory)?)\b/i
const GIT_VERB = /^\s*(?:please\s+)?(?:git\s|(?:commit|push|pull|merge|rebase|stash|checkout|cherry-pick|squash|amend|tag|stage|unstage)\b)/i
const NAV = /^\s*(?:please\s+)?(?:ls|cd|pwd|cat|tree|head|tail|where\s+(?:is|are)|which\s+file|go\s+to|navigate\s+to|jump\s+to)\b/i
const SIMPLE_TEXT =
  /\b(?:typo|re-?word|wording|spelling|grammar|capitali[sz]e|whitespace|indent(?:ation)?|changelog|readme|license|lint\s+fix|prettier|reformat)\b|\brename\b/i
// Words that mean "I need to know how a library behaves", which outvote SIMPLE_TEXT.
const STRONG_INTENT =
  /\b(?:implement|migrate|upgrade|integrat\w*|configure|set\s?up|install|how\s+(?:do|to|can|does)|api|deprecat\w*|middleware|hook|endpoint|auth\w*)\b/i

/** Why this prompt needs no documentation lookup, or undefined when it might. */
export function skipReason(prompt: string): string | undefined {
  const text = prompt.trim()
  if (text.length < 8) return 'too-short'
  if (/^\s*(?:please\s+)?git\s/i.test(text) || (GIT_VERB.test(text) && GIT_VOCAB.test(text))) return 'git'
  if (NAV.test(text)) return 'navigation'
  if (SIMPLE_TEXT.test(text) && !STRONG_INTENT.test(text)) return 'simple-text-change'
  return undefined
}

// ------------------------------------------------------------ known aliases

type Alias = { re: RegExp; display: string; deps: string[]; language?: string }

const A = (re: RegExp, display: string, deps: string[], language?: string): Alias => ({
  re,
  display,
  deps,
  ...(language ? { language } : {}),
})

// Names Claude users type for popular frameworks. Only a *name* for the search:
// the library ID always comes from Context7's own resolve-library-id answer.
const ALIASES: readonly Alias[] = [
  A(/\bnext\.?js\b/i, 'Next.js', ['next']),
  A(/\breact\b/i, 'React', ['react']),
  A(/\bvue(?:\.?js)?\b/i, 'Vue.js', ['vue']),
  A(/\bnuxt\b/i, 'Nuxt', ['nuxt']),
  A(/\bsvelte(?:kit)?\b/i, 'Svelte', ['svelte', '@sveltejs/kit']),
  A(/\bangular\b/i, 'Angular', ['@angular/core']),
  A(/\btailwind(?:css)?\b/i, 'Tailwind CSS', ['tailwindcss']),
  A(/\bprisma\b/i, 'Prisma', ['prisma', '@prisma/client']),
  A(/\bdrizzle\b/i, 'Drizzle ORM', ['drizzle-orm']),
  A(/\bexpress(?:\.?js)?\b/i, 'Express', ['express']),
  A(/\bfastify\b/i, 'Fastify', ['fastify']),
  A(/\bnest(?:js)?\b(?=.*\b(?:module|controller|provider|guard|decorator)\b)/i, 'NestJS', ['@nestjs/core']),
  A(/\bdjango\b/i, 'Django', ['django'], 'Python'),
  A(/\bflask\b/i, 'Flask', ['flask'], 'Python'),
  A(/\bfastapi\b/i, 'FastAPI', ['fastapi'], 'Python'),
  A(/\bpydantic\b/i, 'Pydantic', ['pydantic'], 'Python'),
  A(/\bsqlalchemy\b/i, 'SQLAlchemy', ['sqlalchemy'], 'Python'),
  A(/\bpandas\b/i, 'pandas', ['pandas'], 'Python'),
  A(/\bnumpy\b/i, 'NumPy', ['numpy'], 'Python'),
  A(/\bpytorch\b/i, 'PyTorch', ['torch'], 'Python'),
  A(/\btensorflow\b/i, 'TensorFlow', ['tensorflow'], 'Python'),
  A(/\blangchain\b/i, 'LangChain', ['langchain', '@langchain/core'], 'Python'),
  A(/\bspring\s+boot\b/i, 'Spring Boot', [], 'Java'),
  A(/\blaravel\b/i, 'Laravel', ['laravel/framework'], 'PHP'),
  A(/\bsupabase\b/i, 'Supabase', ['@supabase/supabase-js']),
  A(/\bzod\b/i, 'Zod', ['zod']),
  A(/\btrpc\b/i, 'tRPC', ['@trpc/server']),
  A(/\bvite\b/i, 'Vite', ['vite']),
  A(/\bwebpack\b/i, 'webpack', ['webpack']),
  A(/\bvitest\b/i, 'Vitest', ['vitest']),
  A(/\bjest\b/i, 'Jest', ['jest']),
  A(/\bplaywright\b/i, 'Playwright', ['@playwright/test', 'playwright']),
  A(/\bcypress\b/i, 'Cypress', ['cypress']),
  A(/\baxios\b/i, 'Axios', ['axios']),
  A(/\bredux(?:\s+toolkit)?\b/i, 'Redux Toolkit', ['@reduxjs/toolkit', 'redux']),
  A(/\b(?:tanstack|react)[\s-]query\b/i, 'TanStack Query', ['@tanstack/react-query']),
  A(/\bmongoose\b/i, 'Mongoose', ['mongoose']),
  A(/\bgraphql\b/i, 'GraphQL', ['graphql']),
  A(/\bstripe\b/i, 'Stripe', ['stripe']),
  A(/\bfirebase\b/i, 'Firebase', ['firebase']),
  A(/\bcobra\b/i, 'Cobra', ['github.com/spf13/cobra'], 'Go'),
  A(/\btokio\b/i, 'Tokio', ['tokio'], 'Rust'),
  A(/\bserde\b/i, 'Serde', ['serde'], 'Rust'),
]

// Manifest names that are also everyday words: only count them when quoted in backticks.
const COMMON_WORDS = new Set([
  'next', 'rich', 'click', 'black', 'mock', 'chi', 'gin', 'echo', 'fiber', 'rocket', 'log', 'time', 'path', 'url',
  'open', 'fire', 'tower', 'hyper', 'base', 'core', 'cors', 'json', 'yaml', 'tqdm', 'six', 'attrs',
])

const NODE_BUILTINS = new Set([
  'fs', 'path', 'os', 'http', 'https', 'url', 'util', 'crypto', 'stream', 'events', 'child_process', 'assert',
  'buffer', 'zlib', 'net', 'tls', 'dns', 'readline', 'process', 'module', 'vm', 'worker_threads', 'timers',
])

/** Programming language a manifest implies, for query-docs's `language` (JS/TS is left to Context7). */
const LANG: Record<string, string> = {
  'requirements.txt': 'Python',
  'pyproject.toml': 'Python',
  'go.mod': 'Go',
  'Cargo.toml': 'Rust',
  'composer.json': 'PHP',
  Gemfile: 'Ruby',
}
const langOf = (manifest?: string): { language?: string } => (manifest && LANG[manifest] ? { language: LANG[manifest] } : {})

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const mentions = (prompt: string, name: string, needsTicks: boolean): boolean => {
  const n = escape(name)
  if (needsTicks) return new RegExp('`' + n + '`', 'i').test(prompt)
  return new RegExp('(?:^|[^\\w@/.-])' + n + '(?![\\w-])', 'i').test(prompt)
}

/** `react-dom/client` -> `react-dom`; `@scope/pkg/sub` -> `@scope/pkg`. */
const packageOf = (spec: string): string => {
  const p = spec.split('/')
  return spec.startsWith('@') ? p.slice(0, 2).join('/') : (p[0] ?? spec)
}

const importedPackages = (prompt: string): string[] => {
  const found = new Set<string>()
  const add = (spec: string | undefined) => {
    if (!spec || spec.startsWith('node:') || spec.startsWith('.')) return
    const pkg = packageOf(spec)
    if (pkg && !NODE_BUILTINS.has(pkg)) found.add(pkg)
  }
  for (const m of prompt.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)) add(m[1])
  for (const m of prompt.matchAll(/require\(\s*['"]([^'"]+)['"]/g)) add(m[1])
  for (const m of prompt.matchAll(/\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add)\s+((?:@?[\w./-]+\s*)+)/g))
    for (const s of (m[1] ?? '').split(/\s+/)) if (s && !s.startsWith('-')) add(s)
  for (const m of prompt.matchAll(/\bpip3?\s+install\s+([\w.-]+)/g)) add(m[1])
  return [...found]
}

/**
 * Libraries a prompt depends on: named in the prompt AND, when a manifest lists
 * them, version-pinned from it. A prompt that names no library yields none, so
 * project-only tasks never trigger a lookup.
 */
export function findCandidates(prompt: string, deps: ReadonlyMap<string, Dep>): Candidate[] {
  const out = new Map<string, Candidate>()
  const put = (c: Candidate) => {
    const prev = out.get(c.key)
    if (!prev) out.set(c.key, c)
    else if (!prev.version && c.version) out.set(c.key, { ...prev, version: c.version, manifest: c.manifest })
  }
  const dep = (name: string): Dep | undefined => deps.get(name.toLowerCase())

  // 1. dependencies the prompt names verbatim
  for (const d of deps.values()) {
    const risky = COMMON_WORDS.has(d.name.toLowerCase()) || d.name.length < 4
    if (mentions(prompt, d.name, risky)) {
      put({
        key: d.name.toLowerCase(),
        display: d.name,
        ...(d.version ? { version: d.version } : {}),
        manifest: d.manifest,
        source: 'manifest',
        ...langOf(d.manifest),
      })
    }
  }

  // 2. well-known framework names; version from the manifest when it lists one
  for (const a of ALIASES) {
    if (!a.re.test(prompt)) continue
    const listed = a.deps.map(dep).find((x): x is Dep => x !== undefined)
    // A listed dependency already covered by step 1 keeps its own display name.
    if (listed && out.has(listed.name.toLowerCase())) continue
    put({
      key: a.display.toLowerCase(),
      display: a.display,
      ...(listed?.version ? { version: listed.version } : {}),
      ...(listed ? { manifest: listed.manifest } : {}),
      source: 'alias',
      ...(a.language ? { language: a.language } : langOf(listed?.manifest)),
    })
  }

  // 3. packages the prompt imports or installs explicitly
  for (const pkg of importedPackages(prompt)) {
    const listed = dep(pkg)
    put({
      key: pkg.toLowerCase(),
      display: pkg,
      ...(listed?.version ? { version: listed.version } : {}),
      ...(listed ? { manifest: listed.manifest } : {}),
      source: 'import',
      ...langOf(listed?.manifest),
    })
  }
  return [...out.values()]
}

// ------------------------------------------------------------ manifest parse

/** `^14.2.3` -> `14.2.3`; `>=1.0,<2` -> `1.0`; `workspace:*` / `latest` -> undefined. */
export function cleanVersion(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const m = /(\d+(?:\.\d+){0,2})/.exec(raw)
  return m?.[1]
}

const add = (deps: Map<string, Dep>, name: string, version: unknown, manifest: string) => {
  const v = cleanVersion(version)
  deps.set(name.toLowerCase(), { name, ...(v ? { version: v } : {}), manifest })
}

function parsePackageJson(text: string, deps: Map<string, Dep>) {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return
  }
  if (typeof json !== 'object' || json === null) return
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const block = (json as Record<string, unknown>)[field]
    if (typeof block === 'object' && block !== null)
      for (const [n, v] of Object.entries(block)) add(deps, n, v, 'package.json')
  }
}

function parseRequirements(text: string, deps: Map<string, Dep>) {
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*(?:[=~<>!]=?|@)?\s*([^;#\s]*)/.exec(line)
    if (m && !line.trim().startsWith('-') && !line.trim().startsWith('#')) add(deps, m[1] ?? '', m[2], 'requirements.txt')
  }
}

function parsePyproject(text: string, deps: Map<string, Dep>) {
  let inTable = false // [tool.poetry.dependencies], [project.optional-dependencies] ...
  let inArray = false // dependencies = [ ... ] possibly spanning several lines
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trim()
    if (line.startsWith('[') && !inArray) {
      inTable = /dependencies\]$/.test(line)
      continue
    }
    if (!inArray && /^[\w.-]+\s*=\s*\[/.test(line) && (inTable || /^(?:optional-)?dependencies\s*=/.test(line))) inArray = true
    if (inArray) {
      // PEP 508 strings: "requests>=2.31", "uvicorn[standard]==0.30"
      for (const m of line.matchAll(/"([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*([<>=~!][^";]*)?/g)) add(deps, m[1] ?? '', m[2], 'pyproject.toml')
      if (/\]\s*,?\s*$/.test(line) && !/=\s*\[\s*$/.test(line)) inArray = false
      continue
    }
    // poetry tables: fastapi = "^0.110"
    const t = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*=\s*(?:"([^"]*)"|\{[^}]*version\s*=\s*"([^"]*)")/.exec(line)
    if (inTable && t && t[1] !== 'python') add(deps, t[1] ?? '', t[2] ?? t[3], 'pyproject.toml')
  }
}

function parseGoMod(text: string, deps: Map<string, Dep>) {
  for (const m of text.matchAll(/^\s*(?:require\s+)?([\w.-]+\.[\w.-]+\/[^\s]+)\s+v([\d.]+)/gm)) add(deps, m[1] ?? '', m[2], 'go.mod')
}

function parseCargo(text: string, deps: Map<string, Dep>) {
  let inDeps = false
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('[')) inDeps = /dependencies\]$/.test(line)
    const m = /^([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]*)"|\{[^}]*version\s*=\s*"([^"]*)")/.exec(line)
    if (inDeps && m) add(deps, m[1] ?? '', m[2] ?? m[3], 'Cargo.toml')
  }
}

function parseComposer(text: string, deps: Map<string, Dep>) {
  try {
    const json = JSON.parse(text) as Record<string, unknown>
    for (const field of ['require', 'require-dev']) {
      const block = json[field]
      if (typeof block === 'object' && block !== null)
        for (const [n, v] of Object.entries(block)) if (n !== 'php') add(deps, n, v, 'composer.json')
    }
  } catch {
    /* unreadable manifest: no deps from it */
  }
}

function parseGemfile(text: string, deps: Map<string, Dep>) {
  for (const m of text.matchAll(/^\s*gem\s+['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/gm)) add(deps, m[1] ?? '', m[2], 'Gemfile')
}

export const MANIFESTS: ReadonlyArray<readonly [string, (t: string, d: Map<string, Dep>) => void]> = [
  ['package.json', parsePackageJson],
  ['requirements.txt', parseRequirements],
  ['pyproject.toml', parsePyproject],
  ['go.mod', parseGoMod],
  ['Cargo.toml', parseCargo],
  ['composer.json', parseComposer],
  ['Gemfile', parseGemfile],
]
