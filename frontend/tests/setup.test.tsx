import { render, screen, waitFor, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SetupWizard from '../src/Setup'
import type { CatalogGame, ManagedGame } from '../src/settings'

const EXE = 'C:\\Games\\Max Payne\\MaxPayne.exe'
const GAME: ManagedGame = { uid: 'u1', name: 'Max Payne', apiId: 'max_payne', exePath: EXE, group: '' }
const MP: CatalogGame = {
  id: 'max_payne', name: 'Max Payne', year: '2001', blurb: '', exeNames: ['MaxPayne.exe'], hasPlan: false, fixCount: 1,
  compat: { recommended: ['DISABLEDXMAXIMIZEDWINDOWEDMODE'], optional: ['WINXPSP3', 'WIN7RTM', 'RUNASADMIN'] },
  launchNotes: ['Install the fix pack, then start the game from Steam.', 'If it will not start, use Remove, then try the options one at a time.'],
}
const STALKER: CatalogGame = { ...MP, id: 'stalker', name: 'STALKER', fixCount: 0, compat: { recommended: [], optional: ['WIN7RTM'] }, launchNotes: ['Original 2007 game only.'] }
const DEMO: CatalogGame = { ...MP, id: 'demo_game', name: 'Demo', hasPlan: true, fixCount: 1 }
const FIX = { id: 'modern_pack', name: 'Modern Windows fix pack', description: 'Widescreen and wrappers.', license: 'Third party', source: 'https://github.com/ThirteenAG/WidescreenFixesPack/releases/tag/mp1', state: 'not_installed', executable_code: true, third_party: true, total_bytes: 13_000_000, files: [{ dest: 'dinput.dll', size: 5_000_000, sha256: 'a'.repeat(64) }] }

let calls: { url: string; body: Record<string, unknown> }[] = []
let compat = { flags: [] as string[], other_settings: [] as string[], managed: false }
let scanFails = false

beforeEach(() => {
  calls = []; compat = { flags: [], other_settings: [], managed: false }; scanFails = false
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
    calls.push({ url, body })
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })
    if (url.endsWith('/api/scan')) return scanFails ? json({ detail: 'Could not find MaxPayne.exe in that folder.' }, 400) : json({ exe_path: EXE, folder: 'C:\\Games\\Max Payne', candidates: [EXE] })
    if (url.endsWith('/api/compat/status')) return json(compat)
    if (url.endsWith('/api/compat/apply')) { compat = { flags: body.flags as string[], other_settings: [], managed: true }; return json({ success: true, logs: [{ level: 'success', message: 'Compatibility settings applied' }] }) }
    if (url.endsWith('/api/compat/remove')) { compat = { flags: [], other_settings: [], managed: false }; return json({ success: true, logs: [{ level: 'success', message: 'Removed the compatibility settings.' }] }) }
    if (url.endsWith('/api/fixes/list')) return json({ fixes: [FIX] })
    return json({ detail: 'unexpected ' + url }, 500)
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const open = (info: CatalogGame | undefined = MP, extra: Partial<Parameters<typeof SetupWizard>[0]> = {}) =>
  render(<SetupWizard game={GAME} info={info} patcherUrl="http://p" backup onClose={() => {}} onLogs={() => {}} {...extra} />)

describe('Setup wizard (the steps to activate a game)', () => {
  it('shows the steps in order for a game with a fix pack', async () => {
    open()
    expect(await screen.findByRole('heading', { name: /1\. Find the game/ })).toBeTruthy()
    for (const t of [/2\. Windows compatibility settings/, /3\. Install the fix pack/, /4\. Launch and test/]) expect(screen.getByRole('heading', { name: t })).toBeTruthy()
    expect(screen.getByRole('dialog', { name: 'Set up Max Payne' })).toBeTruthy()
  })
  it('step 1 looks in the folder and reports the folder and program found', async () => {
    open()
    expect(await screen.findByText('C:\\Games\\Max Payne')).toBeTruthy()
    expect(calls.find((c) => c.url.endsWith('/api/scan'))!.body).toEqual({ game_id: 'max_payne', path: EXE })
    expect(screen.getByRole('heading', { name: /Find the game/ }).textContent).toMatch(/Done/)
  })
  it('step 1 explains a problem and points to the fix', async () => {
    scanFails = true; open()
    expect((await screen.findByRole('alert')).textContent).toMatch(/Could not find MaxPayne\.exe.*remove this game and add it again/)
    expect(screen.getByRole('heading', { name: /Find the game/ }).textContent).toMatch(/Needs attention/)
  })
  it('step 2 preselects the recommended option and needs a permission tick before applying', async () => {
    const u = userEvent.setup({ delay: null }); open()
    const rec = await screen.findByLabelText(/Turn off fullscreen optimizations/); expect((rec as HTMLInputElement).checked).toBe(true)
    expect(screen.getByText('Recommended')).toBeTruthy()
    const apply = screen.getByRole('button', { name: 'Apply these settings' }) as HTMLButtonElement; expect(apply.disabled).toBe(true)
    await u.click(screen.getByLabelText(/I understand this changes Windows compatibility settings/)); expect(apply.disabled).toBe(false)
  })
  it('applies with user_confirmed, mirrors the log, and then offers Undo', async () => {
    const u = userEvent.setup({ delay: null }); const onLogs = vi.fn(); open(MP, { onLogs })
    await screen.findByLabelText(/Turn off fullscreen optimizations/)
    await u.click(screen.getByLabelText(/I understand this changes Windows/)); await u.click(screen.getByRole('button', { name: 'Apply these settings' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy())
    expect(calls.find((c) => c.url.endsWith('/api/compat/apply'))!.body).toEqual({ target_exe: EXE, flags: ['DISABLEDXMAXIMIZEDWINDOWEDMODE'], user_confirmed: true })
    expect(onLogs).toHaveBeenCalledWith([{ level: 'success', message: 'Compatibility settings applied' }])
    expect(screen.getByRole('heading', { name: /Windows compatibility settings/ }).textContent).toMatch(/Applied/)
  })
  it('Undo restores via the patcher and the step goes back to optional', async () => {
    compat = { flags: ['WINXPSP3'], other_settings: ['MYFLAG'], managed: true }
    const u = userEvent.setup({ delay: null }); open()
    expect(await screen.findByText(/Currently set for this game: Run in Windows XP/)).toBeTruthy(); expect(screen.getByText(/other existing settings \(MYFLAG\) are kept/)).toBeTruthy()
    await u.click(screen.getByLabelText(/I understand this changes Windows/)); await u.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull())
    expect(calls.find((c) => c.url.endsWith('/api/compat/remove'))!.body).toEqual({ target_exe: EXE, user_confirmed: true })
  })
  it('only one Windows-version mode can be ticked at a time', async () => {
    const u = userEvent.setup({ delay: null }); open()
    const xp = await screen.findByLabelText(/Windows XP/), w7 = screen.getByLabelText(/Windows 7 mode/)
    await u.click(xp); expect((xp as HTMLInputElement).checked).toBe(true)
    await u.click(w7); expect((w7 as HTMLInputElement).checked).toBe(true); expect((xp as HTMLInputElement).checked).toBe(false)
  })
  it('apply is blocked when nothing is ticked', async () => {
    const u = userEvent.setup({ delay: null }); open()
    await u.click(await screen.findByLabelText(/Turn off fullscreen optimizations/)); await u.click(screen.getByLabelText(/I understand this changes Windows/))
    expect((screen.getByRole('button', { name: 'Apply these settings' }) as HTMLButtonElement).disabled).toBe(true); expect(screen.getByText(/Tick at least one option/)).toBeTruthy()
  })
  it('step 3 embeds the fix pack with its source, and shows the launch notes at the end', async () => {
    open()
    expect(await screen.findByText('Modern Windows fix pack')).toBeTruthy()
    expect(screen.getByRole('link', { name: /github\.com\/ThirteenAG/ }).getAttribute('href')).toContain('WidescreenFixesPack')
    expect(screen.getByText('Install the fix pack, then start the game from Steam.')).toBeTruthy()
  })
  it('a game without a fix pack has no fix step, and the numbering adapts', async () => {
    open(STALKER)
    expect(await screen.findByRole('heading', { name: /3\. Launch and test/ })).toBeTruthy(); expect(screen.queryByRole('heading', { name: /Install the fix pack/ })).toBeNull()
    expect(screen.getByText('Original 2007 game only.')).toBeTruthy()
  })
  it('the test game gets the advanced patch step, which hands over and closes', async () => {
    const u = userEvent.setup({ delay: null }); const onClose = vi.fn(), run = vi.fn(); open(DEMO, { onClose, onRunPatch: run })
    await u.click(await screen.findByRole('button', { name: 'Run the patch...' }))
    expect(onClose).toHaveBeenCalled(); expect(run).toHaveBeenCalledWith(GAME)
  })
  it('a game that is not in the catalogue falls back to scanning as "other game"', async () => {
    render(<SetupWizard game={GAME} info={undefined} patcherUrl="http://p" backup onClose={() => {}} onLogs={() => {}} />)
    await screen.findByText('C:\\Games\\Max Payne')
    expect(calls.find((c) => c.url.endsWith('/api/scan'))!.body).toEqual({ game_id: 'other_game', path: EXE })
    expect(screen.getByText(/No compatibility options are suggested/)).toBeTruthy()
  })
})
