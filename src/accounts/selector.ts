import type { Account, Config, Store } from './types.ts'

export type AccountState = 'active' | 'idle' | 'parked' | 'blocked' | 'error'

/**
 * Has the window this snapshot describes already rolled over?
 *
 * A snapshot only describes the window it was taken in. Once that window ends
 * the reading says nothing about the new one — the account may have been used
 * heavily since, by Claude Code, another machine, or an OpenCode server we
 * weren't watching. Callers must re-read usage rather than assume.
 */
export function isUsageStale(account: Account, now: number): boolean {
  const usage = account.usage
  if (!usage) return false
  return Boolean(usage.reset5h) && now >= usage.reset5h * 1000
}

/** No reading at all — a freshly added account that has yet to serve anything. */
export function isUsageUnknown(account: Account): boolean {
  return account.usage === null || account.usage === undefined
}

/**
 * Utilization we should act on right now.
 *
 * An expired snapshot reports 0, which is the optimistic reading. That is only
 * safe because `Manager.acquire` re-probes stale accounts before selecting —
 * inferring an empty window from an old timestamp is how an account at 100%
 * ends up looking idle.
 */
export function effectiveU5h(account: Account, now: number): number {
  const usage = account.usage
  if (!usage) return 0
  if (isUsageStale(account, now)) return 0
  return usage.u5h
}

export function effectiveU7d(account: Account, now: number): number {
  const usage = account.usage
  if (!usage) return 0
  if (usage.reset7d && now >= usage.reset7d * 1000) return 0
  return usage.u7d
}

/**
 * The 5h utilization at which this specific account should hand over.
 *
 * Precedence is most-specific-wins: a value stored on the account (set via
 * `oc-anthropic threshold`) beats a `accountThresholds` entry in config, which
 * beats the global default. Letting each account differ matters because plans
 * differ — a 20x account can safely absorb far more before you step off it
 * than a 5x one.
 */
export function thresholdFor(account: Account, config: Config): number {
  if (account.threshold !== null && account.threshold !== undefined) {
    return account.threshold
  }
  return (
    config.accountThresholds[account.label] ??
    config.accountThresholds[account.id] ??
    config.switchThreshold
  )
}

/** Weekly limit exhausted — the account cannot serve anything until it resets. */
export function isBlocked(
  account: Account,
  config: Config,
  now: number,
): boolean {
  return effectiveU7d(account, now) >= config.weeklyThreshold
}

/** Under its threshold, not parked, not weekly-blocked. */
export function isEligible(
  account: Account,
  config: Config,
  now: number,
): boolean {
  if (now < account.parkedUntil) return false
  if (isBlocked(account, config, now)) return false
  return effectiveU5h(account, now) < thresholdFor(account, config)
}

/** Apply the configured rotation order; unlisted accounts keep store order. */
export function ordered(store: Store, config: Config): Account[] {
  if (config.accountOrder.length === 0) return store.accounts

  const rank = (account: Account): number => {
    const index = config.accountOrder.findIndex(
      (entry) => entry === account.id || entry === account.label,
    )
    return index === -1 ? Number.MAX_SAFE_INTEGER : index
  }
  return [...store.accounts].sort((a, b) => rank(a) - rank(b))
}

export type Selection = {
  account: Account
  reason: 'eligible' | 'last-resort'
}

/**
 * Pick the account to serve the next request.
 *
 * First choice is the earliest account in rotation order that still has
 * headroom — which means a reset account is picked back up automatically, and
 * in preference to later ones.
 *
 * When nothing has headroom we do not fail: we fall back to the last usable
 * account and keep going until Anthropic actually rejects us. That is the
 * "stay on the last one until it runs out" case.
 */
export function select(
  store: Store,
  config: Config,
  now = Date.now(),
): Selection | null {
  const candidates = ordered(store, config)
  if (candidates.length === 0) return null

  const eligible = candidates.find((account) =>
    isEligible(account, config, now),
  )
  if (eligible) return { account: eligible, reason: 'eligible' }

  const usable = candidates.filter(
    (account) => now >= account.parkedUntil && !isBlocked(account, config, now),
  )
  const fallback = usable.at(-1)
  if (fallback) return { account: fallback, reason: 'last-resort' }

  // Everything is parked or weekly-blocked. Take whichever frees up soonest so
  // the resulting error names the shortest wait.
  const soonest = [...candidates].sort(
    (a, b) => waitUntil(a, now) - waitUntil(b, now),
  )[0]
  return soonest ? { account: soonest, reason: 'last-resort' } : null
}

function waitUntil(account: Account, now: number): number {
  const reset = account.usage?.reset5h ? account.usage.reset5h * 1000 : now
  return Math.max(account.parkedUntil, reset)
}

export function stateOf(
  account: Account,
  store: Store,
  config: Config,
  now = Date.now(),
): AccountState {
  if (store.active === account.id) return 'active'
  if (isBlocked(account, config, now)) return 'blocked'
  if (now < account.parkedUntil) return 'parked'
  if (effectiveU5h(account, now) >= thresholdFor(account, config))
    return 'parked'
  if (account.error) return 'error'
  return 'idle'
}
