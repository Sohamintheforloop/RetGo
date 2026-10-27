import { useEffect, useRef, useState } from 'react'
import ConsentGate, { type ConsentRecord } from './ConsentGate'
import type { LogLine as PatcherLine } from './Fixes'
import { HelpModal } from './GameModals'
import Settings from './Settings'
import SetupWizard from './Setup'
import { Modal, Spinner } from './ui'
import { deleteAllRemote, fetchCatalog, patcherPost } from './api'
import { clearSettingsStorage, fileName, loadApiKey, loadAutoBackup, loadGames, type CatalogGame, type ManagedGame } from './settings'
import { APP_NAME, POLICY_VERSION, PRIVACY_CLAUSES, TERMS_CLAUSES, type Clause } from './legal'

/* ---------------------------------- Config --------------------------------- */
// The optional online help (AI advice, community) lives in the edge Worker. The core of the app does not need it.
const WORKER_URL = (import.meta.env.VITE_WORKER_URL as string | undefined) || 'http://localhost:8787'
// Packaged: the patcher serves this page, so it is the same address. Development: the page is on 5173, the patcher on 8000.
const PATCHER_URL = (import.meta.env.VITE_PATCHER_URL as string | undefined) || (window.location.port === '5173' ? 'http://localhost:8000' : window.location.origin)

const KEY_CONSENT = 'rgap.consent'
const KEY_THEME = 'rgap.theme'

/* ----------------------------------- Types --------------------------------- */
type LogLevel = 'info' | 'success' | 'skip' | 'warn' | 'abort' | 'error'
interface LogLine {
  id: number
  ts: string
  level: LogLevel
  message: string
}
interface RegistryFix {
  path: string
  name: string
  value: number | string
  type: 'REG_DWORD' | 'REG_SZ'
}
interface HexPatch {
  offset: string
  original: string
  replace: string
}
interface PatchPlan {
  game_id: string
  registry_fixes: RegistryFix[]
  hex_offsets: HexPatch[]
}
interface PatcherResult {
  success: boolean
  logs: { level: LogLevel; message: string; ts?: string }[]
}
interface PermissionRequest {
  game: ManagedGame
  plan: PatchPlan
  backup: boolean
}

/* --------------------------------- Storage --------------------------------- */
const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value)
    } catch {
      /* storage unavailable: keep working in memory */
    }
  },
  clearApp() {
    try {
      Object.keys(localStorage)
        .filter((k) => k.startsWith('rgap.'))
        .forEach((k) => localStorage.removeItem(k))
    } catch {
      /* nothing to clear */
    }
  },
}

function loadConsent(): ConsentRecord | null {
  const raw = store.get(KEY_CONSENT)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as ConsentRecord
    return parsed.version === POLICY_VERSION ? parsed : null
  } catch {
    return null
  }
}

function initialDark(): boolean {
  const saved = store.get(KEY_THEME)
  if (saved) return saved === 'dark'
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
}

const levelClass: Record<LogLevel, string> = {
  info: 'text-[#C9D1D9]',
  success: 'text-[#86EFAC]',
  skip: 'text-[#93C5FD]',
  warn: 'text-[#FFD479]',
  abort: 'text-[#FF9B9B]',
  error: 'text-[#FF9B9B]',
}
const levelTag: Record<LogLevel, string> = {
  info: 'INFO ',
  success: 'OK   ',
  skip: 'SKIP ',
  warn: 'WARN ',
  abort: 'ABORT',
  error: 'ERROR',
}
const LEVELS: LogLevel[] = ['info', 'success', 'skip', 'warn', 'abort', 'error']
const now = (): string => new Date().toLocaleTimeString('en-GB')

/* ---------------------------------- Notes viewer --------------------------- */
function NotesViewer({ title, clauses, onClose }: { title: string; clauses: Clause[]; onClose: () => void }) {
  return (
    <Modal
      title={title}
      titleId="legal-title"
      onClose={onClose}
      footer={
        <button type="button" className="btn btn-primary" onClick={onClose}>
          Close
        </button>
      }
    >
      <ol className="space-y-4">
        {clauses.map((c, i) => (
          <li key={c.id}>
            <h3 className="font-bold">
              {i + 1}. {c.title}
            </h3>
            <p className="mt-1 text-sm leading-relaxed text-muted">{c.body}</p>
          </li>
        ))}
      </ol>
    </Modal>
  )
}

/* ------------------------------------ App ---------------------------------- */
export default function App() {
  const [dark, setDark] = useState<boolean>(initialDark)
  const [consent, setConsent] = useState<ConsentRecord | 'declined' | null>(loadConsent)
  const [view, setView] = useState<'games' | 'settings'>('games')
  const [games, setGames] = useState<ManagedGame[]>(loadGames)
  const [catalog, setCatalog] = useState<CatalogGame[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [logs, setLogs] = useState<LogLine[]>([])
  const [permission, setPermission] = useState<PermissionRequest | null>(null)
  const [understood, setUnderstood] = useState(false)
  const [notes, setNotes] = useState<'privacy' | 'terms' | null>(null)
  const [showDelete, setShowDelete] = useState(false)
  const [helpGame, setHelpGame] = useState<ManagedGame | null>(null)
  const [setupGame, setSetupGame] = useState<ManagedGame | null>(null)

  const resolver = useRef<((ok: boolean) => void) | null>(null)
  const logId = useRef(0)
  const consoleRef = useRef<HTMLDivElement>(null)

  const addLog = (level: LogLevel, message: string, ts?: string) => {
    logId.current += 1
    const line: LogLine = { id: logId.current, ts: ts ?? now(), level, message }
    setLogs((prev) => [...prev, line])
  }
  const mirror = (lines: PatcherLine[]) => lines.forEach((l) => addLog((LEVELS as string[]).includes(l.level) ? (l.level as LogLevel) : 'info', l.message, l.ts))

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
  }, [dark])

  useEffect(() => {
    const el = consoleRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs])

  useEffect(() => {
    fetchCatalog(PATCHER_URL)
      .then(setCatalog)
      .catch(() => addLog('warn', 'Could not reach the local patcher, so the game list is unavailable. Make sure the app is running (the black window must stay open).'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const canChange = consent !== 'declined'
  const infoFor = (game: ManagedGame): CatalogGame | undefined => catalog.find((c) => c.id === game.apiId) ?? catalog.find((c) => c.id === 'other_game')

  const toggleTheme = () => {
    const next = !dark
    setDark(next)
    if (consent && consent !== 'declined') store.set(KEY_THEME, next ? 'dark' : 'light')
  }

  const handleAccept = (record: ConsentRecord) => {
    store.set(KEY_CONSENT, JSON.stringify(record))
    setConsent(record)
  }

  /* ---- permission dialog for byte-level patches ---- */
  const askPermission = (req: PermissionRequest) =>
    new Promise<boolean>((resolve) => {
      resolver.current = resolve
      setUnderstood(false)
      setPermission(req)
    })
  const answerPermission = (ok: boolean) => {
    resolver.current?.(ok)
    resolver.current = null
    setPermission(null)
  }

  /* ---- byte and registry patch (only the demo game has a patch plan): edge Worker -> permission -> patcher ---- */
  const handlePatch = async (game: ManagedGame) => {
    if (!canChange) return
    const entry = catalog.find((c) => c.id === game.apiId)
    if (!entry?.hasPlan) {
      addLog('info', `${game.name} has no byte patch. Use Set up game for its fix pack and compatibility settings.`)
      return
    }
    const apiKey = loadApiKey()
    const backup = loadAutoBackup()
    setBusyId(game.uid)
    try {
      addLog('info', `[1/3] Asking the edge service for a ${game.name} patch plan...`)
      let planRes: Response
      try {
        planRes = await fetch(`${WORKER_URL}/api/patch-plan`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'X-Groq-Key': apiKey } : {}) },
          body: JSON.stringify({ game_id: game.apiId }),
        })
      } catch {
        throw new Error('Could not reach the edge service (port 8787). It is only needed for AI patch plans and online help.')
      }
      const planBody = (await planRes.json().catch(() => null)) as (PatchPlan & { error?: string }) | null
      if (!planRes.ok || !planBody) throw new Error(planBody?.error ?? `Edge service returned HTTP ${planRes.status}.`)
      addLog('success', `Plan received: ${planBody.registry_fixes.length} registry fix(es), ${planBody.hex_offsets.length} byte patch(es).`)

      addLog('info', '[2/3] Waiting for your permission to modify files on this computer...')
      if (!(await askPermission({ game, plan: planBody, backup }))) {
        addLog('warn', 'You cancelled. Nothing was changed.')
        return
      }

      addLog('info', '[3/3] Sending the plan to the local patcher...')
      const body = await patcherPost<PatcherResult>(PATCHER_URL, '/api/patch', {
        game_id: game.apiId,
        target_exe: game.exePath,
        registry_fixes: planBody.registry_fixes,
        hex_offsets: planBody.hex_offsets,
        enforce_backup: backup,
        user_confirmed: true,
      })
      body.logs.forEach((l) => addLog(l.level, l.message, l.ts))
      addLog(body.success ? 'success' : 'error', body.success ? `${game.name}: patch finished.` : `${game.name}: patch did not complete.`)
    } catch (err) {
      addLog('error', err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setBusyId(null)
    }
  }

  const handleRestore = async (game: ManagedGame) => {
    setBusyId(game.uid)
    try {
      addLog('info', `Restoring ${game.name} from its .bak backup...`)
      const body = await patcherPost<PatcherResult>(PATCHER_URL, '/api/restore', { game_id: game.apiId, target_exe: game.exePath, user_confirmed: true })
      body.logs.forEach((l) => addLog(l.level, l.message, l.ts))
    } catch (err) {
      addLog('error', err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setBusyId(null)
    }
  }

  /* ---- data deletion ---- */
  const eraseLocalData = () => {
    void deleteAllRemote(WORKER_URL)
    store.clearApp()
    clearSettingsStorage()
    setGames([])
    setLogs([])
    setView('games')
    setConsent(null)
    setShowDelete(false)
  }

  /* ---------------------------------- Render -------------------------------- */
  if (consent === null) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10">
        <h1 className="text-2xl font-extrabold tracking-tight">{APP_NAME}</h1>
        <p className="mt-2 text-muted">One short notice comes first. It takes a few seconds.</p>
        <ConsentGate onAccept={handleAccept} onDecline={() => setConsent('declined')} />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-5xl px-4 pb-10">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-lg focus:bg-accent focus:px-4 focus:py-2 focus:text-accent-ink"
      >
        Skip to content
      </a>

      <header className="flex flex-wrap items-center justify-between gap-3 py-5">
        <h1 className="text-2xl font-extrabold tracking-tight">{APP_NAME}</h1>
        <nav aria-label="App menu" className="flex flex-wrap gap-2">
          <button type="button" className={`btn ${view === 'games' ? 'btn-primary' : 'btn-secondary'}`} aria-current={view === 'games' ? 'page' : undefined} onClick={() => setView('games')}>
            Games
          </button>
          <button type="button" className={`btn ${view === 'settings' ? 'btn-primary' : 'btn-secondary'}`} aria-current={view === 'settings' ? 'page' : undefined} onClick={() => setView('settings')}>
            Settings
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => setNotes('privacy')}>
            Privacy
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => setNotes('terms')}>
            Terms
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => setShowDelete(true)}>
            Delete my data
          </button>
        </nav>
      </header>

      {!canChange && (
        <div role="status" className="panel mb-4 flex flex-wrap items-center justify-between gap-3 p-4">
          <p className="text-sm">You chose Not now, so changing games is turned off and nothing is saved on this device.</p>
          <button type="button" className="btn btn-primary" onClick={() => setConsent(null)}>
            Review and continue
          </button>
        </div>
      )}

      <main id="main" tabIndex={-1}>
        {view === 'settings' ? (
          <Settings
            games={games}
            setGames={setGames}
            isDarkMode={dark}
            toggleTheme={toggleTheme}
            catalog={catalog}
            persist={canChange}
            patcherUrl={PATCHER_URL}
            onGameAdded={(g) => setSetupGame(g)}
            onSetup={(g) => setSetupGame(g)}
          />
        ) : (
          <>
            <h2 className="mb-3 text-lg font-bold">Your games</h2>
            {games.length === 0 ? (
              <div className="panel p-6 text-center">
                <p className="text-sm text-muted">No games yet. Add a game and its folder in Settings, and the setup steps open by themselves.</p>
                <button type="button" className="btn btn-primary mt-4" onClick={() => setView('settings')}>
                  Add a game
                </button>
              </div>
            ) : (
              <ul className="grid gap-4 sm:grid-cols-2">
                {games.map((game) => {
                  const busy = busyId === game.uid
                  const entry = catalog.find((c) => c.id === game.apiId)
                  const folder = game.exePath.slice(0, Math.max(game.exePath.lastIndexOf('\\'), game.exePath.lastIndexOf('/')))
                  return (
                    <li key={game.uid} className="panel p-5">
                      <article aria-labelledby={`title-${game.uid}`}>
                        <h3 id={`title-${game.uid}`} className="text-lg font-bold">
                          {game.name}
                        </h3>
                        <p className="mt-1 flex flex-wrap gap-2 text-xs">
                          <span className="rounded-full border border-line px-2 py-0.5 text-muted">
                            {entry?.hasPlan ? 'Test game' : (entry?.fixCount ?? 0) > 0 ? 'Fix pack available' : 'Compatibility settings'}
                          </span>
                          {game.group && <span className="rounded-full border border-line px-2 py-0.5 text-muted">{game.group}</span>}
                        </p>
                        <p className="mt-2 break-all font-mono text-xs text-muted" title={game.exePath}>
                          {fileName(game.exePath)} in {folder}
                        </p>
                        <div className="mt-4 flex flex-wrap gap-2">
                          <button type="button" className="btn btn-primary" disabled={!canChange} onClick={() => setSetupGame(game)}>
                            Set up game
                          </button>
                          {entry?.hasPlan && (
                            <>
                              <button type="button" className="btn btn-secondary" disabled={busyId !== null || !canChange} aria-busy={busy} onClick={() => handlePatch(game)}>
                                {busy ? (
                                  <>
                                    <Spinner />
                                    Patching...
                                  </>
                                ) : (
                                  'Patch game'
                                )}
                              </button>
                              <button type="button" className="btn btn-secondary" disabled={busyId !== null || !canChange} onClick={() => handleRestore(game)}>
                                Restore backup
                              </button>
                            </>
                          )}
                          <button type="button" className="btn btn-secondary" disabled={!canChange} onClick={() => setHelpGame(game)}>
                            Get help
                          </button>
                        </div>
                      </article>
                    </li>
                  )
                })}
              </ul>
            )}
          </>
        )}

        {/* macOS-style diagnostic console */}
        <section aria-labelledby="console-title" className="mt-8 overflow-hidden rounded-xl border-2 border-line bg-[#0F1115] shadow-lg">
          <div className="flex items-center gap-2 bg-[#1B1E25] px-4 py-2">
            <span className="flex gap-2" aria-hidden="true">
              <span className="h-3 w-3 rounded-full bg-[#FF5F57]" />
              <span className="h-3 w-3 rounded-full bg-[#FEBC2E]" />
              <span className="h-3 w-3 rounded-full bg-[#28C840]" />
            </span>
            <h2 id="console-title" className="flex-1 text-center text-sm font-semibold text-[#C9D1D9]">
              Diagnostics
            </h2>
            <button type="button" className="rounded border border-[#8B93A1] px-2 py-1 text-xs text-[#C9D1D9] hover:bg-[#2A2F3A]" onClick={() => setLogs([])}>
              Clear
            </button>
          </div>
          <div ref={consoleRef} role="log" aria-live="polite" aria-label="Execution log" tabIndex={0} className="h-72 overflow-y-auto p-4 font-mono text-[13px] leading-6">
            {logs.length === 0 ? (
              <p className="text-[#B4BCC8]">Ready. Add a game in Settings, then press Set up game.</p>
            ) : (
              logs.map((l) => (
                <p key={l.id} className={`${levelClass[l.level]} whitespace-pre-wrap break-words`}>
                  <span className="text-[#9AA3B2]">{l.ts}</span> <span className="font-bold">{levelTag[l.level]}</span> {l.message}
                </p>
              ))
            )}
          </div>
        </section>
      </main>

      <footer className="mt-8 border-t-2 border-soft-line pt-4 text-sm text-muted">
        <p>
          Use this app only on games you legally own. The developer does not condone piracy. Game names belong to their owners. Fonts: Inter and JetBrains Mono (SIL Open Font
          Licence 1.1).
        </p>
      </footer>

      {/* Setup window: the steps to activate a game */}
      {setupGame && (
        <SetupWizard
          key={setupGame.uid}
          game={setupGame}
          info={infoFor(setupGame)}
          patcherUrl={PATCHER_URL}
          backup={loadAutoBackup()}
          onClose={() => setSetupGame(null)}
          onLogs={mirror}
          onRunPatch={handlePatch}
        />
      )}

      {/* Permission dialog for byte-level patches */}
      {permission && (
        <Modal
          title="Allow changes to your computer?"
          titleId="perm-title"
          onClose={() => answerPermission(false)}
          footer={
            <>
              <button type="button" className="btn btn-secondary" onClick={() => answerPermission(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" disabled={!understood} onClick={() => answerPermission(true)}>
                Allow and apply
              </button>
            </>
          }
        >
          <p className="text-sm">
            The patcher wants to change <strong>{permission.game.name}</strong> using this plan. Nothing is written if the file bytes do not match.
          </p>
          <h3 className="mt-4 font-bold">Executable (byte-level access)</h3>
          <p className="break-all font-mono text-sm text-muted">{permission.game.exePath}</p>
          <p className={`mt-1 text-sm ${permission.backup ? 'text-muted' : 'font-semibold text-danger'}`}>
            {permission.backup ? `A backup will be saved first as ${fileName(permission.game.exePath)}.bak.` : 'Backups are turned off in Settings: no .bak copy will be made.'}
          </p>
          {permission.plan.hex_offsets.length === 0 ? (
            <p className="mt-1 text-sm text-muted">No byte patches.</p>
          ) : (
            <ul className="mt-1 space-y-1 font-mono text-xs">
              {permission.plan.hex_offsets.map((h, i) => (
                <li key={i}>
                  {h.offset}: {h.original} &rarr; {h.replace}
                </li>
              ))}
            </ul>
          )}
          <h3 className="mt-4 font-bold">Windows registry</h3>
          {permission.plan.registry_fixes.length === 0 ? (
            <p className="mt-1 text-sm text-muted">No registry changes.</p>
          ) : (
            <ul className="mt-1 space-y-1 font-mono text-xs">
              {permission.plan.registry_fixes.map((r, i) => (
                <li key={i} className="break-all">
                  {r.path}\{r.name} = {String(r.value)} ({r.type})
                </li>
              ))}
            </ul>
          )}
          <label className="mt-5 flex items-start gap-3 text-sm">
            <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
            <span>I understand this edits files and registry values on my computer and I allow it.</span>
          </label>
        </Modal>
      )}

      {/* Data deletion */}
      {showDelete && (
        <Modal
          title="Delete my data"
          titleId="delete-title"
          onClose={() => setShowDelete(false)}
          footer={
            <>
              <button type="button" className="btn btn-secondary" onClick={() => setShowDelete(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={eraseLocalData}>
                Erase local data now
              </button>
            </>
          }
        >
          <p className="text-sm">
            This erases everything the app stored in this browser: your games, tabs and folders, your settings, your Groq key if you entered one, and the keys for any online help requests. It also asks the server to delete those requests. You will see the first-run notice again.
          </p>
          <p className="mt-3 text-sm text-muted">
            It does not touch your games. Fix packs and compatibility settings you applied stay in place until you remove them in each game's setup window. Backup files next to your games are yours to delete.
          </p>
        </Modal>
      )}

      {helpGame && <HelpModal game={{ name: helpGame.name, exeName: fileName(helpGame.exePath) }} workerUrl={WORKER_URL} apiKey={loadApiKey() || undefined} onClose={() => setHelpGame(null)} />}
      {notes === 'privacy' && <NotesViewer title="Privacy" clauses={PRIVACY_CLAUSES} onClose={() => setNotes(null)} />}
      {notes === 'terms' && <NotesViewer title="Terms" clauses={TERMS_CLAUSES} onClose={() => setNotes(null)} />}
    </div>
  )
}
