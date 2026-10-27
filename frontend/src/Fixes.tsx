import { useCallback, useEffect, useState } from 'react'
import { Spinner } from './ui'
import { patcherPost } from './api'

interface FixFile {
  dest: string
  size: number
  sha256: string
}
export interface FileFix {
  id: string
  name: string
  description: string
  license: string
  source: string
  state: 'not_installed' | 'installed' | 'modified'
  executable_code: boolean
  third_party?: boolean
  total_bytes: number
  files: FixFile[]
}
export interface LogLine {
  level: string
  message: string
  ts?: string
}

interface Props {
  game: { name: string; apiId: string; exePath: string }
  patcherUrl: string
  /** Mirrors Settings > "Enforce .bak creation". */
  backup: boolean
  /** Lets the app mirror the patcher's log lines into the diagnostics console. */
  onLogs: (lines: LogLine[]) => void
  /** Reports the current list so a parent (the setup window) can show progress. */
  onState?: (fixes: FileFix[]) => void
}

type Action = 'install' | 'uninstall'

const STATE_LABEL: Record<FileFix['state'], string> = {
  not_installed: 'Not installed',
  installed: 'Installed',
  modified: 'Installed, but some files were changed since',
}

const mb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)
const folderOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')))

/** Lists the reviewed fix packs for a game and installs or removes them, with a permission step that names every file. */
export default function FixesPanel({ game, patcherUrl, backup, onLogs, onState }: Props) {
  const [fixes, setFixes] = useState<FileFix[] | null>(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState<{ fix: FileFix; action: Action } | null>(null)
  const [agreed, setAgreed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<LogLine[]>([])

  const refresh = useCallback(async () => {
    try {
      const data = await patcherPost<{ fixes: FileFix[] }>(patcherUrl, '/api/fixes/list', { game_id: game.apiId, target_exe: game.exePath })
      setFixes(data.fixes)
      onState?.(data.fixes)
      setError('')
    } catch (err) {
      setFixes([])
      setError(err instanceof Error ? err.message : 'Unknown error')
    }
  }, [patcherUrl, game.apiId, game.exePath, onState])

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patcherUrl, game.apiId, game.exePath])

  const run = async () => {
    if (!pending) return
    setBusy(true)
    setError('')
    try {
      const data = await patcherPost<{ logs: LogLine[] }>(patcherUrl, `/api/fixes/${pending.action}`, {
        game_id: game.apiId,
        fix_id: pending.fix.id,
        target_exe: game.exePath,
        enforce_backup: backup,
        user_confirmed: true,
      })
      setResult(data.logs)
      onLogs(data.logs)
      setPending(null)
      setAgreed(false)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setBusy(false)
    }
  }

  const verb = pending?.action === 'install' ? 'Install' : 'Remove'
  const ask = (fix: FileFix, action: Action) => {
    setPending({ fix, action })
    setAgreed(false)
    setResult([])
  }

  return (
    <div>
      {error && (
        <p role="alert" className="mb-3 text-sm font-semibold text-danger">
          {error}
        </p>
      )}
      {fixes === null && <p className="text-sm">Loading...</p>}
      {fixes !== null && fixes.length === 0 && !error && <p className="text-sm text-muted">No fix files are available for this game.</p>}

      {pending ? (
        <section aria-labelledby="perm-fix" className="space-y-3">
          <h4 id="perm-fix" className="font-bold">
            {verb}: {pending.fix.name}
          </h4>
          <p className="text-sm">
            Game folder: <span className="break-all font-mono">{folderOf(game.exePath)}</span>
          </p>
          <ul className="max-h-48 space-y-1 overflow-auto rounded-lg border-2 border-soft-line bg-page p-3 font-mono text-xs">
            {pending.fix.files.map((f) => (
              <li key={f.dest} className="break-all">
                {f.dest} ({mb(f.size)})
              </li>
            ))}
          </ul>
          {pending.action === 'install' && pending.fix.executable_code && (
            <p className="text-sm font-semibold text-danger">
              This adds program files (.dll / .asi) that run inside the game. Only continue if you trust the source below. Antivirus tools sometimes flag this kind of file.
            </p>
          )}
          <p className={`text-sm ${backup ? 'text-muted' : 'font-semibold text-danger'}`}>
            {pending.action === 'uninstall'
              ? 'Files you changed since installing are left alone, and any file this fix replaced is put back from its backup.'
              : backup
                ? 'Any file that already exists is backed up first (as .rgap-bak). If something fails, everything is rolled back.'
                : 'Backups are turned off in Settings: existing files with these names will be overwritten without a backup.'}
          </p>
          <label className="flex items-start gap-3 text-sm">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            <span>I understand this {pending.action === 'install' ? 'adds files to' : 'removes files from'} my game folder and I allow it.</span>
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setPending(null)}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" disabled={!agreed || busy} aria-busy={busy} onClick={run}>
              {busy ? (
                <>
                  <Spinner />
                  Working...
                </>
              ) : (
                `Allow and ${verb.toLowerCase()}`
              )}
            </button>
          </div>
        </section>
      ) : (
        <ul className="space-y-3">
          {(fixes ?? []).map((fix) => (
            <li key={fix.id} className="rounded-lg border-2 border-soft-line bg-page p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <h4 className="font-bold">{fix.name}</h4>
                  <p className="mt-1 text-sm text-muted">{fix.description}</p>
                  <p className="mt-2 text-xs text-muted">
                    {fix.files.length} file(s), {mb(fix.total_bytes)}. {fix.third_party ? 'Made by a third party. ' : ''}Licence: {fix.license}
                    {fix.source.startsWith('https://') ? (
                      <>
                        {' '}
                        Source:{' '}
                        <a href={fix.source} target="_blank" rel="noreferrer noopener" className="break-all underline">
                          {fix.source}
                        </a>
                      </>
                    ) : (
                      <> Source: {fix.source}</>
                    )}
                  </p>
                  <p className="mt-2 text-sm font-semibold">{STATE_LABEL[fix.state]}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {fix.state !== 'installed' && (
                    <button type="button" className="btn btn-primary" onClick={() => ask(fix, 'install')}>
                      {fix.state === 'modified' ? 'Reinstall' : 'Install'}
                    </button>
                  )}
                  {fix.state !== 'not_installed' && (
                    <button type="button" className="btn btn-secondary" onClick={() => ask(fix, 'uninstall')}>
                      Remove
                    </button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {result.length > 0 && !pending && (
        <div aria-live="polite" className="mt-3 rounded-lg border-2 border-soft-line bg-page p-3 font-mono text-xs">
          {result.map((l, i) => (
            <p key={i} className="break-words">
              [{l.level}] {l.message}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}
