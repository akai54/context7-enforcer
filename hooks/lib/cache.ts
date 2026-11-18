import type { Api as Engine } from './types'

const KEY = 'c7e:cache:v1'
const MAX_ENTRIES = 80
const MAX_BYTES = 1_500_000 // $.store holds 4 MiB across all keys

type Entry = { at: number; v: unknown }
type Blob = { entries: Record<string, Entry> }

async function read($: Engine): Promise<Blob> {
  const raw = await $.store.get(KEY)
  if (raw && typeof raw === 'object' && 'entries' in raw && typeof raw.entries === 'object' && raw.entries)
    return raw as Blob
  return { entries: {} }
}

let writes: Promise<unknown> = Promise.resolve()

export async function cacheGet<T>($: Engine, key: string, ttlMs: number): Promise<T | undefined> {
  if (ttlMs <= 0) return undefined
  const hit = (await read($)).entries[key]
  if (!hit || typeof hit.at !== 'number') return undefined
  return (await $.clock.now()) - hit.at <= ttlMs ? (hit.v as T) : undefined
}

/** Successes only. Writes are serialised so parallel lookups cannot lose each other's entry. */
export function cacheSet($: Engine, key: string, value: unknown, ttlMs: number): Promise<unknown> {
  if (ttlMs <= 0) return Promise.resolve()
  writes = writes
    .then(async () => {
      const blob = await read($)
      const now = await $.clock.now()
      blob.entries[key] = { at: now, v: value }
      for (const [k, e] of Object.entries(blob.entries)) if (now - e.at > ttlMs) delete blob.entries[k]
      const oldest = () => Object.entries(blob.entries).sort((a, b) => a[1].at - b[1].at)[0]
      while (Object.keys(blob.entries).length > MAX_ENTRIES || JSON.stringify(blob).length > MAX_BYTES) {
        const o = oldest()
        if (!o || o[0] === key) break
        delete blob.entries[o[0]]
      }
      await $.store.set(KEY, blob)
    })
    .catch(() => undefined) // a cache that cannot write is only a missed saving
  return writes
}

export async function cacheClear($: Engine): Promise<void> {
  await $.store.delete(KEY)
}

export async function cacheStats($: Engine): Promise<{ entries: number; bytes: number }> {
  const blob = await read($)
  return { entries: Object.keys(blob.entries).length, bytes: JSON.stringify(blob).length }
}
