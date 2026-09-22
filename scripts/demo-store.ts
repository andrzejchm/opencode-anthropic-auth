/**
 * Write a fake account store for documentation screenshots.
 *
 * Readings are stamped `now` so the CLI treats them as fresh and renders
 * without touching the network — the output is genuinely produced by the tool,
 * it just describes accounts that do not exist.
 *
 * Usage: ANTHROPIC_ACCOUNTS_FILE=/tmp/demo.json bun scripts/demo-store.ts
 */
import { saveStore } from '../src/accounts/store.ts'
import type { Account } from '../src/accounts/types.ts'

const now = Date.now()
const hours = (n: number) => Math.floor((now + n * 3_600_000) / 1000)

function account(
  over: Partial<Account> & Pick<Account, 'id' | 'label'>,
): Account {
  return {
    org: null,
    tier: 'max_5x',
    refresh: 'demo',
    access: 'demo',
    expires: now + 8 * 3_600_000,
    usage: null,
    profileAt: now,
    threshold: null,
    parkedUntil: 0,
    lastUsed: now,
    error: null,
    ...over,
  }
}

saveStore({
  version: 1,
  active: 'demo-2',
  accounts: [
    account({
      id: 'demo-1',
      label: 'work@example.com',
      org: 'Acme',
      threshold: 0.8,
      // Over its 80% threshold, so it has handed over and is waiting to reset.
      usage: {
        u5h: 0.83,
        reset5h: hours(2.3),
        u7d: 0.41,
        reset7d: hours(38),
        at: now,
      },
      parkedUntil: now + 2.3 * 3_600_000,
    }),
    account({
      id: 'demo-2',
      label: 'side@example.com',
      org: 'Side Project',
      usage: {
        u5h: 0.12,
        reset5h: hours(4.1),
        u7d: 0.52,
        reset7d: hours(20),
        at: now,
      },
    }),
    account({
      id: 'demo-3',
      label: 'personal@example.com',
      tier: 'max_20x',
      threshold: 0.9,
      usage: {
        u5h: 0.02,
        reset5h: hours(4.8),
        u7d: 0.14,
        reset7d: hours(52),
        at: now,
      },
    }),
  ],
})
