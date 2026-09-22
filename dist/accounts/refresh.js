import { CLIENT_ID, TOKEN_URL } from "../constants.js";
import { loadStore, updateStore } from "./store.js";
/** Refresh a minute early so a token cannot expire mid-flight. */
const EXPIRY_SKEW_MS = 60_000;
const inflight = new Map();
export function needsRefresh(account, now = Date.now()) {
    return (!account.access ||
        !account.expires ||
        account.expires - EXPIRY_SKEW_MS < now);
}
/**
 * Exchange an account's refresh token for a fresh access token.
 *
 * Deduplicated per account: concurrent requests share one inflight refresh,
 * because Anthropic rotates the refresh token on every exchange and racing
 * exchanges invalidate each other.
 */
export async function refreshAccount(account) {
    const existing = inflight.get(account.id);
    if (existing)
        return existing;
    const promise = (async () => {
        const maxRetries = 2;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            if (attempt > 0) {
                await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
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
                });
                if (!response.ok) {
                    if (response.status >= 500 && attempt < maxRetries) {
                        await response.body?.cancel();
                        continue;
                    }
                    const body = await response.text().catch(() => '');
                    throw new Error(`Token refresh failed: ${response.status} — ${body}`);
                }
                const json = (await response.json());
                updateStore((store) => {
                    const target = store.accounts.find((a) => a.id === account.id);
                    if (!target)
                        return;
                    target.refresh = json.refresh_token;
                    target.access = json.access_token;
                    target.expires = Date.now() + json.expires_in * 1000;
                    target.error = null;
                });
                account.refresh = json.refresh_token;
                account.access = json.access_token;
                account.expires = Date.now() + json.expires_in * 1000;
                return json.access_token;
            }
            catch (error) {
                const isNetworkError = error instanceof Error &&
                    (error.message.includes('fetch failed') ||
                        ('code' in error &&
                            (error.code === 'ECONNRESET' ||
                                error.code === 'ECONNREFUSED' ||
                                error.code === 'ETIMEDOUT' ||
                                error.code === 'UND_ERR_CONNECT_TIMEOUT')));
                if (attempt < maxRetries && isNetworkError)
                    continue;
                throw error;
            }
        }
        throw new Error('Token refresh exhausted all retries');
    })().finally(() => {
        inflight.delete(account.id);
    });
    inflight.set(account.id, promise);
    return promise;
}
function currentRefreshToken(account) {
    try {
        return (loadStore().accounts.find((a) => a.id === account.id)?.refresh ??
            account.refresh);
    }
    catch {
        return account.refresh;
    }
}
