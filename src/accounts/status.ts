import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  effectiveU5h,
  effectiveU7d,
  isUsageStale,
  isUsageUnknown,
  ordered,
  stateOf,
  thresholdFor,
} from './selector.ts'
import { statusPath } from './store.ts'
import type { Config, Store } from './types.ts'

export type StatusRow = {
  order: number
  id: string
  label: string
  org: string | null
  tier: string | null
  state: string
  /** Effective 5h switch threshold for this account (0..1). */
  threshold: number
  /**
   * True when the reading predates the window it describes, so `u5h` is an
   * optimistic guess rather than an observation.
   */
  stale: boolean
  u5h: number
  resets5h: string | null
  u7d: number
  lastUsed: string | null
  error: string | null
}

export type Status = {
  updatedAt: string
  active: string | null
  switchThreshold: number
  accounts: StatusRow[]
}

const iso = (ms: number | null): string | null =>
  ms ? new Date(ms).toISOString() : null

export function buildStatus(
  store: Store,
  config: Config,
  now = Date.now(),
): Status {
  const rows = ordered(store, config).map((account, index) => ({
    order: index + 1,
    id: account.id,
    label: account.label,
    org: account.org,
    tier: account.tier,
    state: stateOf(account, store, config, now),
    threshold: thresholdFor(account, config),
    stale: isUsageStale(account, now) || isUsageUnknown(account),
    u5h: round(effectiveU5h(account, now)),
    resets5h: account.usage?.reset5h ? iso(account.usage.reset5h * 1000) : null,
    u7d: round(effectiveU7d(account, now)),
    lastUsed: iso(account.lastUsed),
    error: account.error,
  }))

  return {
    updatedAt: new Date(now).toISOString(),
    active: store.accounts.find((a) => a.id === store.active)?.label ?? null,
    switchThreshold: config.switchThreshold,
    accounts: rows,
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

/**
 * Mirror the store to a secret-free file.
 *
 * Derived on every write rather than maintained separately, so it cannot drift
 * from the store. This is the file to `cat`, `jq` or `watch` — the store itself
 * holds refresh tokens and is not meant to be read by a human.
 */
export function writeStatus(store: Store, config: Config): void {
  try {
    const path = statusPath()
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(
      tmp,
      `${JSON.stringify(buildStatus(store, config), null, 2)}\n`,
    )
    renameSync(tmp, path)
  } catch {
    /* Status is observability only; never break a request over it. */
  }
}
