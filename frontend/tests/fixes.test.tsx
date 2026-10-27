import { render, screen, waitFor, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import FixesPanel, { type FileFix } from '../src/Fixes'

const GAME = { name: 'Max Payne', apiId: 'max_payne', exePath: 'C:\\Games\\Max Payne\\MaxPayne.exe' }
const FIX: FileFix = {
  id: 'wide', name: 'Widescreen wrapper', description: 'Fixes stretching.', license: 'MIT', source: 'example.org', state: 'not_installed',
  executable_code: true, total_bytes: 2048, files: [{ dest: 'd3d8.dll', size: 2048, sha256: 'a'.repeat(64) }],
}
let calls: { url: string; body: Record<string, unknown> }[] = []
let installed = false
let failList = false

beforeEach(() => {
  calls = []; installed = false; failList = false
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
    calls.push({ url, body })
    if (url.endsWith('/api/fixes/list')) {
      if (failList) return new Response(JSON.stringify({ detail: 'File does not exist: C:\\x' }), { status: 400 })
      return new Response(JSON.stringify({ fixes: [{ ...FIX, state: installed ? 'installed' : 'not_installed' }] }), { status: 200 })
    }
    installed = url.endsWith('/install')
    return new Response(JSON.stringify({ success: true, logs: [{ level: 'success', message: 'Fix installed: Widescreen wrapper' }] }), { status: 200 })
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const open = (backup = true, onLogs = vi.fn()) => render(<FixesPanel game={GAME} patcherUrl="http://p" backup={backup} onLogs={onLogs} />)

describe('FixesPanel', () => {
  it('lists fixes from the local patcher with licence, source and state', async () => {
    open()
    expect(await screen.findByText('Widescreen wrapper')).toBeTruthy()
    expect(screen.getByText(/Licence: MIT/)).toBeTruthy(); expect(screen.getByText('Not installed')).toBeTruthy()
    expect(calls[0].url).toBe('http://p/api/fixes/list'); expect(calls[0].body).toEqual({ game_id: 'max_payne', target_exe: GAME.exePath })
  })
  it('shows a permission step (files, folder, DLL warning) and blocks until the box is ticked', async () => {
    const u = userEvent.setup({ delay: null }); open()
    await u.click(await screen.findByRole('button', { name: 'Install' }))
    expect(screen.getByText(/d3d8\.dll \(2 KB\)/)).toBeTruthy(); expect(screen.getByText('C:\\Games\\Max Payne')).toBeTruthy()
    expect(screen.getByText(/run inside the game/)).toBeTruthy()
    const allow = screen.getByRole('button', { name: 'Allow and install' }) as HTMLButtonElement
    expect(allow.disabled).toBe(true); expect(calls.some((c) => c.url.endsWith('/install'))).toBe(false)
    await u.click(screen.getByRole('checkbox')); expect(allow.disabled).toBe(false)
  })
  it('installs with user_confirmed + the backup setting, mirrors logs, then refreshes the state', async () => {
    const u = userEvent.setup({ delay: null }); const onLogs = vi.fn(); open(true, onLogs)
    await u.click(await screen.findByRole('button', { name: 'Install' })); await u.click(screen.getByRole('checkbox')); await u.click(screen.getByRole('button', { name: 'Allow and install' }))
    await waitFor(() => expect(screen.getByText('Installed')).toBeTruthy())
    const inst = calls.find((c) => c.url.endsWith('/api/fixes/install'))!
    expect(inst.body).toMatchObject({ game_id: 'max_payne', fix_id: 'wide', target_exe: GAME.exePath, enforce_backup: true, user_confirmed: true })
    expect(onLogs).toHaveBeenCalledWith([{ level: 'success', message: 'Fix installed: Widescreen wrapper' }])
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy()
  })
  it('cancel sends nothing', async () => {
    const u = userEvent.setup({ delay: null }); open()
    await u.click(await screen.findByRole('button', { name: 'Install' })); await u.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(calls.filter((c) => !c.url.endsWith('/list'))).toHaveLength(0); expect(screen.getByRole('button', { name: 'Install' })).toBeTruthy()
  })
  it('warns in red when backups are off in Settings', async () => {
    const u = userEvent.setup({ delay: null }); open(false)
    await u.click(await screen.findByRole('button', { name: 'Install' }))
    expect(screen.getByText(/overwritten without a backup/)).toBeTruthy()
  })
  it('shows the patcher error (e.g. wrong path) instead of an empty list', async () => {
    failList = true; open()
    expect((await screen.findByRole('alert')).textContent).toMatch(/File does not exist/)
  })
})
