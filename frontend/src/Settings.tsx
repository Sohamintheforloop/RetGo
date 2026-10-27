import { useEffect, useId, useRef, useState, type Dispatch, type KeyboardEvent, type ReactNode, type SetStateAction } from 'react'
import { Modal } from './ui'
import { patcherPost } from './api'
import {
  GROQ_KEY_RE,
  KEYS,
  cleanLabel,
  fileName,
  loadApiKey,
  loadAutoBackup,
  loadGroups,
  put,
  validateGamePath,
  validateGroupName,
  validateName,
  type CatalogGame,
  type ManagedGame,
} from './settings'

interface SettingsProps {
  games: ManagedGame[]
  setGames: Dispatch<SetStateAction<ManagedGame[]>>
  isDarkMode: boolean
  toggleTheme: () => void
  /** The game catalogue served by the local patcher. */
  catalog?: CatalogGame[]
  /** False when the user declined storage: settings then work for this session only and nothing is written. */
  persist?: boolean
  /** Where the local patcher listens (used to look for the game's program in the folder). */
  patcherUrl: string
  /** Called right after a game is added, so the app can open its setup window. */
  onGameAdded?: (game: ManagedGame) => void
  /** Opens the setup window for an existing game. */
  onSetup?: (game: ManagedGame) => void
}

type Confirm = { kind: 'backup-off' } | { kind: 'remove-game'; game: ManagedGame } | { kind: 'delete-tab'; name: string } | null

function Switch({ checked, onChange, labelId, isDarkMode }: { checked: boolean; onChange: (next: boolean) => void; labelId: string; isDarkMode: boolean }) {
  const on = isDarkMode ? 'bg-[#FFD700] border-[#FFD700]' : 'bg-[#000080] border-[#000080]'
  const knob = isDarkMode ? 'bg-black' : 'bg-white'
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelId}
      onClick={() => onChange(!checked)}
      className={`relative h-7 w-12 shrink-0 cursor-pointer rounded-full border-2 transition-colors motion-reduce:transition-none ${checked ? on : 'border-line bg-transparent'}`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full transition-all motion-reduce:transition-none ${checked ? `left-6 ${knob}` : 'left-0.5 bg-ink'}`}
      />
    </button>
  )
}

function Row({ title, titleId, hint, children }: { title: string; titleId: string; hint: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 border-b border-soft-line py-4 last:border-b-0 sm:flex-row sm:items-start sm:justify-between">
      <div className="sm:max-w-md">
        <p id={titleId} className="font-semibold">
          {title}
        </p>
        <p className="mt-1 text-sm text-muted">{hint}</p>
      </div>
      <div className="sm:w-80">{children}</div>
    </div>
  )
}

export default function Settings({ games, setGames, isDarkMode, toggleTheme, catalog = [], persist = true, patcherUrl, onGameAdded, onSetup }: SettingsProps) {
  const uid = useId()
  const primary = isDarkMode ? 'bg-[#FFD700] border-[#FFD700] text-black' : 'bg-[#000080] border-[#000080] text-white'
  const field = 'w-full rounded-lg border-2 border-line bg-page px-3 py-2 text-sm text-ink'

  const [groups, setGroups] = useState<string[]>(loadGroups)
  const [apiKey, setApiKey] = useState<string>(loadApiKey)
  const [showKey, setShowKey] = useState(false)
  const [keyError, setKeyError] = useState('')
  const [autoBackup, setAutoBackup] = useState<boolean>(loadAutoBackup)
  const [activeTab, setActiveTab] = useState('') // '' = All games
  const [newTab, setNewTab] = useState('')
  const [tabError, setTabError] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [name, setName] = useState('')
  const [gameId, setGameId] = useState('')
  const [folder, setFolder] = useState('')
  const [formGroup, setFormGroup] = useState('')
  const [errors, setErrors] = useState<{ name?: string; game?: string; folder?: string }>({})
  const [scanning, setScanning] = useState(false)
  const [candidates, setCandidates] = useState<string[]>([])
  const [pickedExe, setPickedExe] = useState('')
  const [status, setStatus] = useState('')
  const [confirm, setConfirm] = useState<Confirm>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  /* Instant sync to localStorage. */
  useEffect(() => {
    if (persist) put(KEYS.games, JSON.stringify(games))
  }, [games, persist])
  useEffect(() => {
    if (persist) put(KEYS.groups, JSON.stringify(groups))
  }, [groups, persist])

  const changeApiKey = (value: string) => {
    const v = value.trim()
    setApiKey(v)
    if (v === '') {
      setKeyError('')
      if (persist) put(KEYS.apiKey, null)
    } else if (GROQ_KEY_RE.test(v)) {
      setKeyError('')
      if (persist) put(KEYS.apiKey, v)
    } else {
      setKeyError('A Groq key starts with gsk_ and has no spaces. It is only saved once it looks valid.')
      if (persist) put(KEYS.apiKey, null)
    }
  }

  const applyBackup = (value: boolean) => {
    setAutoBackup(value)
    if (persist) put(KEYS.autoBackup, String(value))
  }

  /* Sub-tabs (named by the user). */
  const tabs = ['', ...groups]
  const selectTab = (tab: string) => {
    setActiveTab(tab)
    setFormGroup(tab)
    setRenaming(false)
    setTabError('')
  }
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.indexOf(activeTab)
    let next = i
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length
    else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = tabs.length - 1
    else return
    e.preventDefault()
    selectTab(tabs[next])
    document.getElementById(`${uid}-tab-${next}`)?.focus()
  }
  const createTab = () => {
    const error = validateGroupName(newTab, groups)
    if (error) return setTabError(error)
    const label = cleanLabel(newTab)
    setGroups((g) => [...g, label])
    setNewTab('')
    selectTab(label)
    setStatus(`Created the tab "${label}".`)
  }
  const saveRename = () => {
    const error = validateGroupName(renameValue, groups, activeTab)
    if (error) return setTabError(error)
    const label = cleanLabel(renameValue)
    const old = activeTab
    setGroups((g) => g.map((x) => (x === old ? label : x)))
    setGames((list) => list.map((x) => (x.group === old ? { ...x, group: label } : x)))
    setActiveTab(label)
    setFormGroup((f) => (f === old ? label : f))
    setRenaming(false)
    setTabError('')
    setStatus(`Renamed the tab to "${label}".`)
  }
  const deleteTab = (tab: string) => {
    setGroups((g) => g.filter((x) => x !== tab))
    setGames((list) => list.map((x) => (x.group === tab ? { ...x, group: '' } : x)))
    selectTab('')
    setStatus(`Deleted the tab "${tab}". Its games are still listed under All games.`)
  }

  /* Games. */
  const entry = catalog.find((c) => c.id === gameId)
  const finishAdd = (exe: string) => {
    if (games.some((g) => g.exePath.toLowerCase() === exe.toLowerCase())) {
      setErrors({ folder: 'That game is already in your list.' })
      return
    }
    const game: ManagedGame = {
      uid: crypto.randomUUID(),
      name: cleanLabel(name) || entry?.name || fileName(exe),
      apiId: gameId,
      exePath: exe,
      group: formGroup,
    }
    setGames((list) => [...list, game])
    setName('')
    setGameId('')
    setFolder('')
    setErrors({})
    setCandidates([])
    setPickedExe('')
    setStatus(`Added ${game.name}.`)
    onGameAdded?.(game)
  }
  const addGame = async () => {
    const next = {
      game: gameId ? '' : 'Choose which game this is.',
      folder: validateGamePath(folder),
      name: name.trim() ? validateName(name) : '',
    }
    setErrors(next)
    if (next.game || next.folder || next.name) return
    setScanning(true)
    setCandidates([])
    try {
      const r = await patcherPost<{ exe_path: string | null; candidates: string[] }>(patcherUrl, '/api/scan', {
        game_id: gameId,
        path: folder.trim().replace(/^"(.*)"$/, '$1'),
      })
      if (r.exe_path) finishAdd(r.exe_path)
      else {
        setCandidates(r.candidates)
        setPickedExe(r.candidates[0] ?? '')
      }
    } catch (err) {
      setErrors({ folder: err instanceof Error ? err.message : 'Could not look in that folder.' })
    } finally {
      setScanning(false)
    }
  }
  const removeGame = (game: ManagedGame) => {
    setGames((list) => list.filter((g) => g.uid !== game.uid))
    setStatus(`Removed ${game.name} from the list. No files were touched.`)
  }

  const visible = activeTab === '' ? games : games.filter((g) => g.group === activeTab)
  const confirmFooter = (onYes: () => void, yes: string, no: string) => (
    <>
      <button type="button" className="btn btn-secondary" onClick={() => setConfirm(null)}>
        {no}
      </button>
      <button
        type="button"
        className={`btn ${primary}`}
        onClick={() => {
          onYes()
          setConfirm(null)
        }}
      >
        {yes}
      </button>
    </>
  )

  return (
    <div className="space-y-6">
      {!persist && (
        <p role="status" className="panel p-4 text-sm">
          You declined storage, so changes here last only for this session and nothing is saved on this device.
        </p>
      )}

      {/* ------------------------- Section 1: General & engine ------------------------- */}
      <section aria-labelledby={`${uid}-general`} className="panel p-5">
        <h2 id={`${uid}-general`} className="text-lg font-bold">
          General and engine
        </h2>
        <p className="text-sm text-muted">Appearance, the AI service, and safety.</p>

        <Row title="Interface theme" titleId={`${uid}-theme`} hint="Switch between the light and dark appearance.">
          <div className="flex items-center gap-3">
            <Switch checked={isDarkMode} onChange={() => toggleTheme()} labelId={`${uid}-theme`} isDarkMode={isDarkMode} />
            <span className="text-sm font-semibold">{isDarkMode ? 'Dark' : 'Light'}</span>
          </div>
        </Row>

        <Row
          title="Groq AI engine"
          titleId={`${uid}-key-label`}
          hint="Optional. Leave empty to use the service's shared key. If you enter your own key it is sent over HTTPS to our edge service only to call Groq for you, and we neither store nor log it. It is kept unencrypted in this browser, so use a key with a spend limit."
        >
          <label htmlFor={`${uid}-key`} className="sr-only">
            Groq API key
          </label>
          <div className="flex gap-2">
            <input
              id={`${uid}-key`}
              type={showKey ? 'text' : 'password'}
              autoComplete="off"
              spellCheck={false}
              placeholder="gsk_..."
              value={apiKey}
              onChange={(e) => changeApiKey(e.target.value)}
              aria-invalid={keyError !== ''}
              aria-describedby={keyError ? `${uid}-key-err` : undefined}
              className={`${field} font-mono`}
            />
            <button type="button" className="btn btn-secondary" aria-pressed={showKey} onClick={() => setShowKey((s) => !s)}>
              {showKey ? 'Hide' : 'Show'}
            </button>
          </div>
          {keyError && (
            <p id={`${uid}-key-err`} role="alert" className="mt-2 text-sm font-semibold text-danger">
              {keyError}
            </p>
          )}
          {apiKey !== '' && !keyError && (
            <button
              type="button"
              className="btn btn-secondary mt-2"
              onClick={() => {
                changeApiKey('')
                setStatus('Your Groq key was removed from this device.')
              }}
            >
              Remove my key
            </button>
          )}
        </Row>

        <Row
          title="Enforce .bak creation before hex modifications"
          titleId={`${uid}-backup`}
          hint="Before the first byte is changed, a copy of the game file is saved next to it as .bak so you can restore it. Strongly recommended."
        >
          <div className="flex items-center gap-3">
            <Switch
              checked={autoBackup}
              onChange={(next) => (next ? applyBackup(true) : setConfirm({ kind: 'backup-off' }))}
              labelId={`${uid}-backup`}
              isDarkMode={isDarkMode}
            />
            <span className="text-sm font-semibold">{autoBackup ? 'On' : 'Off'}</span>
          </div>
        </Row>
      </section>

      {/* ------------------------- Section 2: Game path management ------------------------- */}
      <section aria-labelledby={`${uid}-games`} className="panel p-5">
        <h2 id={`${uid}-games`} className="text-lg font-bold">
          Game path management
        </h2>
        <p className="text-sm text-muted">
          Group your games into tabs you name yourself, and see exactly where each game's folder and program are. Paths stay on this device and are only
          sent to the patcher running on your own computer.
        </p>

        {/* User-named sub-tabs */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <div role="tablist" aria-label="Game tabs" onKeyDown={onTabKey} className="flex flex-wrap gap-2">
            {tabs.map((tab, i) => {
              const selected = tab === activeTab
              return (
                <button
                  key={tab === '' ? '__all' : tab}
                  id={`${uid}-tab-${i}`}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls={`${uid}-panel`}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => selectTab(tab)}
                  className={`btn ${selected ? primary : 'btn-secondary'}`}
                >
                  {tab === '' ? 'All games' : tab}
                </button>
              )
            })}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="min-w-48 flex-1">
            <label htmlFor={`${uid}-newtab`} className="block text-sm font-semibold">
              Create a tab
            </label>
            <input
              id={`${uid}-newtab`}
              type="text"
              maxLength={30}
              placeholder="e.g. Steam, GOG, Old CDs"
              value={newTab}
              onChange={(e) => setNewTab(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') createTab()
              }}
              className={`${field} mt-1`}
            />
          </div>
          <button type="button" className="btn btn-secondary" onClick={createTab}>
            Create tab
          </button>
          {activeTab !== '' && !renaming && (
            <>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setRenaming(true)
                  setRenameValue(activeTab)
                  setTabError('')
                }}
              >
                Rename this tab
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setConfirm({ kind: 'delete-tab', name: activeTab })}>
                Delete this tab
              </button>
            </>
          )}
        </div>
        {renaming && (
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div className="min-w-48 flex-1">
              <label htmlFor={`${uid}-rename`} className="block text-sm font-semibold">
                New name for "{activeTab}"
              </label>
              <input
                id={`${uid}-rename`}
                type="text"
                maxLength={30}
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveRename()
                }}
                className={`${field} mt-1`}
              />
            </div>
            <button type="button" className={`btn ${primary}`} onClick={saveRename}>
              Save name
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => setRenaming(false)}>
              Cancel
            </button>
          </div>
        )}
        {tabError && (
          <p role="alert" className="mt-2 text-sm font-semibold text-danger">
            {tabError}
          </p>
        )}

        {/* Current managed games */}
        <div id={`${uid}-panel`} role="tabpanel" aria-labelledby={`${uid}-tab-${tabs.indexOf(activeTab)}`} tabIndex={0} className="mt-4">
          <h3 className="font-bold">
            {activeTab === '' ? 'All managed games' : `Games in "${activeTab}"`} ({visible.length})
          </h3>
          {visible.length === 0 ? (
            <p className="mt-2 rounded-lg border-2 border-dashed border-line p-4 text-sm text-muted">
              {games.length === 0 ? 'No games yet. Add one with the form below.' : 'No games in this tab yet. Choose this tab when you add a game.'}
            </p>
          ) : (
            <ul className="mt-2 space-y-3">
              {visible.map((g) => {
                const match = catalog.find((c) => c.id === g.apiId)
                const tag = !match
                  ? catalog.length === 0
                    ? 'Catalogue not loaded'
                    : 'Compatibility settings only'
                  : match.hasPlan
                    ? 'Test game'
                    : match.fixCount > 0
                      ? 'Fix pack available'
                      : 'Compatibility settings'
                return (
                  <li key={g.uid} className="rounded-lg border-2 border-soft-line bg-page p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="font-bold">
                          {g.name}{' '}
                          <span className="ml-1 rounded-full border border-line px-2 py-0.5 align-middle text-xs font-normal text-muted">{tag}</span>
                          {g.group && (
                            <span className="ml-1 rounded-full border border-line px-2 py-0.5 align-middle text-xs font-normal text-muted">{g.group}</span>
                          )}
                        </p>
                        <dl className="mt-2 space-y-1 text-sm">
                          <div className="flex flex-wrap gap-x-2">
                            <dt className="text-muted">Game folder:</dt>
                            <dd className="break-all font-mono">{g.exePath.slice(0, Math.max(g.exePath.lastIndexOf('\\'), g.exePath.lastIndexOf('/')))}</dd>
                          </div>
                          <div className="flex flex-wrap gap-x-2">
                            <dt className="text-muted">Program:</dt>
                            <dd className="break-all font-mono">{g.exePath}</dd>
                          </div>
                          {match?.hasPlan && (
                            <div className="flex flex-wrap gap-x-2">
                              <dt className="text-muted">Backup:</dt>
                              <dd className="break-all font-mono">{autoBackup ? `${g.exePath}.bak` : 'Backups are turned off'}</dd>
                            </div>
                          )}
                        </dl>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button type="button" className={`btn ${primary}`} onClick={() => onSetup?.(g)}>
                          Set up
                        </button>
                        <button type="button" className="btn btn-secondary" onClick={() => setConfirm({ kind: 'remove-game', game: g })}>
                          Remove
                        </button>
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {/* Add a game */}
        <div className="mt-6 border-t-2 border-soft-line pt-5">
          <h3 className="font-bold">Add a game</h3>
          <p className="mt-1 text-sm text-muted">Pick the game and tell the app which folder it is installed in. The app finds the game's program by itself, then opens the setup steps.</p>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor={`${uid}-game`} className="block text-sm font-semibold">
                Which game
              </label>
              <select
                id={`${uid}-game`}
                value={gameId}
                onChange={(e) => {
                  setGameId(e.target.value)
                  setCandidates([])
                }}
                aria-invalid={!!errors.game}
                aria-describedby={errors.game ? `${uid}-game-err` : undefined}
                className={`${field} mt-1`}
              >
                <option value="">Choose a game...</option>
                {catalog.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              {entry && <p className="mt-1 text-xs text-muted">{entry.blurb}</p>}
              {errors.game && (
                <p id={`${uid}-game-err`} role="alert" className="mt-1 text-sm font-semibold text-danger">
                  {errors.game}
                </p>
              )}
            </div>
            <div>
              <label htmlFor={`${uid}-name`} className="block text-sm font-semibold">
                Display name (optional)
              </label>
              <input
                id={`${uid}-name`}
                ref={nameRef}
                type="text"
                placeholder={entry?.name ?? 'Max Payne'}
                value={name}
                onChange={(e) => setName(e.target.value)}
                aria-invalid={!!errors.name}
                aria-describedby={errors.name ? `${uid}-name-err` : undefined}
                className={`${field} mt-1`}
              />
              {errors.name && (
                <p id={`${uid}-name-err`} role="alert" className="mt-1 text-sm font-semibold text-danger">
                  {errors.name}
                </p>
              )}
            </div>
            <div className="sm:col-span-2">
              <label htmlFor={`${uid}-folder`} className="block text-sm font-semibold">
                Game folder (or the full path of its .exe)
              </label>
              <input
                id={`${uid}-folder`}
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder="C:\Games\Max Payne"
                value={folder}
                onChange={(e) => {
                  setFolder(e.target.value)
                  setCandidates([])
                }}
                aria-invalid={!!errors.folder}
                aria-describedby={`${uid}-folder-hint${errors.folder ? ` ${uid}-folder-err` : ''}`}
                className={`${field} mt-1 font-mono`}
              />
              <p id={`${uid}-folder-hint`} className="mt-1 text-xs text-muted">
                Tip: open the game's folder in File Explorer, click the address bar, copy, and paste here. For Steam games, right-click the game, then Manage, then Browse local files.
              </p>
              {errors.folder && (
                <p id={`${uid}-folder-err`} role="alert" className="mt-1 text-sm font-semibold text-danger">
                  {errors.folder}
                </p>
              )}
            </div>
            <div>
              <label htmlFor={`${uid}-group`} className="block text-sm font-semibold">
                Tab
              </label>
              <select id={`${uid}-group`} value={formGroup} onChange={(e) => setFormGroup(e.target.value)} className={`${field} mt-1`}>
                <option value="">No tab (All games only)</option>
                {groups.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {candidates.length > 0 && (
            <fieldset className="mt-4 rounded-lg border-2 border-soft-line p-3">
              <legend className="px-1 text-sm font-semibold">Which program starts the game?</legend>
              <div className="space-y-2">
                {candidates.map((c) => (
                  <label key={c} className="flex items-start gap-3 text-sm">
                    <input type="radio" name={`${uid}-exe`} checked={pickedExe === c} onChange={() => setPickedExe(c)} />
                    <span className="break-all font-mono">{c}</span>
                  </label>
                ))}
              </div>
              <button type="button" className={`btn ${primary} mt-3`} disabled={!pickedExe} onClick={() => finishAdd(pickedExe)}>
                Use this program
              </button>
            </fieldset>
          )}
          <button type="button" className={`btn ${primary} mt-4`} disabled={scanning} aria-busy={scanning} onClick={() => void addGame()}>
            {scanning ? 'Looking in the folder...' : 'Find and add game'}
          </button>
        </div>
      </section>

      <p role="status" aria-live="polite" className="min-h-6 text-sm font-semibold text-ok">
        {status}
      </p>

      {/* ------------------------------ Confirmations ------------------------------ */}
      {confirm?.kind === 'backup-off' && (
        <Modal
          title="Turn off safety backups?"
          titleId={`${uid}-c1`}
          onClose={() => setConfirm(null)}
          footer={confirmFooter(() => applyBackup(false), 'Turn off backups', 'Keep backups on')}
        >
          <p className="text-sm">
            Without a .bak copy, a patch that goes wrong cannot be undone from this app. Existing .bak files are never overwritten or deleted.
          </p>
        </Modal>
      )}
      {confirm?.kind === 'remove-game' && (
        <Modal
          title={`Remove ${confirm.game.name}?`}
          titleId={`${uid}-c2`}
          onClose={() => setConfirm(null)}
          footer={confirmFooter(() => removeGame(confirm.game), 'Remove from list', 'Keep it')}
        >
          <p className="text-sm">This only stops tracking the game in this app. The game, its files and any .bak backup stay exactly where they are.</p>
        </Modal>
      )}
      {confirm?.kind === 'delete-tab' && (
        <Modal
          title={`Delete the tab "${confirm.name}"?`}
          titleId={`${uid}-c3`}
          onClose={() => setConfirm(null)}
          footer={confirmFooter(() => deleteTab(confirm.name), 'Delete tab', 'Keep it')}
        >
          <p className="text-sm">The games in this tab are not removed. They stay listed under All games.</p>
        </Modal>
      )}
    </div>
  )
}
