import { useState } from 'react'
import { render, screen, within, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Settings from '../src/Settings'
import { loadGames, loadGroups, type CatalogGame, type ManagedGame } from '../src/settings'

const base = { hasPlan: false, compat: { recommended: [], optional: [] }, launchNotes: [], year: '', blurb: '' }
const CATALOG: CatalogGame[] = [
  { ...base, id: 'max_payne', name: 'Max Payne', exeNames: ['MaxPayne.exe'], fixCount: 1, blurb: 'Runs on Windows 10 and 11.' },
  { ...base, id: 'other_game', name: 'Other game (any .exe)', exeNames: [], fixCount: 0 },
]

let scanReply: { status: number; body: unknown }
let scanCalls: Record<string, unknown>[] = []

function Harness({ persist = true, onGameAdded = () => {}, onSetup = () => {} }: { persist?: boolean; onGameAdded?: (g: ManagedGame) => void; onSetup?: (g: ManagedGame) => void }) {
  const [games, setGames] = useState<ManagedGame[]>(loadGames)
  const [dark, setDark] = useState(false)
  return <Settings games={games} setGames={setGames} isDarkMode={dark} toggleTheme={() => setDark((d) => !d)} catalog={CATALOG} persist={persist} patcherUrl="http://p" onGameAdded={onGameAdded} onSetup={onSetup} />
}

const MP = 'C:\\Games\\Max Payne\\MaxPayne.exe'
const okScan = (exe = MP) => ({ status: 200, body: { exe_path: exe, folder: exe.slice(0, exe.lastIndexOf('\\')), candidates: [exe] } })

const add = async (u: ReturnType<typeof userEvent.setup>, game: string, folder: string) => {
  if (game) await u.selectOptions(screen.getByLabelText('Which game'), game)
  await u.clear(screen.getByLabelText(/Game folder/)); if (folder) await u.type(screen.getByLabelText(/Game folder/), folder)
  await u.click(screen.getByRole('button', { name: 'Find and add game' }))
}

beforeEach(() => {
  localStorage.clear(); scanCalls = []; scanReply = okScan()
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    scanCalls.push(JSON.parse(String(init?.body ?? '{}')))
    return new Response(JSON.stringify(scanReply.body), { status: scanReply.status })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('Settings: adding a game by folder', () => {
  it('asks the patcher to find the program, lists exact paths, saves, clears the form and opens setup', async () => {
    const u = userEvent.setup({ delay: null }); const added = vi.fn(); render(<Harness onGameAdded={added} />)
    await add(u, 'max_payne', 'C:\\Games\\Max Payne')
    await waitFor(() => expect(screen.getAllByText(MP).length).toBeGreaterThan(0))
    expect(scanCalls[0]).toEqual({ game_id: 'max_payne', path: 'C:\\Games\\Max Payne' })
    expect(screen.getByText('C:\\Games\\Max Payne')).toBeTruthy(); expect(screen.getByText('Fix pack available')).toBeTruthy()
    expect(JSON.parse(localStorage.getItem('patcher_games')!)[0]).toMatchObject({ name: 'Max Payne', apiId: 'max_payne', exePath: MP })
    expect(added).toHaveBeenCalledWith(expect.objectContaining({ apiId: 'max_payne', exePath: MP }))
    expect((screen.getByLabelText(/Game folder/) as HTMLInputElement).value).toBe(''); expect((screen.getByLabelText('Which game') as HTMLSelectElement).value).toBe('')
  })
  it('uses a display name you type, and accepts a quoted path', async () => {
    const u = userEvent.setup({ delay: null }); render(<Harness />)
    await u.type(screen.getByLabelText(/Display name/), 'MP1'); await add(u, 'max_payne', '"C:\\Games\\Max Payne"')
    await waitFor(() => expect(loadGames()).toHaveLength(1))
    expect(loadGames()[0].name).toBe('MP1'); expect(scanCalls[0].path).toBe('C:\\Games\\Max Payne')
  })
  it('shows the patcher\'s explanation when the program is not found, and adds nothing', async () => {
    scanReply = { status: 400, body: { detail: 'Could not find MaxPayne.exe in that folder (looked up to 3 folders deep). Pick the folder that contains the game.' } }
    const u = userEvent.setup({ delay: null }); render(<Harness />)
    await add(u, 'max_payne', 'C:\\Nowhere')
    expect((await screen.findByRole('alert')).textContent).toMatch(/Could not find MaxPayne\.exe/); expect(loadGames()).toHaveLength(0)
  })
  it.each([
    ['no game chosen', '', 'C:\\Games\\X', /Choose which game/],
    ['relative path', 'max_payne', 'Games\\X', /full path starting with a drive letter/],
    ['path traversal', 'max_payne', 'C:\\Games\\..\\Windows', /not allowed/],
    ['inside the Windows folder', 'max_payne', 'C:\\Windows\\System32', /not something inside the Windows folder/],
  ])('rejects %s before asking the patcher', async (_n, game, folder, msg) => {
    const u = userEvent.setup({ delay: null }); render(<Harness />)
    await add(u, game, folder)
    expect(screen.getByText(msg)).toBeTruthy(); expect(scanCalls).toHaveLength(0); expect(loadGames()).toHaveLength(0)
  })
  it('"Other game" with several programs: you choose, nothing is guessed', async () => {
    scanReply = { status: 200, body: { exe_path: null, folder: 'C:\\G', candidates: ['C:\\G\\A.exe', 'C:\\G\\B.exe'] } }
    const u = userEvent.setup({ delay: null }); render(<Harness />)
    await add(u, 'other_game', 'C:\\G')
    expect(await screen.findByText('Which program starts the game?')).toBeTruthy(); expect(loadGames()).toHaveLength(0)
    await u.click(screen.getByLabelText('C:\\G\\B.exe')); await u.click(screen.getByRole('button', { name: 'Use this program' }))
    await waitFor(() => expect(loadGames()).toHaveLength(1)); expect(loadGames()[0].exePath).toBe('C:\\G\\B.exe'); expect(loadGames()[0].name).toBe('Other game (any .exe)')
  })
  it('refuses to add the same program twice', async () => {
    const u = userEvent.setup({ delay: null }); render(<Harness />)
    await add(u, 'max_payne', 'C:\\Games\\Max Payne'); await waitFor(() => expect(loadGames()).toHaveLength(1))
    await add(u, 'max_payne', 'C:\\Games\\Max Payne')
    expect((await screen.findByRole('alert')).textContent).toMatch(/already in your list/); expect(loadGames()).toHaveLength(1)
  })
  it('the Set up button opens the setup window for that game', async () => {
    const u = userEvent.setup({ delay: null }); const setup = vi.fn(); render(<Harness onSetup={setup} />)
    await add(u, 'max_payne', 'C:\\Games\\Max Payne'); await waitFor(() => expect(loadGames()).toHaveLength(1))
    await u.click(screen.getByRole('button', { name: 'Set up' })); expect(setup).toHaveBeenCalledWith(expect.objectContaining({ apiId: 'max_payne' }))
  })
  it('removes a game only after confirmation, leaving files alone', async () => {
    const u = userEvent.setup({ delay: null }); render(<Harness />)
    await add(u, 'max_payne', 'C:\\Games\\Max Payne'); await waitFor(() => expect(loadGames()).toHaveLength(1))
    await u.click(screen.getByRole('button', { name: 'Remove' })); expect(screen.getByRole('dialog').textContent).toMatch(/stay exactly where they are/)
    await u.click(screen.getByRole('button', { name: 'Keep it' })); expect(loadGames()).toHaveLength(1)
    await u.click(screen.getByRole('button', { name: 'Remove' })); await u.click(screen.getByRole('button', { name: 'Remove from list' }))
    expect(loadGames()).toHaveLength(0)
  })
})

describe('Settings: tabs you name yourself', () => {
  it('creates, renames and deletes tabs, moving games with them', async () => {
    const u = userEvent.setup({ delay: null }); render(<Harness />)
    await u.type(screen.getByLabelText('Create a tab'), '  Steam   Games '); await u.click(screen.getByRole('button', { name: 'Create tab' }))
    expect(screen.getByRole('tab', { name: 'Steam Games', selected: true })).toBeTruthy()
    await add(u, 'max_payne', 'C:\\Games\\Max Payne'); await waitFor(() => expect(loadGames()).toHaveLength(1))
    expect(loadGames()[0].group).toBe('Steam Games')
    await u.click(screen.getByRole('button', { name: 'Rename this tab' })); await u.clear(screen.getByLabelText(/New name for/)); await u.type(screen.getByLabelText(/New name for/), 'My GOG')
    await u.click(screen.getByRole('button', { name: 'Save name' }))
    expect(loadGroups()).toEqual(['My GOG']); expect(loadGames()[0].group).toBe('My GOG')
    await u.click(screen.getByRole('button', { name: 'Delete this tab' })); await u.click(screen.getByRole('button', { name: 'Delete tab' }))
    expect(loadGroups()).toEqual([]); expect(loadGames()[0].group).toBe('')
  })
  it('rejects duplicate and reserved tab names', async () => {
    const u = userEvent.setup({ delay: null }); render(<Harness />)
    await u.type(screen.getByLabelText('Create a tab'), 'GOG'); await u.click(screen.getByRole('button', { name: 'Create tab' }))
    await u.type(screen.getByLabelText('Create a tab'), 'gog'); await u.click(screen.getByRole('button', { name: 'Create tab' }))
    expect(screen.getByText('You already have a tab with that name.')).toBeTruthy()
    await u.clear(screen.getByLabelText('Create a tab')); await u.type(screen.getByLabelText('Create a tab'), 'All Games'); await u.click(screen.getByRole('button', { name: 'Create tab' }))
    expect(screen.getByText('"All games" is reserved.')).toBeTruthy()
  })
  it('arrow keys, Home and End move between tabs', async () => {
    const u = userEvent.setup({ delay: null }); render(<Harness />)
    for (const n of ['One', 'Two']) { await u.clear(screen.getByLabelText('Create a tab')); await u.type(screen.getByLabelText('Create a tab'), n); await u.click(screen.getByRole('button', { name: 'Create tab' })) }
    screen.getByRole('tab', { name: 'Two' }).focus(); await u.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'All games', selected: true })).toBeTruthy()
    await u.keyboard('{End}'); expect(screen.getByRole('tab', { name: 'Two', selected: true })).toBeTruthy()
  })
})

describe('Settings: general and engine', () => {
  it('backup switch: default ON, turning OFF needs confirmation, ON is instant, state persists', async () => {
    const u = userEvent.setup({ delay: null }); render(<Harness />)
    const sw = screen.getByRole('switch', { name: /Enforce \.bak/ }); expect(sw.getAttribute('aria-checked')).toBe('true')
    await u.click(sw); expect(screen.getByRole('dialog')).toBeTruthy(); expect(localStorage.getItem('patcher_auto_backup')).toBeNull()
    await u.click(screen.getByRole('button', { name: 'Keep backups on' })); expect(sw.getAttribute('aria-checked')).toBe('true')
    await u.click(sw); await u.click(screen.getByRole('button', { name: 'Turn off backups' }))
    expect(sw.getAttribute('aria-checked')).toBe('false'); expect(localStorage.getItem('patcher_auto_backup')).toBe('false')
    await u.click(sw); expect(sw.getAttribute('aria-checked')).toBe('true'); expect(localStorage.getItem('patcher_auto_backup')).toBe('true')
  })
  it('API key: masked, saved only when valid, show/hide, removable', async () => {
    const u = userEvent.setup({ delay: null }); render(<Harness />)
    const input = screen.getByLabelText('Groq API key') as HTMLInputElement; expect(input.type).toBe('password')
    await u.type(input, 'gsk_short'); expect(screen.getByRole('alert').textContent).toMatch(/starts with gsk_/); expect(localStorage.getItem('patcher_api_key')).toBeNull()
    await u.clear(input); await u.type(input, 'gsk_' + 'x'.repeat(30)); expect(localStorage.getItem('patcher_api_key')).toBe('gsk_' + 'x'.repeat(30))
    await u.click(screen.getByRole('button', { name: 'Show' })); expect(input.type).toBe('text')
    await u.click(screen.getByRole('button', { name: 'Remove my key' })); expect(localStorage.getItem('patcher_api_key')).toBeNull(); expect(input.value).toBe('')
  })
  it('theme switch is a labelled switch that calls toggleTheme', async () => {
    const u = userEvent.setup({ delay: null }); render(<Harness />)
    const sw = screen.getByRole('switch', { name: 'Interface theme' }); expect(sw.getAttribute('aria-checked')).toBe('false')
    await u.click(sw); expect(sw.getAttribute('aria-checked')).toBe('true')
  })
  it('persist=false (storage declined): nothing is written', async () => {
    const u = userEvent.setup({ delay: null }); render(<Harness persist={false} />)
    expect(screen.getByText(/declined storage/)).toBeTruthy()
    await add(u, 'max_payne', 'C:\\Games\\Max Payne'); await u.type(screen.getByLabelText('Groq API key'), 'gsk_' + 'y'.repeat(30))
    await waitFor(() => expect(screen.getAllByText(MP).length).toBeGreaterThan(0)); expect(localStorage.length).toBe(0)
  })
  it('keeps dialogs focus-trapped (Tab cycles inside)', async () => {
    const u = userEvent.setup({ delay: null }); render(<Harness />)
    await u.click(screen.getByRole('switch', { name: /Enforce \.bak/ }))
    const dlg = screen.getByRole('dialog'); const btns = within(dlg).getAllByRole('button')
    btns[btns.length - 1].focus(); await u.tab(); expect(dlg.contains(document.activeElement)).toBe(true)
  })
})
