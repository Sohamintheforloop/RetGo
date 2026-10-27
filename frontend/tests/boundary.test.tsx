import { render, screen, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ErrorBoundary from '../src/ErrorBoundary'

afterEach(cleanup)

function Boom(): never {
  throw new Error('kaboom in render')
}

describe('ErrorBoundary', () => {
  it('shows what went wrong instead of a blank page', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<ErrorBoundary><Boom /></ErrorBoundary>)
    expect(screen.getByRole('alert').textContent).toMatch(/Something went wrong.*kaboom in render.*F12/s)
  })
  it('renders children normally', () => {
    render(<ErrorBoundary><p>fine</p></ErrorBoundary>)
    expect(screen.getByText('fine')).toBeTruthy()
  })
})
