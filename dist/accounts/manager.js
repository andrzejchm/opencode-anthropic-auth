import { needsRefresh, refreshAccount } from "./refresh.js";
import { findPinned, isUsageStale, pinnedBlock, select } from "./selector.js";
import { writeStatus } from "./status.js";
import { loadStore, migrateFromOpencodeAuth, updateStore } from "./store.js";
import { DEFAULT_CONFIG } from "./types.js";
import { fetchProfile, isLimitResponse, parseUsageHeaders, probeUsage, resetFromResponse, } from "./usage.js";
/**
 * Read a boolean flag from a plugin option or its environment fallback.
 *
 * An explicit `false` option must win over a `true` environment variable, so
 * this checks `undefined` rather than falsiness — `false` is a real answer,
 * not "unset". Only `"1"` and `"true"` (case-insensitive) turn an environment
 * value on; anything else is treated as unset rather than silently enabling
 * pacing on a typo.
 */
function boolean(option, envValue, fallback) {
    if (typeof option === 'boolean')
        return option;
    if (envValue !== undefined) {
        const normalized = envValue.trim().toLowerCase();
        if (normalized === '1' || normalized === 'true')
            return true;
        if (normalized === '0' || normalized === 'false')
            return false;
    }
    return fallback;
}
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
        accountWeeklyThresholds: parseThresholds(options?.accountWeeklyThresholds),
        weeklyPacing: boolean(options?.weeklyPacing, process.env.ANTHROPIC_WEEKLY_PACING, DEFAULT_CONFIG.weeklyPacing),
        accountOrder: Array.isArray(options?.accountOrder)
            ? options.accountOrder.filter((e) => typeof e === 'string')
            : DEFAULT_CONFIG.accountOrder,
        pinnedFallback: typeof options?.pinnedFallback === 'boolean'
            ? options.pinnedFallback
            : DEFAULT_CONFIG.pinnedFallback,
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
/** `on`/`off` (also true/false, 1/0) for a CLI argument. Null for anything else. */
export function parsePacing(value) {
    const normalized = value.trim().toLowerCase();
    if (['on', 'true', '1', 'yes'].includes(normalized))
        return true;
    if (['off', 'false', '0', 'no'].includes(normalized))
        return false;
    return null;
}
/** A session's pinned account can't serve this request. */
export class PinnedAccountError extends Error {
    pin;
    reason;
    until;
    label;
    /** First sentence of the message: which account, what's wrong, until when. */
    summary;
    constructor(pin, reason, 
    /** Epoch ms when the account should be usable again, if known. */
    until, 
    /** Label of the matched account, when there is one. */
    label) {
        const summary = pinnedSummary(pin, reason, until, label);
        super(`${summary} This session is pinned to it (session metadata ` +
            '`anthropicAccount`), so no other account was used. Set the plugin ' +
            'option `pinnedFallback: true` to fall back to normal account ' +
            'selection instead.');
        this.pin = pin;
        this.reason = reason;
        this.until = until;
        this.label = label;
        this.name = 'PinnedAccountError';
        this.summary = summary;
    }
}
function pinnedSummary(pin, reason, until, label) {
    const name = label && label !== pin
        ? `Claude account "${label}" (pinned as "${pin}")`
        : `Claude account "${pin}"`;
    const when = until ? ` until ${new Date(until).toISOString()}` : '';
    switch (reason) {
        case 'not-found':
            return `${name} was not found in the accounts file.`;
        case 'parked':
            return `${name} has hit its usage limit and is parked${when}.`;
        case 'weekly-limit':
            return `${name} has reached its weekly limit${when || ' (reset time unknown)'}.`;
        case 'refresh-failed':
            return `${name} could not refresh its token and is parked${when}; re-authorize it.`;
    }
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
    async function refreshStaleUsage(onlyId) {
        const now = Date.now();
        const stale = loadStore().accounts.filter((account) => (onlyId === undefined || account.id === onlyId) &&
            isUsageStale(account, now) &&
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
    /** Refresh the token if due. On failure, park the account and return false. */
    async function ensureFresh(account) {
        if (!needsRefresh(account))
            return true;
        try {
            await refreshAccount(account);
            return true;
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
            return false;
        }
    }
    // Label lazily, once: migrated accounts are named the first time they
    // serve a request. Guarded by profileAt so an account that genuinely has
    // no org doesn't re-request its profile on every call.
    function labelLazily(account) {
        if (account.profileAt === null || account.profileAt === undefined) {
            void labelAccount(account, config);
        }
    }
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
            if (!(await ensureFresh(account)))
                return null;
            labelLazily(account);
            const updated = updateStore((s) => {
                s.active = account.id;
            });
            writeStatus(updated, config);
            return account;
        },
        async acquirePinned(pin) {
            const target = findPinned(loadStore(), pin);
            if (!target)
                throw new PinnedAccountError(pin, 'not-found', null);
            await refreshStaleUsage(target.id);
            const account = findPinned(loadStore(), pin);
            if (!account)
                throw new PinnedAccountError(pin, 'not-found', null);
            const block = pinnedBlock(account, config, Date.now());
            if (block) {
                throw new PinnedAccountError(pin, block.reason, block.until, account.label);
            }
            if (!(await ensureFresh(account))) {
                const parked = findPinned(loadStore(), pin);
                throw new PinnedAccountError(pin, 'refresh-failed', parked?.parkedUntil || null, account.label);
            }
            labelLazily(account);
            // Deliberately leaves the store's `active` pointer and `lastActive`
            // alone: those describe unpinned rotation, and a pinned session using
            // someone's account must not look like (or cause) a switch for everyone
            // else.
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
