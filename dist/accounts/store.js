import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync, } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
/**
 * OpenCode's data directory. Honours `XDG_DATA_HOME` the same way OpenCode
 * does, so the store sits next to `auth.json` on every platform we support.
 */
export function dataDir() {
    const xdg = process.env.XDG_DATA_HOME;
    return join(xdg?.trim() ? xdg : join(homedir(), '.local', 'share'), 'opencode');
}
export function storePath() {
    return (process.env.ANTHROPIC_ACCOUNTS_FILE ||
        join(dataDir(), 'anthropic-accounts.json'));
}
export function statusPath() {
    return (process.env.ANTHROPIC_STATUS_FILE ||
        join(dataDir(), 'anthropic-status.json'));
}
/**
 * OpenCode's own single-slot credential file, read once to seed the store.
 *
 * Overridable so tests never touch the developer's real credentials — without
 * it, migration reads `~/.local/share/opencode/auth.json` even when the store
 * itself has been redirected.
 */
function opencodeAuthPath() {
    return process.env.OPENCODE_AUTH_FILE || join(dataDir(), 'auth.json');
}
/**
 * A fresh empty store.
 *
 * Built per call rather than spread from a shared constant: callers mutate the
 * returned object (`accounts.push(...)`), and a shallow copy would leave every
 * "empty" store sharing one array — so accounts added while the file is
 * missing would leak into subsequent reads.
 */
function emptyStore() {
    return { version: 1, active: null, accounts: [] };
}
export function loadStore() {
    try {
        const raw = readFileSync(storePath(), 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || !Array.isArray(parsed.accounts))
            return emptyStore();
        return {
            version: 1,
            active: parsed.active ?? null,
            accounts: parsed.accounts,
        };
    }
    catch {
        // Missing or corrupt store is not fatal — migration repopulates it.
        return emptyStore();
    }
}
/**
 * Write the store atomically.
 *
 * `tmp` + `rename` so a concurrent reader never sees a half-written file, and
 * `0600` because this holds refresh tokens.
 */
export function saveStore(store) {
    const path = storePath();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
    try {
        chmodSync(path, 0o600);
    }
    catch {
        /* best-effort on filesystems without POSIX modes */
    }
}
/**
 * Apply `mutate` to the freshest copy of the store, then persist.
 *
 * Re-reads immediately before mutating because several OpenCode servers (and
 * the CLI) can touch the file concurrently; the in-memory copy a caller is
 * holding may already be stale.
 */
export function updateStore(mutate) {
    const store = loadStore();
    mutate(store);
    saveStore(store);
    return store;
}
/**
 * Seed the store from OpenCode's single-slot credential.
 *
 * Runs once, when multi-account support is first enabled: the existing login
 * becomes account #1 so nobody has to re-authenticate to adopt the fork.
 */
export function migrateFromOpencodeAuth() {
    const store = loadStore();
    if (store.accounts.length > 0)
        return null;
    try {
        const auth = JSON.parse(readFileSync(opencodeAuthPath(), 'utf8'));
        const entry = auth.anthropic;
        if (entry?.type !== 'oauth' || !entry.refresh || !entry.access)
            return null;
        const account = {
            id: crypto.randomUUID(),
            label: 'imported',
            org: null,
            tier: null,
            refresh: entry.refresh,
            access: entry.access,
            expires: entry.expires ?? 0,
            usage: null,
            profileAt: null,
            threshold: null,
            parkedUntil: 0,
            lastUsed: null,
            error: null,
        };
        saveStore({ version: 1, active: account.id, accounts: [account] });
        return account;
    }
    catch {
        return null;
    }
}
export function findAccount(store, needle) {
    return (store.accounts.find((a) => a.id === needle) ??
        store.accounts.find((a) => a.label === needle) ??
        store.accounts.find((a) => a.label.startsWith(needle)));
}
