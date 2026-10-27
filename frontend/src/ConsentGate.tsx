import { useState } from 'react'
import { Modal } from './ui'
import { APP_NAME, POLICY_VERSION } from './legal'

export interface ConsentRecord {
  version: string
  acceptedAt: string
  ownsLegalCopy: true
}

interface Props {
  onAccept: (record: ConsentRecord) => void
  onDecline: () => void
}

/** One short first-run screen: no piracy, what the app does to your PC, where your data goes. */
export default function ConsentGate({ onAccept, onDecline }: Props) {
  const [ok, setOk] = useState(false)
  return (
    <Modal
      title="Before you start"
      titleId="consent-title"
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onDecline}>
            Not now
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!ok}
            onClick={() => onAccept({ version: POLICY_VERSION, acceptedAt: new Date().toISOString(), ownsLegalCopy: true })}
          >
            Continue
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm leading-relaxed">
        <p>
          {APP_NAME} helps older PC games run on modern Windows. For the games you choose, it adds fix files and Windows compatibility settings. It{' '}
          <strong>always asks first</strong> and keeps backups, so everything can be undone.
        </p>
        <p>
          It is for games you legally own. It does not bypass copy protection, and the developer does not condone piracy.
        </p>
        <p>Your games and settings stay on this PC. Nothing is sent anywhere unless you use the optional online help, which sends only the text you type.</p>
        <label className="flex items-start gap-3 pt-1">
          <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} />
          <span>I own the games I will use this with, and I understand the app changes files and settings on this PC.</span>
        </label>
      </div>
    </Modal>
  )
}
