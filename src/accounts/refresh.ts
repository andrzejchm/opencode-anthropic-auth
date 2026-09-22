import { CLIENT_ID, TOKEN_URL } from '../constants.ts'
import { withLock } from './lock.ts'
import { loadStore, updateStore } from './store.ts'
import type { Account } from './types.ts'

/** Refresh a minute early so a token cannot expire mid-flight. */
const EXPIRY_SKEW_MS = 60_000

const inflight = new Map<string, Promise<string>>()

export function needsRefresh(account: Account, now = Date.now()): boolean {
  return (
    !account.access ||
    !account.expires ||
    account.expires - EXPIRY_SKEW_MS < now
  )
}

/** Has another process already refreshed this account for us? */
function freshTokenFromDisk(account: Account): string | null {
  const stored = loadStore().accounts.find((a) => a.id === account.id)
  if (!stored || needsRefresh(stored)) return null

  account.refresh = stored.refresh
  account.access = stored.access
  account.expires = stored.expires
  return stored.access
}

/**
 * Exchange an account's refresh token for a fresh access token.
 *
 * Deduplicated twice over, because Anthropic invalidates a refresh token the
 * moment it is exchanged, so two simultaneous exchanges revoke each other:
 *
 *  - within the process, concurrent callers share one inflight promise;
 *  - across processes, a file lock plus a re-read covers OpenCode's long-lived
 *    server racing the CLI or a second server.
 */
export async function refreshAccount(account: Account): Promise<string> {
  const existing = inflight.get(account.id)
  if (existing) return existing

  const promise = withLock(`anthropic-refresh-${account.id}`, async () => {
    // Re-read inside the lock: whoever held it before us may have just
    // refreshed this very account, and exchanging again would revoke it.
    const alreadyFresh = freshTokenFromDisk(account)
    if (alreadyFresh) return alreadyFresh

    return exchangeRefreshToken(account)
  }).finally(() => {
    inflight.delete(account.id)
  })

  inflight.set(account.id, promise)
  return promise
}

async function exchangeRefreshToken(account: Account): Promise<string> {
  return (async () => {
    const maxRetries = 2
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, 500 * 2 ** (attempt - 1)),
        )
      }

      try {
        const response = await fetch(TOKEN_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/plain, */*',
            'User-Agent': 'axios/1.13.6',
          },
          body: JSON.stringify({
            grant_type: 'refresh_token',
            // Re-read from disk: another process may have rotated it already.
            refresh_token: currentRefreshToken(account),
            client_id: CLIENT_ID,
          }),
        })

        if (!response.ok) {
          if (response.status >= 500 && attempt < maxRetries) {
            await response.body?.cancel()
            continue
          }
          const body = await response.text().catch(() => '')
          throw new Error(`Token refresh failed: ${response.status} — ${body}`)
        }

        const json = (await response.json()) as {
          refresh_token: string
          access_token: string
          expires_in: number
        }

        updateStore((store) => {
          const target = store.accounts.find((a) => a.id === account.id)
          if (!target) return
          target.refresh = json.refresh_token
          target.access = json.access_token
          target.expires = Date.now() + json.expires_in * 1000
          target.error = null
        })

        account.refresh = json.refresh_token
        account.access = json.access_token
        account.expires = Date.now() + json.expires_in * 1000
        return json.access_token
      } catch (error) {
        const isNetworkError =
          error instanceof Error &&
          (error.message.includes('fetch failed') ||
            ('code' in error &&
              (error.code === 'ECONNRESET' ||
                error.code === 'ECONNREFUSED' ||
                error.code === 'ETIMEDOUT' ||
                error.code === 'UND_ERR_CONNECT_TIMEOUT')))

        if (attempt < maxRetries && isNetworkError) continue
        throw error
      }
    }
    throw new Error('Token refresh exhausted all retries')
  })()
}

function currentRefreshToken(account: Account): string {
  try {
    return (
      loadStore().accounts.find((a) => a.id === account.id)?.refresh ??
      account.refresh
    )
  } catch {
    return account.refresh
  }
}
