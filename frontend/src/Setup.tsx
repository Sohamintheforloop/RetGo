import { useEffect, useId, useState } from 'react'
import FixesPanel, { type FileFix, type LogLine } from './Fixes'
import { Modal, Spinner } from './ui'
import { patcherPost } from './api'
import type { CatalogGame, ManagedGame } from './settings'

interface Props {
  game: ManagedGame
  /** The game's catalogue entry (or the generic "other game" entry when the game is not in the catalogue). */
  info?: CatalogGame
  patcherUrl: string
  /** Mirrors Settings > "Enforce .bak creation". */
  backup: boolean
  onClose: () => void
  onLogs: (lines: LogLine[]) => void
  /** Only for games that have an AI patch plan (the demo game). */
  onRunPatch?: (game: ManagedGame) => void
}

interface CompatStatus {
  flags: string[]
  other_settings: string[]
  managed: boolean
}

const FLAG_LABEL: Record<string, string> = {
  DISABLEDXMAXIMIZEDWINDOWEDMODE: 'Turn off fullscreen optimizations',
  WINXPSP3: 'Run in Windows XP (Service Pack 3) mode',
  WIN98: 'Run in Windows 98 mode',
  WIN7RTM: 'Run in Windows 7 mode',
  RUNASADMIN: 'Always run as administrator',
  HIGHDPIAWARE: 'Let the game handle high-DPI scaling itself',
  '640X480': 'Run in 640 x 480 screen resolution',
  '16BITCOLOR': 'Reduced colour mode (16-bit)',
}
const OS_FLAGS = ['WINXPSP3', 'WIN98', 'WIN7RTM']

const Chip = ({ text }: { text: string }) => <span className="ml-2 rounded-full border border-line px-2 py-0.5 align-middle text-xs font-normal text-muted">{text}</span>

export default function SetupWizard({ game, info, patcherUrl, backup, onClose, onLogs, onRunPatch }: Props) {
  const uid = useId()
  const scanId = info?.id ?? 'other_game'
  const [scan, setScan] = useState<{ state: 'checking' | 'ok' | 'error'; exe?: string; folder?: string; message?: string }>({ state: 'checking' })
  const [compat, setCompat] = useState<CompatStatus | null>(null)
  const [compatError, setCompatError] = useState('')
  const [chosen, setChosen] = useState<string[]>([])
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState<'apply' | 'undo' | null>(null)
  const [compatResult, setCompatResult] = useState<LogLine[]>([])
  const [fixes, setFixes] = useState<FileFix[] | null>(null)

  const checkFolder = async () => {
    setScan({ state: 'checking' })
    try {
      const r = await patcherPost<{ exe_path: string | null; folder: string }>(patcherUrl, '/api/scan', { game_id: scanId, path: game.exePath })
      setScan({ state: 'ok', exe: r.exe_path ?? game.exePath, folder: r.folder })
    } catch (err) {
      setScan({ state: 'error', message: err instanceof Error ? err.message : 'Unknown error' })
    }
  }

  const loadCompat = async (initial: boolean) => {
    try {
      const c = await patcherPost<CompatStatus>(patcherUrl, '/api/compat/status', { target_exe: game.exePath })
      setCompat(c)
      setCompatError('')
      if (initial) setChosen(c.managed ? c.flags : (info?.compat.recommended ?? []))
    } catch (err) {
      setCompatError(err instanceof Error ? err.message : 'Unknown error')
    }
  }

  useEffect(() => {
    void checkFolder()
    void loadCompat(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggle = (flag: string) =>
    setChosen((prev) => {
      if (prev.includes(flag)) return prev.filter((f) => f !== flag)
      const base = OS_FLAGS.includes(flag) ? prev.filter((f) => !OS_FLAGS.includes(f)) : prev // only one Windows-version mode
      return [...base, flag]
    })

  const runCompat = async (action: 'apply' | 'remove') => {
    setBusy(action === 'apply' ? 'apply' : 'undo')
    setCompatError('')
    try {
      const body = action === 'apply' ? { target_exe: game.exePath, flags: chosen, user_confirmed: true } : { target_exe: game.exePath, user_confirmed: true }
      const d = await patcherPost<{ logs: LogLine[] }>(patcherUrl, `/api/compat/${action}`, body)
      setCompatResult(d.logs)
      onLogs(d.logs)
      setConfirm(false)
      await loadCompat(action === 'remove')
    } catch (err) {
      setCompatError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setBusy(null)
    }
  }

  const recommended = info?.compat.recommended ?? []
  const optional = (info?.compat.optional ?? []).filter((f) => !recommended.includes(f))
  const hasCompatOptions = recommended.length + optional.length > 0
  const steps = ['find', 'compat', ...((info?.fixCount ?? 0) > 0 ? ['fixes'] : []), ...(info?.hasPlan ? ['patch'] : []), 'launch'] as const
  const num = (key: (typeof steps)[number]) => steps.indexOf(key) + 1
  const fixInstalled = (fixes ?? []).some((f) => f.state === 'installed')
  const setSame = compat && compat.managed && [...compat.flags].sort().join() === [...chosen].sort().join()

  const flagBox = (flag: string, tag?: string) => (
    <label key={flag} className="flex items-start gap-3 text-sm">
      <input type="checkbox" checked={chosen.includes(flag)} onChange={() => toggle(flag)} />
      <span>
        {FLAG_LABEL[flag] ?? flag}
        {tag && <Chip text={tag} />}
      </span>
    </label>
  )

  return (
    <Modal
      title={`Set up ${game.name}`}
      titleId={`${uid}-title`}
      onClose={onClose}
      footer={
        <button type="button" className="btn btn-primary" onClick={onClose}>
          Close
        </button>
      }
    >
      <p className="text-sm text-muted">Follow the steps in order. The app asks before it changes anything, and every change can be undone.</p>

      <div className="mt-4 space-y-6">
        {/* 1. Find the game */}
        <section aria-labelledby={`${uid}-s1`}>
          <h3 id={`${uid}-s1`} className="font-bold">
            {num('find')}. Find the game
            <Chip text={scan.state === 'ok' ? 'Done' : scan.state === 'checking' ? 'Checking...' : 'Needs attention'} />
          </h3>
          {scan.state === 'ok' && (
            <dl className="mt-2 space-y-1 text-sm">
              <div className="flex flex-wrap gap-x-2">
                <dt className="text-muted">Folder:</dt>
                <dd className="break-all font-mono">{scan.folder}</dd>
              </div>
              <div className="flex flex-wrap gap-x-2">
                <dt className="text-muted">Program:</dt>
                <dd className="break-all font-mono">{scan.exe}</dd>
              </div>
            </dl>
          )}
          {scan.state === 'error' && (
            <p role="alert" className="mt-2 text-sm font-semibold text-danger">
              {scan.message} Fix the folder in Settings: remove this game and add it again.
            </p>
          )}
          <button type="button" className="btn btn-secondary mt-2" onClick={() => void checkFolder()}>
            Check again
          </button>
        </section>

        {/* 2. Windows compatibility */}
        <section aria-labelledby={`${uid}-s2`}>
          <h3 id={`${uid}-s2`} className="font-bold">
            {num('compat')}. Windows compatibility settings
            <Chip text={compat?.managed ? 'Applied' : 'Optional'} />
          </h3>
          <p className="mt-1 text-sm text-muted">
            These are the same switches as right-click the game, then Properties, then Compatibility. They apply to this game only, for your Windows account only. Undo puts Windows back exactly as it was.
          </p>
          {compatError && (
            <p role="alert" className="mt-2 text-sm font-semibold text-danger">
              {compatError}
            </p>
          )}
          {hasCompatOptions ? (
            <div className="mt-3 space-y-2">
              {recommended.map((f) => flagBox(f, 'Recommended'))}
              {optional.map((f) => flagBox(f))}
              <p className="text-sm text-muted">{compat ? (compat.flags.length ? `Currently set for this game: ${compat.flags.map((f) => FLAG_LABEL[f] ?? f).join(', ')}.` : 'Nothing is set for this game right now.') : ''}</p>
              {compat && compat.other_settings.length > 0 && <p className="text-sm text-muted">Your other existing settings ({compat.other_settings.join(', ')}) are kept as they are.</p>}
              <label className="flex items-start gap-3 text-sm">
                <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
                <span>I understand this changes Windows compatibility settings for this game.</span>
              </label>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn btn-primary" disabled={!confirm || chosen.length === 0 || busy !== null || !!setSame} aria-busy={busy === 'apply'} onClick={() => void runCompat('apply')}>
                  {busy === 'apply' ? (
                    <>
                      <Spinner />
                      Applying...
                    </>
                  ) : setSame ? (
                    'Applied'
                  ) : (
                    'Apply these settings'
                  )}
                </button>
                {compat?.managed && (
                  <button type="button" className="btn btn-secondary" disabled={!confirm || busy !== null} onClick={() => void runCompat('remove')}>
                    {busy === 'undo' ? 'Undoing...' : 'Undo'}
                  </button>
                )}
              </div>
              {chosen.length === 0 && <p className="text-sm text-muted">Tick at least one option to apply, or skip this step.</p>}
            </div>
          ) : (
            <p className="mt-2 text-sm text-muted">No compatibility options are suggested for this game.</p>
          )}
          {compatResult.length > 0 && (
            <div aria-live="polite" className="mt-3 rounded-lg border-2 border-soft-line bg-page p-3 font-mono text-xs">
              {compatResult.map((l, i) => (
                <p key={i} className="break-words">
                  [{l.level}] {l.message}
                </p>
              ))}
            </div>
          )}
        </section>

        {/* 3. Fix pack */}
        {(info?.fixCount ?? 0) > 0 && (
          <section aria-labelledby={`${uid}-s3`}>
            <h3 id={`${uid}-s3`} className="font-bold">
              {num('fixes')}. Install the fix pack
              <Chip text={fixes === null ? 'Checking...' : fixInstalled ? 'Done' : 'To do'} />
            </h3>
            <p className="mb-3 mt-1 text-sm text-muted">These files come from inside this app, were fingerprint-checked, and are never downloaded while you play.</p>
            <FixesPanel game={{ name: game.name, apiId: scanId, exePath: game.exePath }} patcherUrl={patcherUrl} backup={backup} onLogs={onLogs} onState={setFixes} />
          </section>
        )}

        {/* 4. Advanced patch (test game only) */}
        {info?.hasPlan && (
          <section aria-labelledby={`${uid}-s4`}>
            <h3 id={`${uid}-s4`} className="font-bold">
              {num('patch')}. Byte and registry patch (advanced)
              <Chip text="Test game only" />
            </h3>
            <p className="mt-1 text-sm text-muted">Asks the AI service for a patch plan, then shows you every byte it would change before anything happens.</p>
            <button
              type="button"
              className="btn btn-secondary mt-2"
              onClick={() => {
                onClose()
                onRunPatch?.(game)
              }}
            >
              Run the patch...
            </button>
          </section>
        )}

        {/* Launch and test */}
        <section aria-labelledby={`${uid}-s5`}>
          <h3 id={`${uid}-s5`} className="font-bold">
            {num('launch')}. Launch and test
          </h3>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">
            {(info?.launchNotes ?? ['Start the game the way you normally do and see whether it runs.']).map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ol>
          <p className="mt-3 text-sm text-muted">Something wrong? Open this window again and use Remove (fix pack) or Undo (compatibility). Both put your game back the way it was.</p>
        </section>
      </div>
    </Modal>
  )
}
