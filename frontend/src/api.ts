import type { CatalogGame } from './settings'

export interface StoredRequest {
  id: string
  token: string // one-time delete token. Only its hash exists on the server.
  kind: 'public' | 'private'
  title: string
  created: string
}

const K_REQS = 'rgap.requests'
export const keyStorageName = (id: string) => `rgap.key.${id}`

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}
function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage unavailable */
  }
}

export const loadRequests = (): StoredRequest[] => read<StoredRequest[]>(K_REQS, [])
export const rememberRequest = (r: StoredRequest) => write(K_REQS, [...loadRequests(), r])
export function forgetRequest(id: string) {
  write(K_REQS, loadRequests().filter((r) => r.id !== id))
  try {
    localStorage.removeItem(keyStorageName(id))
  } catch {
    /* nothing to remove */
  }
}

/** POST JSON to the local patcher and return the parsed answer, or throw an Error with a message a person can act on. */
export async function patcherPost<T = Record<string, unknown>>(base: string, path: string, body: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  } catch {
    throw new Error('Could not reach the local patcher. Make sure the app is running (the black window must stay open).')
  }
  const data = (await res.json().catch(() => null)) as (T & { detail?: unknown }) | null
  if (!res.ok || !data) {
    const detail = data && typeof data.detail === 'string' ? data.detail : data && Array.isArray(data.detail) ? 'The request was not valid.' : `The patcher answered with an error (HTTP ${res.status}).`
    throw new Error(detail)
  }
  return data
}

/** The game catalogue lives inside the local patcher, so the core of the app works without any internet service. */
export async function fetchCatalog(patcherUrl: string): Promise<CatalogGame[]> {
  let res: Response
  try {
    res = await fetch(`${patcherUrl}/api/games`)
  } catch {
    throw new Error('Could not reach the local patcher.')
  }
  if (!res.ok) throw new Error(`Catalogue request failed (HTTP ${res.status}).`)
  const data = (await res.json()) as {
    games: {
      id: string
      name: string
      year: string
      blurb: string
      exe_names: string[]
      has_plan: boolean
      file_fixes: number
      compat: { recommended: string[]; optional: string[] }
      launch_notes: string[]
    }[]
  }
  return data.games.map((g) => ({
    id: g.id,
    name: g.name,
    year: g.year,
    blurb: g.blurb,
    exeNames: g.exe_names,
    hasPlan: g.has_plan,
    fixCount: g.file_fixes,
    compat: g.compat,
    launchNotes: g.launch_notes,
  }))
}

/** Asks the server to erase every help request this device made. Reads local data synchronously, then calls out. */
export async function deleteAllRemote(base: string): Promise<void> {
  const requests = loadRequests()
  await Promise.allSettled(
    requests.map((r) =>
      fetch(`${base}/api/requests/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: r.id, delete_token: r.token }),
      }),
    ),
  )
}

/* The same scrubbing rules the server enforces, used here to preview exactly what will be sent. */
const SCRUBBERS: [RegExp, string][] = [
  [/[A-Za-z]:\\[^\s"'<>|]*/g, '[path removed]'],
  [/\\\\[^\s"'<>|]+/g, '[path removed]'],
  [/\/(?:home|Users)\/[^\s"']+/g, '[path removed]'],
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email removed]'],
  [/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '[ip removed]'],
  [/https?:\/\/\S+/g, '[link removed]'],
]
export const scrub = (text: string): string => SCRUBBERS.reduce((t, [re, to]) => t.replace(re, to), text).trim()
export const PIRACY = /\b(cracks?|cracked|keygen|no[- ]?cd|warez|torrents?|pirat\w*|serial keys?|bypass\w* (?:drm|copy protection)|drm removal)\b/i
