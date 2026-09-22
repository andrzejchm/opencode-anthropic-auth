import { createInterface } from 'node:readline/promises'
import { addAccount } from './accounts/login.ts'
import {
  labelAccount,
  normalizeThreshold,
  resolveConfig,
} from './accounts/manager.ts'
import { needsRefresh, refreshAccount } from './accounts/refresh.ts'
import {
  effectiveU5h,
  effectiveU7d,
  isUsageStale,
  isUsageUnknown,
  ordered,
  stateOf,
  thresholdFor,
} from './accounts/selector.ts'
import { writeStatus } from './accounts/status.ts'
import {
  findAccount,
  loadStore,
  migrateFromOpencodeAuth,
  saveStore,
  statusPath,
  storePath,
  updateStore,
} from './accounts/store.ts'
import { probeUsage } from './accounts/usage.ts'
import { authorize, exchange } from './auth.ts'

const config = resolveConfig()

function fail(message: string): never {
  console.error(`error: ${message}`)
  process.exit(1)
}

function relative(ms: number | null): string {
  if (!ms) return '—'
  const delta = ms - Date.now()
  if (delta <= 0) return 'now'
  const hours = Math.floor(delta / 3_600_000)
  const minutes = Math.round((delta % 3_600_000) / 60_000)
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`
}

/**
 * Render a utilization we may not actually know.
 *
 * An expired or missing reading is shown as `?` rather than 0%: reporting a
 * confident 0 for an account we haven't heard from is how a exhausted
 * subscription ends up looking idle.
 */
function percent(value: number, known: boolean): string {
  return known ? `${Math.round(value * 100)}%` : '?'
}

function pad(value: string, width: number): string {
  return value.length > width
    ? `${value.slice(0, width - 1)}…`
    : value.padEnd(width)
}

function status(): void {
  const store = loadStore()
  if (store.accounts.length === 0) {
    console.log('No accounts. Run `oc-anthropic login`.')
    return
  }

  const now = Date.now()
  console.log(
    `   ${pad('#', 3)}${pad('ACCOUNT', 32)}${pad('ORG', 14)}${pad('TIER', 9)}${pad('5H', 6)}${pad('SWITCH', 8)}${pad('RESETS IN', 11)}${pad('7D', 6)}STATE`,
  )
  for (const [index, account] of ordered(store, config).entries()) {
    const state = stateOf(account, store, config, now)
    const marker = state === 'active' ? ' > ' : '   '
    const known = !isUsageStale(account, now) && !isUsageUnknown(account)
    const reset = known && account.usage ? account.usage.reset5h * 1000 : null
    console.log(
      marker +
        pad(String(index + 1), 3) +
        pad(account.label, 32) +
        pad(account.org ?? '—', 14) +
        pad(account.tier ?? '—', 9) +
        pad(percent(effectiveU5h(account, now), known), 6) +
        pad(`${Math.round(thresholdFor(account, config) * 100)}%`, 8) +
        pad(relative(reset), 11) +
        pad(percent(effectiveU7d(account, now), known), 6) +
        (state === 'active' ? 'ACTIVE' : state),
    )
    if (account.error) console.log(`      ! ${account.error.slice(0, 100)}`)
  }
  console.log(
    `\ndefault switch ${Math.round(config.switchThreshold * 100)}% · store ${storePath()} · status ${statusPath()}`,
  )
}

async function login(): Promise<void> {
  const result = await authorize('max')
  console.log(
    `\nOpen this URL, approve, then paste the code back here:\n\n${result.url}\n`,
  )

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const code = await rl.question('code: ')
  rl.close()

  const credentials = await exchange(
    code,
    result.verifier,
    result.redirectUri,
    result.state,
  )
  if (credentials.type === 'failed')
    fail('authorization failed — the code may have expired')

  const account = await addAccount(credentials, config)
  console.log(
    `\nadded ${account.label}${account.org ? ` (${account.org})` : ''}\n`,
  )
  await refresh()
}

/**
 * Poll live usage for every account.
 *
 * Renews the OAuth token first. Access tokens last about eight hours, so by
 * the time anyone reaches for this command they are usually expired — probing
 * with one returns 401 and the command would appear to do nothing at all.
 * Failures are reported per account rather than swallowed.
 */
async function refresh(): Promise<void> {
  const results = await Promise.all(
    loadStore().accounts.map(async (account) => {
      try {
        if (needsRefresh(account)) await refreshAccount(account)
      } catch (error) {
        return { label: account.label, error: message(error) }
      }

      const usage = await probeUsage(account.access)
      if (!usage) {
        return { label: account.label, error: 'usage endpoint did not respond' }
      }

      updateStore((store) => {
        const target = store.accounts.find((a) => a.id === account.id)
        if (!target) return
        target.usage = usage
        target.error = null
      })

      if (account.profileAt === null) await labelAccount(account, config)
      return { label: account.label, error: null }
    }),
  )

  writeStatus(loadStore(), config)
  status()

  const failures = results.filter((r) => r.error)
  if (failures.length > 0) {
    console.error('')
    for (const failure of failures) {
      console.error(`could not refresh ${failure.label}: ${failure.error}`)
    }
    console.error('\nRun `oc-anthropic login` to re-authorize an account.')
    process.exitCode = 1
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function reorder(labels: string[]): void {
  if (labels.length === 0) fail('usage: oc-anthropic order <label> [label...]')
  const store = loadStore()
  const resolved = labels.map((label) => {
    const account = findAccount(store, label)
    if (!account) fail(`unknown account: ${label}`)
    return account
  })
  const rest = store.accounts.filter((a) => !resolved.includes(a))
  store.accounts = [...resolved, ...rest]
  saveStore(store)
  writeStatus(store, config)
  status()
}

function relabel(needle: string, next: string): void {
  const store = loadStore()
  const account = findAccount(store, needle)
  if (!account) fail(`unknown account: ${needle}`)
  account.label = next
  saveStore(store)
  writeStatus(store, config)
  status()
}

function remove(needle: string): void {
  const store = loadStore()
  const account = findAccount(store, needle)
  if (!account) fail(`unknown account: ${needle}`)
  store.accounts = store.accounts.filter((a) => a.id !== account.id)
  if (store.active === account.id) store.active = store.accounts[0]?.id ?? null
  saveStore(store)
  writeStatus(store, config)
  status()
}

/** Force a switch by clearing the target's park and parking everything before it. */
function use(needle: string): void {
  const store = loadStore()
  const account = findAccount(store, needle)
  if (!account) fail(`unknown account: ${needle}`)
  account.parkedUntil = 0
  store.active = account.id
  for (const other of ordered(store, config)) {
    if (other.id === account.id) break
    other.parkedUntil = Math.max(other.parkedUntil, Date.now() + 60 * 60 * 1000)
  }
  saveStore(store)
  writeStatus(store, config)
  status()
}

/**
 * Set or clear an account's own switch threshold.
 *
 * `default` removes the override so the account follows the global setting
 * again; anything else accepts either `80` or `0.8`.
 */
function setThreshold(needle: string, raw: string): void {
  const store = loadStore()
  const account = findAccount(store, needle)
  if (!account) fail(`unknown account: ${needle}`)

  if (raw === 'default' || raw === 'none') {
    account.threshold = null
  } else {
    const value = normalizeThreshold(raw)
    if (value === null) fail(`threshold must be between 0 and 100 (got ${raw})`)
    account.threshold = value
  }

  saveStore(store)
  writeStatus(store, config)
  status()
}

/** Undo every park so the rotation starts clean from account #1. */
function unpark(): void {
  const store = loadStore()
  for (const account of store.accounts) {
    account.parkedUntil = 0
    account.error = null
  }
  saveStore(store)
  writeStatus(store, config)
  status()
}

/** CLI entrypoint. Exported so the published bin can be a thin JS shim. */
export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  const [command = 'status', ...args] = argv
  migrateFromOpencodeAuth()

  switch (command) {
    case 'status':
      status()
      break
    case 'login':
      await login()
      break
    case 'refresh':
      await refresh()
      break
    case 'order':
      reorder(args)
      break
    case 'label':
      if (args.length < 2)
        fail('usage: oc-anthropic label <account> <new-label>')
      relabel(args[0] as string, args[1] as string)
      break
    case 'threshold':
      if (args.length < 2)
        fail('usage: oc-anthropic threshold <account> <percent|default>')
      setThreshold(args[0] as string, args[1] as string)
      break
    case 'use':
      if (!args[0]) fail('usage: oc-anthropic use <account>')
      use(args[0])
      break
    case 'unpark':
      unpark()
      break
    case 'remove':
      if (!args[0]) fail('usage: oc-anthropic remove <account>')
      remove(args[0])
      break
    default:
      console.log(
        [
          'oc-anthropic <command>',
          '',
          '  status              show accounts and rotation state (default)',
          '  login               authorize another subscription',
          '  refresh             poll live usage for every account',
          '  order <label>...    set rotation order',
          '  label <acct> <new>  rename an account',
          '  threshold <acct> <n> per-account switch point, e.g. 80 (or `default`)',
          '  use <acct>          force-switch to an account now',
          '  unpark              clear all parks',
          '  remove <acct>       drop an account',
        ].join('\n'),
      )
  }
}
