import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Redirect the account store into a throwaway directory for the whole test run.
 *
 * The auth `callback` writes real credentials to the store, so without this a
 * test that exercises the login flow appends fixture accounts to the developer's
 * own `~/.local/share/opencode/anthropic-accounts.json`.
 */
const dir = mkdtempSync(join(tmpdir(), 'oc-anthropic-test-'))
process.env.ANTHROPIC_ACCOUNTS_FILE = join(dir, 'accounts.json')
process.env.ANTHROPIC_STATUS_FILE = join(dir, 'status.json')
