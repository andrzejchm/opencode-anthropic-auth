import { describe, expect, test } from 'bun:test'
import { effectiveU5h, select, stateOf } from '../accounts/selector.ts'
import type { Account, Config, Store } from '../accounts/types.ts'

const NOW = 1_800_000_000_000
const HOUR = 3_600_000

const config: Config = {
  switchThreshold: 0.6,
  weeklyThreshold: 0.98,
  accountThresholds: {},
  accountOrder: [],
}

function account(
  label: string,
  u5h: number,
  overrides: Partial<Account> = {},
): Account {
  return {
    id: label,
    label,
    org: null,
    tier: null,
    refresh: 'r',
    access: 'a',
    expires: NOW + HOUR,
    usage: {
      u5h,
      reset5h: Math.floor((NOW + 2 * HOUR) / 1000),
      u7d: 0,
      reset7d: Math.floor((NOW + 48 * HOUR) / 1000),
      at: NOW,
    },
    profileAt: Date.now(),
    threshold: null,
    parkedUntil: 0,
    lastUsed: null,
    error: null,
    ...overrides,
  }
}

function store(...accounts: Account[]): Store {
  return { version: 1, active: null, accounts }
}

describe('select', () => {
  test('uses the first account while it is under the threshold', () => {
    const s = store(account('a', 0.1), account('b', 0.0), account('c', 0.0))
    expect(select(s, config, NOW)?.account.label).toBe('a')
  })

  test('moves to the next account once the first crosses the threshold', () => {
    const s = store(account('a', 0.61), account('b', 0.0), account('c', 0.0))
    expect(select(s, config, NOW)?.account.label).toBe('b')
  })

  test('walks forward as each account fills up', () => {
    const s = store(account('a', 0.7), account('b', 0.65), account('c', 0.1))
    expect(select(s, config, NOW)?.account.label).toBe('c')
  })

  test('stays on the last account when every account is over the threshold', () => {
    const s = store(account('a', 0.7), account('b', 0.8), account('c', 0.9))
    const selection = select(s, config, NOW)
    expect(selection?.account.label).toBe('c')
    expect(selection?.reason).toBe('last-resort')
  })

  test('returns to the first account once its 5h window has reset', () => {
    // `a` is recorded at 70% but its window rolled over an hour ago.
    const a = account('a', 0.7, {
      usage: {
        u5h: 0.7,
        reset5h: Math.floor((NOW - HOUR) / 1000),
        u7d: 0,
        reset7d: Math.floor((NOW + 48 * HOUR) / 1000),
        at: NOW - 2 * HOUR,
      },
    })
    const s = store(a, account('b', 0.2))
    expect(effectiveU5h(a, NOW)).toBe(0)
    expect(select(s, config, NOW)?.account.label).toBe('a')
  })

  test('skips a parked account even when its utilization looks fine', () => {
    const s = store(
      account('a', 0.1, { parkedUntil: NOW + HOUR }),
      account('b', 0.2),
    )
    expect(select(s, config, NOW)?.account.label).toBe('b')
  })

  test('skips an account that has exhausted its weekly limit', () => {
    const blocked = account('a', 0.1)
    blocked.usage = { ...blocked.usage!, u7d: 0.99 }
    const s = store(blocked, account('b', 0.2))
    expect(select(s, config, NOW)?.account.label).toBe('b')
    expect(stateOf(blocked, s, config, NOW)).toBe('blocked')
  })

  test('honours an explicit rotation order', () => {
    const s = store(account('a', 0.1), account('b', 0.1))
    const ordered = { ...config, accountOrder: ['b', 'a'] }
    expect(select(s, ordered, NOW)?.account.label).toBe('b')
  })

  test('respects a per-account threshold stored on the account', () => {
    // `a` is allowed up to 80%, so 70% is still under its own limit.
    const s = store(account('a', 0.7, { threshold: 0.8 }), account('b', 0.1))
    expect(select(s, config, NOW)?.account.label).toBe('a')
  })

  test('hands over once the per-account threshold is crossed', () => {
    const s = store(account('a', 0.85, { threshold: 0.8 }), account('b', 0.1))
    expect(select(s, config, NOW)?.account.label).toBe('b')
  })

  test('a stricter per-account threshold hands over before the global one', () => {
    // 40% is under the global 60% but over this account's own 30%.
    const s = store(account('a', 0.4, { threshold: 0.3 }), account('b', 0.1))
    expect(select(s, config, NOW)?.account.label).toBe('b')
  })

  test('config thresholds apply when the account carries no override', () => {
    const s = store(account('a', 0.7), account('b', 0.1))
    const tuned = { ...config, accountThresholds: { a: 0.8 } }
    expect(select(s, tuned, NOW)?.account.label).toBe('a')
  })

  test('an account override beats the config map', () => {
    const s = store(account('a', 0.7, { threshold: 0.5 }), account('b', 0.1))
    const tuned = { ...config, accountThresholds: { a: 0.9 } }
    expect(select(s, tuned, NOW)?.account.label).toBe('b')
  })

  test('walks 80/60/90 thresholds in order as each fills up', () => {
    const tuned = {
      ...config,
      accountThresholds: { a: 0.8, b: 0.6, c: 0.9 },
    }
    // a over its 80, b over its 60, c still under its 90.
    const s = store(account('a', 0.85), account('b', 0.65), account('c', 0.88))
    expect(select(s, tuned, NOW)?.account.label).toBe('c')
    expect(stateOf(s.accounts[0]!, s, tuned, NOW)).toBe('parked')
  })

  test('returns null when there are no accounts', () => {
    expect(select(store(), config, NOW)).toBeNull()
  })

  test('picks the soonest-freeing account when all are parked', () => {
    const s = store(
      account('a', 0.1, { parkedUntil: NOW + 3 * HOUR }),
      account('b', 0.1, { parkedUntil: NOW + HOUR }),
    )
    expect(select(s, config, NOW)?.account.label).toBe('b')
  })
})
