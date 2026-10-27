import { useEffect, useState } from 'react'
import { Modal, Spinner } from './ui'
import {
  PIRACY,
  forgetRequest,
  keyStorageName,
  loadRequests,
  rememberRequest,
  scrub,
  type StoredRequest,
} from './api'
import { fingerprint, importPrivateJwk, newReplyKeypair, openWith, sealTo, type Envelope } from './crypto'

const MAINTAINER_PUBKEY = (import.meta.env.VITE_MAINTAINER_PUBKEY as string | undefined) ?? ''
const OS_OPTIONS = ['Windows 7', 'Windows 10', 'Windows 11', 'Other']

/* -------------------------------- Get help --------------------------------- */
type Route = '' | 'ai' | 'public' | 'private'
interface Advice {
  likely_causes: string[]
  suggestions: string[]
  needs_community_fix: boolean
}
interface PublicItem {
  id: string
  title: string
  exe: string
  os: string
  excerpt: string
}

const ROUTE_INFO: Record<Exclude<Route, ''>, { label: string; detail: string; consent: string }> = {
  ai: {
    label: 'Ask the AI for suggestions',
    detail:
      'Your text goes through our edge service to the Groq AI service, which must be able to read it, so this route is NOT end-to-end encrypted. You get advice only. The AI never writes patches for games that are not reviewed.',
    consent: 'I agree to send the text below to the AI service to get advice.',
  },
  public: {
    label: 'Ask the community (public)',
    detail:
      'Your request is posted publicly and anonymously so others can help. Paths, emails and links are removed. It is deleted automatically after 90 days, or sooner if you delete it. Never include personal data.',
    consent: 'I agree to publish the text below publicly and anonymously.',
  },
  private: {
    label: 'Send privately to the maintainers (end-to-end encrypted)',
    detail:
      'The text is encrypted on this device so that only the maintainers can read it. Our server and Cloudflare store only unreadable ciphertext. Replies are encrypted back to a key that only this device holds.',
    consent: 'I agree to send the encrypted request below to the maintainers.',
  },
}

/** The only things the help dialog needs to know about a game. */
export interface HelpTarget {
  name: string
  exeName: string
}

export function HelpModal({
  game,
  workerUrl,
  apiKey,
  onClose,
}: {
  game: HelpTarget
  workerUrl: string
  /** The user's own Groq key from Settings (optional). Only forwarded on the AI-advice route. */
  apiKey?: string
  onClose: () => void
}) {
  const [route, setRoute] = useState<Route>('')
  const [os, setOs] = useState('Windows 11')
  const [symptoms, setSymptoms] = useState('')
  const [agreed, setAgreed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [advice, setAdvice] = useState<Advice | null>(null)
  const [notice, setNotice] = useState('')
  const [reqs, setReqs] = useState<StoredRequest[]>(loadRequests)
  const [replies, setReplies] = useState<Record<string, string>>({})
  const [publicItems, setPublicItems] = useState<PublicItem[] | null>(null)
  const [fp, setFp] = useState('')

  useEffect(() => {
    if (MAINTAINER_PUBKEY) fingerprint(MAINTAINER_PUBKEY).then(setFp).catch(() => setFp(''))
  }, [])

  const cleaned = scrub(symptoms)
  const piracy = PIRACY.test(`${game.name} ${symptoms}`)
  const payload = { title: game.name, exe_name: game.exeName, os, symptoms: cleaned }
  const privateUnavailable = route === 'private' && !MAINTAINER_PUBKEY
  const ready = route !== '' && cleaned.length >= 10 && agreed && !piracy && !privateUnavailable && !busy

  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${workerUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(path === '/api/diagnose' && apiKey ? { 'X-Groq-Key': apiKey } : {}) },
      body: JSON.stringify(body),
    })
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null
    if (!res.ok || !data) throw new Error(typeof data?.error === 'string' ? data.error : `Request failed (HTTP ${res.status}).`)
    return data
  }

  const send = async () => {
    setBusy(true)
    setError('')
    setNotice('')
    setAdvice(null)
    try {
      if (route === 'ai') {
        setAdvice((await post('/api/diagnose', payload)) as unknown as Advice)
      } else if (route === 'public') {
        const data = await post('/api/requests', { kind: 'public', ...payload })
        const rec: StoredRequest = { id: String(data.id), token: String(data.delete_token), kind: 'public', title: game.name, created: new Date().toISOString() }
        rememberRequest(rec)
        setReqs(loadRequests())
        setNotice('Posted. It will be removed automatically after 90 days. You can delete it any time below.')
      } else if (route === 'private') {
        const reply = await newReplyKeypair()
        const envelope = await sealTo(MAINTAINER_PUBKEY, JSON.stringify({ ...payload, reply_pub: reply.publicB64, app: 'rgap/1' }))
        const data = await post('/api/requests', { kind: 'private', envelope })
        const id = String(data.id)
        localStorage.setItem(keyStorageName(id), JSON.stringify(reply.privateJwk))
        rememberRequest({ id, token: String(data.delete_token), kind: 'private', title: game.name, created: new Date().toISOString() })
        setReqs(loadRequests())
        setNotice('Sent, encrypted. Come back and press Check for reply. Only this device can read the answer.')
      }
      setSymptoms('')
      setAgreed(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  const checkReply = async (r: StoredRequest) => {
    setError('')
    try {
      const res = await fetch(`${workerUrl}/api/replies/${r.id}`)
      const data = (await res.json()) as { reply: Envelope | null }
      if (!data.reply) return setReplies((p) => ({ ...p, [r.id]: 'No reply yet.' }))
      const jwk = JSON.parse(localStorage.getItem(keyStorageName(r.id)) ?? 'null') as JsonWebKey | null
      if (!jwk) return setReplies((p) => ({ ...p, [r.id]: 'The key for this request is missing on this device.' }))
      const text = await openWith(await importPrivateJwk(jwk), data.reply)
      setReplies((p) => ({ ...p, [r.id]: text }))
    } catch {
      setReplies((p) => ({ ...p, [r.id]: 'Could not read the reply. Try again later.' }))
    }
  }

  const remove = async (r: StoredRequest) => {
    setError('')
    try {
      const res = await fetch(`${workerUrl}/api/requests/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: r.id, delete_token: r.token }),
      })
      if (!res.ok && res.status !== 403) throw new Error(`HTTP ${res.status}`) // 403 = already expired
      forgetRequest(r.id)
      setReqs(loadRequests())
    } catch {
      setError('Could not reach the server to delete it. Try again.')
    }
  }

  const loadPublic = async () => {
    setError('')
    try {
      const res = await fetch(`${workerUrl}/api/requests/public`)
      const data = (await res.json()) as { items: PublicItem[] }
      setPublicItems(data.items)
    } catch {
      setError('Could not load community requests.')
    }
  }

  return (
    <Modal
      title={`Get help: ${game.name}`}
      titleId="help-title"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
          <button type="button" className="btn btn-primary" disabled={!ready} aria-busy={busy} onClick={send}>
            {busy ? (
              <>
                <Spinner />
                Sending...
              </>
            ) : (
              'Send'
            )}
          </button>
        </>
      }
    >
      <fieldset>
        <legend className="mb-2 font-bold">How would you like help?</legend>
        <div className="space-y-2">
          {(Object.keys(ROUTE_INFO) as Exclude<Route, ''>[]).map((r) => (
            <label key={r} className="flex items-start gap-3 text-sm">
              <input
                type="radio"
                name="route"
                checked={route === r}
                onChange={() => {
                  setRoute(r)
                  setAgreed(false)
                }}
              />
              <span>{ROUTE_INFO[r].label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {route !== '' && (
        <div className="mt-4 space-y-3">
          <p className="panel p-3 text-sm">{ROUTE_INFO[route].detail}</p>
          {privateUnavailable && (
            <p role="alert" className="text-sm font-semibold text-danger">
              This build has no maintainer key (VITE_MAINTAINER_PUBKEY), so private requests are switched off.
            </p>
          )}
          {route === 'private' && fp && (
            <p className="text-sm text-muted">
              Maintainer key fingerprint: <code className="font-mono">{fp}</code>. Compare it with the one in the project README.
            </p>
          )}
          <label htmlFor="help-os" className="block text-sm font-semibold">
            Windows version
          </label>
          <select id="help-os" className="w-full rounded-lg border-2 border-line bg-page px-3 py-2 text-ink" value={os} onChange={(e) => setOs(e.target.value)}>
            {OS_OPTIONS.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
          <label htmlFor="help-text" className="block text-sm font-semibold">
            What goes wrong? (10-1200 characters, no personal details)
          </label>
          <textarea
            id="help-text"
            rows={4}
            maxLength={1200}
            className="w-full rounded-lg border-2 border-line bg-page px-3 py-2 text-sm text-ink"
            value={symptoms}
            onChange={(e) => setSymptoms(e.target.value)}
          />
          {piracy && (
            <p role="alert" className="text-sm font-semibold text-danger">
              We cannot help with cracks, DRM bypass or piracy. Use a legally owned copy.
            </p>
          )}
          <div>
            <p className="text-sm font-semibold">
              Exactly what will be {route === 'private' ? 'encrypted and sent' : 'sent'}:
            </p>
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border-2 border-soft-line bg-page p-3 font-mono text-xs">
              {JSON.stringify(payload, null, 2)}
            </pre>
            <p className="mt-1 text-xs text-muted">Paths, emails, IP addresses and links are removed before sending. No account or IP address is stored.</p>
          </div>
          <label className="flex items-start gap-3 text-sm">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            <span>{ROUTE_INFO[route].consent}</span>
          </label>
        </div>
      )}

      <div aria-live="polite">
        {error && (
          <p role="alert" className="mt-4 text-sm font-semibold text-danger">
            {error}
          </p>
        )}
        {notice && <p className="mt-4 text-sm font-semibold text-ok">{notice}</p>}
        {advice && (
          <div className="panel mt-4 p-4 text-sm">
            <h3 className="font-bold">Likely causes</h3>
            <ul className="mb-3 list-disc pl-5">{advice.likely_causes.map((c, i) => <li key={i}>{c}</li>)}</ul>
            <h3 className="font-bold">Things to try</h3>
            <ul className="list-disc pl-5">{advice.suggestions.map((c, i) => <li key={i}>{c}</li>)}</ul>
            {advice.needs_community_fix && (
              <p className="mt-3 text-muted">This may need a real fix. Post it to the community or send it privately to the maintainers.</p>
            )}
          </div>
        )}
      </div>

      {reqs.length > 0 && (
        <section className="mt-6" aria-labelledby="mine-title">
          <h3 id="mine-title" className="font-bold">
            Your requests
          </h3>
          <ul className="mt-2 space-y-3">
            {reqs.map((r) => (
              <li key={r.id} className="panel p-3 text-sm">
                <p className="font-semibold">
                  {r.title} ({r.kind === 'private' ? 'encrypted' : 'public'})
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {r.kind === 'private' && (
                    <button type="button" className="btn btn-secondary" onClick={() => checkReply(r)}>
                      Check for reply
                    </button>
                  )}
                  <button type="button" className="btn btn-secondary" onClick={() => remove(r)}>
                    Delete request
                  </button>
                </div>
                {replies[r.id] && <p className="mt-2 whitespace-pre-wrap break-words">{replies[r.id]}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-6" aria-labelledby="comm-title">
        <h3 id="comm-title" className="font-bold">
          Open community requests
        </h3>
        {publicItems === null ? (
          <button type="button" className="btn btn-secondary mt-2" onClick={loadPublic}>
            Show what others reported
          </button>
        ) : publicItems.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No public requests yet.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {publicItems.map((p) => (
              <li key={p.id} className="panel p-3 text-sm">
                <p className="font-semibold">
                  {p.title} <span className="font-normal text-muted">({p.exe}, {p.os})</span>
                </p>
                <p className="text-muted">{p.excerpt}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Modal>
  )
}
