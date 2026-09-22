import { needsRefresh, refreshAccount } from "./refresh.js";
import { isUsageStale, select } from "./selector.js";
import { writeStatus } from "./status.js";
import { loadStore, migrateFromOpencodeAuth, updateStore } from "./store.js";
import { DEFAULT_CONFIG } from "./types.js";
import { fetchProfile, isLimitResponse, parseUsageHeaders, probeUsage, resetFromResponse, } from "./usage.js";
/** Read plugin options, falling back to env vars and then defaults. */
export function resolveConfig(options) {
    const numeric = (value, fallback) => {
        const parsed = typeof value === 'string' ? Number(value) : value;
        return typeof parsed === 'number' &&
            Number.isFinite(parsed) &&
            parsed > 0 &&
            parsed <= 1
            ? parsed
            : fallback;
    };
    return {
        switchThreshold: numeric(options?.switchThreshold ?? process.env.ANTHROPIC_SWITCH_THRESHOLD, DEFAULT_CONFIG.switchThreshold),
        weeklyThreshold: numeric(options?.weeklyThreshold ?? process.env.ANTHROPIC_WEEKLY_THRESHOLD, DEFAULT_CONFIG.weeklyThreshold),
        accountThresholds: parseThresholds(options?.accountThresholds),
        accountOrder: Array.isArray(options?.accountOrder)
            ? options.accountOrder.filter((e) => typeof e === 'string')
            : DEFAULT_CONFIG.accountOrder,
    };
}
/**
 * Read a `{ label: threshold }` map from config.
 *
 * Accepts percentages as well as fractions, because `80` is the obvious thing
 * to write in a config file and silently treating it as out-of-range would make
 * the account never hand over.
 */
function parseThresholds(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return {};
    const out = {};
    for (const [key, value] of Object.entries(raw)) {
        const parsed = normalizeThreshold(value);
        if (parsed !== null)
            out[key] = parsed;
    }
    return out;
}
/** `0.8` and `80` both mean 80%. Returns null for anything unusable. */
export function normalizeThreshold(value) {
    const parsed = typeof value === 'string' ? Number(value) : value;
    if (typeof parsed !== 'number' || !Number.isFinite(parsed))
        return null;
    const fraction = parsed > 1 ? parsed / 100 : parsed;
    if (fraction <= 0 || fraction > 1)
        return null;
    return fraction;
}
/** Don't re-probe the same account more often than this. */
const PROBE_COOLDOWN_MS = 60_000;
export function createManager(config, log) {
    migrateFromOpencodeAuth();
    let lastActive = null;
    const lastProbe = new Map();
    /**
     * Replace expired snapshots with live readings.
     *
     * Without this the selector would take an expired window to mean an empty
     * one, and happily route to an account that has since been exhausted by
     * another client. Only stale accounts are probed, and only once a minute
     * each, so the steady-state cost is nothing — response headers keep active
     * accounts current for free.
     */
    async function refreshStaleUsage() {
        const now = Date.now();
        const stale = loadStore().accounts.filter((account) => isUsageStale(account, now) &&
            now - (lastProbe.get(account.id) ?? 0) > PROBE_COOLDOWN_MS &&
            !needsRefresh(account));
        if (stale.length === 0)
            return;
        await Promise.all(stale.map(async (account) => {
            lastProbe.set(account.id, now);
            const usage = await probeUsage(account.access);
            if (!usage)
                return;
            sync((accounts) => {
                const target = accounts.find((a) => a.id === account.id);
                if (target)
                    target.usage = usage;
            });
        }));
    }
    const sync = (mutate) => {
        const store = updateStore((s) => mutate(s.accounts));
        writeStatus(store, config);
    };
    return {
        size: () => loadStore().accounts.length,
        async acquire() {
            await refreshStaleUsage();
            const store = loadStore();
            const selection = select(store, config);
            if (!selection)
                return null;
            const account = selection.account;
            if (account.id !== lastActive) {
                const previous = store.accounts.find((a) => a.id === lastActive);
                log('info', previous
                    ? `switched to ${account.label} (${pct(account)}) — left ${previous.label} at ${pct(previous)}`
                    : `using ${account.label} (${pct(account)})`);
                lastActive = account.id;
            }
            if (needsRefresh(account)) {
                try {
                    await refreshAccount(account);
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    // A revoked refresh token is permanent until the user logs in again,
                    // so park the account rather than letting one dead credential fail
                    // every request while other accounts sit idle.
                    const revoked = message.includes('invalid_grant');
                    log('error', revoked
                        ? `${account.label} needs re-authorization — run \`oc-anthropic login\` (${message})`
                        : `${account.label} token refresh failed: ${message}`);
                    sync((accounts) => {
                        const target = accounts.find((a) => a.id === account.id);
                        if (!target)
                            return;
                        target.error = message;
                        target.parkedUntil = Date.now() + (revoked ? 24 * 3600_000 : 60_000);
                    });
                    return null;
                }
            }
            // Label lazily, once: migrated accounts are named the first time they
            // serve a request. Guarded by profileAt so an account that genuinely has
            // no org doesn't re-request its profile on every call.
            if (account.profileAt === null || account.profileAt === undefined) {
                void labelAccount(account, config);
            }
            const updated = updateStore((s) => {
                s.active = account.id;
            });
            writeStatus(updated, config);
            return account;
        },
        record(account, response) {
            const usage = parseUsageHeaders(response.headers);
            if (!usage)
                return;
            sync((accounts) => {
                const target = accounts.find((a) => a.id === account.id);
                if (!target)
                    return;
                target.usage = usage;
                target.lastUsed = Date.now();
                target.error = null;
            });
        },
        park(account, response, body) {
            const reset = resetFromResponse(response);
            // Without a stated reset, park for the rest of a nominal window rather
            // than hammering an account we already know is rejecting us.
            const until = reset ? reset * 1000 : Date.now() + 5 * 60 * 60 * 1000;
            log('warn', `${account.label} hit its limit — parked until ${new Date(until).toISOString()}`);
            sync((accounts) => {
                const target = accounts.find((a) => a.id === account.id);
                if (!target)
                    return;
                target.parkedUntil = until;
                target.error = body.slice(0, 200) || `HTTP ${response.status}`;
            });
        },
        isLimit: isLimitResponse,
    };
}
function pct(account) {
    return account.usage
        ? `5h ${Math.round(account.usage.u5h * 100)}%`
        : '5h unknown';
}
/**
 * Name an account from its own profile, so labels can't be mixed up.
 *
 * Also adopts Anthropic's account uuid as the local id. Imported and
 * locally-generated ids would otherwise let the same subscription be added
 * twice, since `addAccount` dedupes on the profile uuid.
 */
export async function labelAccount(account, config) {
    const profile = await fetchProfile(account.access);
    if (!profile)
        return;
    const previousId = account.id;
    const store = updateStore((s) => {
        const target = s.accounts.find((a) => a.id === previousId);
        if (!target)
            return;
        if (target.label === 'imported' || !target.label)
            target.label = profile.email;
        target.org = profile.org;
        target.tier = profile.tier;
        target.profileAt = Date.now();
        if (target.id !== profile.uuid) {
            const clash = s.accounts.find((a) => a.id === profile.uuid && a !== target);
            // Already present under its real id — drop the duplicate row.
            if (clash) {
                s.accounts = s.accounts.filter((a) => a !== target);
            }
            else {
                target.id = profile.uuid;
            }
            if (s.active === previousId)
                s.active = profile.uuid;
        }
    });
    account.id = profile.uuid;
    writeStatus(store, config);
}
