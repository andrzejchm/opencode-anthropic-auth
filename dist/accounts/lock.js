import { closeSync, mkdirSync, openSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir } from "./store.js";
/**
 * How long a lock may be held before another process may break it.
 *
 * A refresh is two HTTP requests with retries, so this is generous. The cost of
 * breaking too early is the very race the lock exists to prevent; the cost of
 * breaking too late is a short stall.
 */
const STALE_MS = 30_000;
const POLL_MS = 50;
function lockPath(name) {
    return join(dataDir(), `.${name}.lock`);
}
function isStale(path) {
    try {
        return Date.now() - statSync(path).mtimeMs > STALE_MS;
    }
    catch {
        // Vanished between checks — treat as free.
        return true;
    }
}
/**
 * Run `fn` while holding a cross-process lock.
 *
 * Needed because OpenCode runs a long-lived server while the CLI runs
 * separately, and Anthropic invalidates a refresh token the moment it is
 * exchanged. Two processes refreshing the same account at once therefore
 * revoke each other's credentials. In-process deduplication cannot see that.
 *
 * Falls back to running unlocked rather than failing: a missed lock degrades
 * to the old racy behaviour, while refusing to proceed would break the request
 * outright.
 */
export async function withLock(name, fn, timeoutMs = STALE_MS) {
    const path = lockPath(name);
    mkdirSync(dirname(path), { recursive: true });
    const deadline = Date.now() + timeoutMs;
    let held = false;
    while (Date.now() < deadline) {
        try {
            // `wx` fails if the file exists, which makes creation the atomic test.
            closeSync(openSync(path, 'wx'));
            held = true;
            break;
        }
        catch {
            if (isStale(path)) {
                rmSync(path, { force: true });
                continue;
            }
            await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        }
    }
    try {
        return await fn();
    }
    finally {
        if (held)
            rmSync(path, { force: true });
    }
}
