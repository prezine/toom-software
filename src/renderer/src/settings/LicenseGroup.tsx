import { useState } from 'react'
import { api } from '@renderer/lib/api'
import { Button } from '@renderer/lib/ui'
import { Check, Monitor } from '@renderer/lib/icons'
import { FormError, Spinner, TextInput } from '@renderer/account/AccountUi'
import { formatLicenseKey, isLicenseKeyShaped, type AccountLicense, type AccountState } from '@shared/account'
import { Group, Item } from './parts'

const dateLabel = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })

const ago = (iso: string): string => {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 864e5)
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`
}

/** "12 days left", from the server's count (or the end date, for an older server) */
const leftLabel = (lic: AccountLicense): string | null => {
  if (!lic.expiresAt) return null
  const n = lic.daysLeft ?? Math.max(0, Math.ceil((new Date(lic.expiresAt).getTime() - Date.now()) / 864e5))
  return n === 0 ? 'Ends today' : `${n} ${n === 1 ? 'day' : 'days'} left`
}

/**
 * Settings → Account → Licence: the key behind this account's Pro, how long it has left, the
 * accounts sharing it and this account's computers, and a field to enter a key or free-Pro code.
 */
export function LicenseGroup({ account }: { account: AccountState }): React.JSX.Element {
  const lic = account.license ?? null
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [entering, setEntering] = useState(false)
  /** the account about to be removed (asks once more before doing it) */
  const [confirming, setConfirming] = useState<string | null>(null)

  const activate = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!key.trim() || busy) return
    setBusy('activate')
    setError('')
    const r = await api.account.licenseActivate(key.trim())
    setBusy(null)
    if (!r.ok) return setError(r.message)
    setKey('')
    setEntering(false)
  }
  const free = async (id: string): Promise<void> => {
    setBusy(id)
    setError('')
    const r = await api.account.licenseDeactivate(id)
    setBusy(null)
    if (!r.ok) setError(r.message)
  }
  const removeAccount = async (id: string): Promise<void> => {
    setBusy(id)
    setError('')
    const r = await api.account.licenseRemoveAccount(id)
    setBusy(null)
    setConfirming(null)
    if (!r.ok) setError(r.message)
  }
  const copy = async (): Promise<void> => {
    if (!lic) return
    await navigator.clipboard.writeText(lic.key).catch(() => undefined)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const owner = lic?.owner ?? true
  const accounts = lic?.accounts ?? []
  const maxAccounts = lic?.maxAccounts ?? 1
  const left = lic ? leftLabel(lic) : null
  const validity = lic
    ? lic.expiresAt
      ? lic.source === 'subscription'
        ? owner
          ? `Paid up until ${dateLabel(lic.expiresAt)}. Each payment extends this same key; if one doesn’t go through, the key runs out and Toom returns to Free.`
          : `Good until ${dateLabel(lic.expiresAt)}. It carries on for as long as its owner’s subscription is paid; after that Toom returns to Free.`
        : `Valid until ${dateLabel(lic.expiresAt)}, then Toom returns to Free.`
      : 'Never expires.'
    : ''

  return (
    <Group
      title="Licence"
      footer={
        lic
          ? maxAccounts > 1 && owner
            ? `Your key works on ${maxAccounts} Toom accounts at a time: yours and one more. Each account can use it on up to ${lic.maxDevices} computers.`
            : `You can use this key on up to ${lic.maxDevices} computers at once.`
          : 'Got a licence key or a free-Pro code? Enter it here to unlock Pro on this computer.'
      }
    >
      {lic && (
        <Item label="Licence key" desc={validity} stack>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded-lg bg-white/[0.06] px-3 py-2 font-mono text-[13px] tracking-wide text-ink-100 select-all">
              {lic.key}
            </code>
            <Button size="sm" onClick={() => void copy()}>
              {copied ? <Check size={13} /> : null}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          {left && (
            <div className="mt-2 flex items-center gap-2 text-[12px]" data-testid="license-days-left">
              <span
                className={`rounded-full px-2 py-0.5 font-medium ${
                  (lic.daysLeft ?? 99) <= 3 ? 'bg-amber-400/15 text-amber-300' : 'bg-emerald-400/15 text-emerald-300'
                }`}
              >
                {left}
              </span>
              {!owner && <span className="text-ink-400">Shared with you</span>}
            </div>
          )}
        </Item>
      )}

      {lic && (maxAccounts > 1 || accounts.length > 1) && (
        <Item
          label={`Accounts (${accounts.length} of ${maxAccounts})`}
          desc={
            owner
              ? accounts.length < maxAccounts
                ? 'To share it, sign in to Toom with the other account and enter this key under Licence. That account gets Pro for the time the key has left.'
                : 'Remove the other account to free its place for someone else.'
              : 'You’re using someone else’s key. Leave it whenever you like.'
          }
          stack
        >
          <ul className="space-y-2">
            {accounts.map((a) => (
              <li key={a.id} className="flex items-center gap-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-white/[0.06] text-[12px] font-semibold text-ink-200 uppercase">
                  {a.email.slice(0, 1)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12.5px] text-ink-100">
                    {a.email}
                    {a.you && <span className="ml-1.5 text-[11px] text-emerald-400">You</span>}
                  </div>
                  <div className="text-[11px] text-ink-400">{a.owner ? (lic.source === 'subscription' ? 'Owner · pays for this key' : 'Owner') : `Added ${ago(a.addedAt)}`}</div>
                </div>
                {!a.owner &&
                  (owner || a.you) &&
                  (confirming === a.id ? (
                    <>
                      <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => setConfirming(null)}>
                        Cancel
                      </Button>
                      <Button size="sm" disabled={!!busy} onClick={() => void removeAccount(a.id)}>
                        {busy === a.id && <Spinner />} {a.you ? 'Leave key' : 'Remove'}
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => setConfirming(a.id)}>
                      {a.you ? 'Leave' : 'Remove'}
                    </Button>
                  ))}
              </li>
            ))}
          </ul>
        </Item>
      )}

      {lic?.problem && (
        <div className="px-4 py-3">
          <FormError>{lic.problem}</FormError>
        </div>
      )}

      {lic && (
        <Item label={`Your computers (${lic.devices.length} of ${lic.maxDevices})`} stack>
          {lic.devices.length === 0 ? (
            <p className="text-[12px] text-ink-400">No computers yet. This one is added when Toom next checks your plan.</p>
          ) : (
            <ul className="space-y-2">
              {lic.devices.map((d) => (
                <li key={d.id} className="flex items-center gap-3">
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-white/[0.06] text-ink-300">
                    <Monitor size={15} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12.5px] text-ink-100">
                      {d.name || 'A computer'}
                      {d.thisComputer && <span className="ml-1.5 text-[11px] text-emerald-400">This computer</span>}
                    </div>
                    <div className="text-[11px] text-ink-400">Last used {ago(d.lastSeen)}</div>
                  </div>
                  <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void free(d.id)}>
                    {busy === d.id && <Spinner />} Deactivate
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Item>
      )}

      {!lic || entering ? (
        <form onSubmit={(e) => void activate(e)} className="flex items-end gap-2 px-4 py-3.5">
          <TextInput
            label={lic ? 'Use a different key' : 'Enter a licence key'}
            className="flex-1"
            placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
            autoCapitalize="characters"
            spellCheck={false}
            value={key}
            onChange={(e) => {
              const v = e.target.value
              // a full key gets its dashes; older promo codes are left as typed
              setKey(isLicenseKeyShaped(v) ? formatLicenseKey(v) : v.toUpperCase())
            }}
          />
          <Button
            type="submit"
            variant="primary"
            className="h-10"
            disabled={!!busy || !key.trim()}
          >
            {busy === 'activate' && <Spinner />} Activate
          </Button>
        </form>
      ) : (
        <Item label="Have another key?" desc="A gifted key, one from a different purchase, or one someone shared with you.">
          <Button size="sm" onClick={() => setEntering(true)}>
            Enter key…
          </Button>
        </Item>
      )}

      {error && (
        <div className="px-4 py-3">
          <FormError>{error}</FormError>
        </div>
      )}
    </Group>
  )
}
