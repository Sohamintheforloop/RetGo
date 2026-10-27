/**
 * Settings storage and validation.
 *
 * Everything here lives only in this browser profile on the user's own device (localStorage).
 * "Delete my data" removes every key listed in KEYS via clearSettingsStorage().
 */

/** A game the user manages. `group` is the user-named sub-tab it belongs to ('' = none). */
export interface ManagedGame {
  uid: string
  name: string
  /** API Search ID, e.g. "max_payne". Only IDs present in the reviewed catalogue can be patched. */
  apiId: string
  /** Absolute Windows path to the game's .exe. Stays on this device; only the local patcher ever receives it. */
  exePath: string
  group: string
}

/** A game from the catalogue served by the local patcher. */
export interface CatalogGame {
  id: string
  name: string
  year: string
  blurb: string
  exeNames: string[]
  /** True only for the demo game: an AI patch plan exists. Real games have none until a maintainer verifies offsets. */
  hasPlan: boolean
  /** Number of reviewed file fixes (fix packs) available. */
  fixCount: number
  compat: { recommended: string[]; optional: string[] }
  launchNotes: string[]
}

export const KEYS = {
  games: 'patcher_games',
  groups: 'patcher_groups',
  apiKey: 'patcher_api_key',
  autoBackup: 'patcher_auto_backup',
} as const

function get(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/** Writes a value, or removes the key when value is null. Never throws. */
export function put(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    /* storage unavailable: the app keeps working in memory */
  }
}

function isManagedGame(v: unknown): v is ManagedGame {
  const o = v as Record<string, unknown> | null
  return (
    !!o &&
    typeof o.uid === 'string' &&
    typeof o.name === 'string' &&
    typeof o.apiId === 'string' &&
    typeof o.exePath === 'string' &&
    typeof o.group === 'string'
  )
}

export function loadGames(): ManagedGame[] {
  try {
    const value: unknown = JSON.parse(get(KEYS.games) ?? '[]')
    return Array.isArray(value) ? value.filter(isManagedGame) : []
  } catch {
    return []
  }
}

export function loadGroups(): string[] {
  try {
    const value: unknown = JSON.parse(get(KEYS.groups) ?? '[]')
    return Array.isArray(value) ? value.filter((g): g is string => typeof g === 'string') : []
  } catch {
    return []
  }
}

export const loadApiKey = (): string => get(KEYS.apiKey) ?? ''

/** Backups are ON unless the user has explicitly turned them off. */
export const loadAutoBackup = (): boolean => get(KEYS.autoBackup) !== 'false'

export function clearSettingsStorage() {
  Object.values(KEYS).forEach((k) => put(k, null))
}

/* ------------------------------- Validation -------------------------------- */
export const GROQ_KEY_RE = /^gsk_[A-Za-z0-9_-]{20,200}$/

export const fileName = (path: string): string => path.split(/[\\/]/).pop() ?? path

/** Collapses whitespace and strips control characters from user-chosen labels. */
export const cleanLabel = (text: string): string => text.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim()

/** Each validator returns an error message, or '' when the value is fine. */
export function validateName(value: string): string {
  const v = cleanLabel(value)
  return v.length < 2 || v.length > 60 ? 'Enter a display name of 2 to 60 characters.' : ''
}

/** Quick format check before asking the patcher to look in the folder. Returns an error message, or ''. */
export function validateGamePath(path: string): string {
  const p = path.trim().replace(/^"(.*)"$/, '$1')
  if (p.length > 260) return 'That path is too long.'
  if (!/^[A-Za-z]:\\/.test(p)) return 'Enter the full path starting with a drive letter, for example C:\\Games\\Max Payne. Tip: copy it from the address bar in File Explorer.'
  if (/[<>"|?*]/.test(p) || p.split('\\').includes('..')) return 'The path contains characters that are not allowed.'
  if (/^[A-Za-z]:\\Windows(\\|$)/i.test(p)) return 'Choose your game folder, not something inside the Windows folder.'
  return ''
}

export function validateGroupName(value: string, existing: string[], ignore?: string): string {
  const v = cleanLabel(value)
  if (v.length < 1 || v.length > 30) return 'Enter a tab name of 1 to 30 characters.'
  if (v.toLowerCase() === 'all games') return '"All games" is reserved.'
  if (existing.some((g) => g !== ignore && g.toLowerCase() === v.toLowerCase())) return 'You already have a tab with that name.'
  return ''
}
