/** Usage snapshot for one account, in the shape Anthropic reports it. */
export type Usage = {
  /** 5-hour window utilization, 0..1 */
  u5h: number
  /** Unix seconds when the 5-hour window rolls over, or 0 if unknown. */
  reset5h: number
  /** 7-day window utilization, 0..1 */
  u7d: number
  /** Unix seconds when the 7-day window rolls over, or 0 if unknown. */
  reset7d: number
  /** Epoch ms when this snapshot was taken. */
  at: number
}

export type Profile = {
  /** Anthropic account uuid — the stable identity key. */
  uuid: string
  email: string
  org: string | null
  /** e.g. `max_5x`, derived from `organization.rate_limit_tier`. */
  tier: string | null
}

export type Account = {
  /** Anthropic account uuid once known, otherwise a local uuid. */
  id: string
  /** Auto-derived from the profile, overridable. */
  label: string
  org: string | null
  tier: string | null
  refresh: string
  access: string
  /** Epoch ms. */
  expires: number
  usage: Usage | null
  /** Epoch ms; account is skipped until then. Set on 429 / manual park. */
  parkedUntil: number
  /** Epoch ms of last successful request. */
  lastUsed: number | null
  /** Last error message, cleared on success. */
  error: string | null
}

export type Store = {
  version: 1
  /** Account id currently in use. */
  active: string | null
  accounts: Account[]
}

export type Config = {
  /** Move on once the active account's 5h utilization reaches this (0..1). */
  switchThreshold: number
  /** Treat an account as unusable at or above this 7d utilization (0..1). */
  weeklyThreshold: number
  /** Account labels or ids, in rotation order. Unlisted accounts keep their store order. */
  accountOrder: string[]
}

export const DEFAULT_CONFIG: Config = {
  switchThreshold: 0.6,
  weeklyThreshold: 0.98,
  accountOrder: [],
}

export const EMPTY_STORE: Store = { version: 1, active: null, accounts: [] }
