import { writeStatus } from "./status.js";
import { loadStore, saveStore } from "./store.js";
import { DEFAULT_CONFIG, } from "./types.js";
import { fetchProfile } from "./usage.js";
/**
 * Locate an existing row for the subscription this profile describes.
 *
 * The account uuid is the identity, but an account migrated from OpenCode's
 * single credential is stored under a locally generated id until its profile
 * is first read — and that read never happens if its token has been revoked.
 * Falling back to the email stops re-authorizing such an account from adding a
 * duplicate instead of repairing the original.
 */
function findSameSubscription(store, profile) {
    return (store.accounts.find((a) => a.id === profile.uuid) ??
        store.accounts.find((a) => a.label === profile.email));
}
/** A label given at connect time is already used by a different account. */
export class LabelConflictError extends Error {
    label;
    constructor(label) {
        super(`Another Claude account is already labelled "${label}". Choose a different label.`);
        this.label = label;
        this.name = 'LabelConflictError';
    }
}
/**
 * Add a freshly authorized subscription to the store.
 *
 * Identity comes from `/api/oauth/profile` rather than from anything the user
 * types, so an account cannot be mislabelled. The profile uuid also dedupes:
 * re-authorizing an existing account refreshes it in place instead of adding a
 * duplicate row. A label passed in `options` only names the row; identity is
 * still the profile uuid.
 */
export async function addAccount(credentials, config = DEFAULT_CONFIG, options = {}) {
    const profile = await fetchProfile(credentials.access);
    const store = loadStore();
    const existing = profile
        ? (findSameSubscription(store, profile) ??
            store.accounts.find((a) => a.email === profile.email))
        : undefined;
    const label = options.label?.trim() || undefined;
    if (label &&
        store.accounts.some((a) => a !== existing && (a.label === label || a.id === label))) {
        throw new LabelConflictError(label);
    }
    if (existing && profile && existing.id !== profile.uuid) {
        // Matched by email: adopt the real identity so future logins match on uuid.
        if (store.active === existing.id)
            store.active = profile.uuid;
        existing.id = profile.uuid;
    }
    if (existing) {
        existing.refresh = credentials.refresh;
        existing.access = credentials.access;
        existing.expires = credentials.expires;
        existing.parkedUntil = 0;
        existing.error = null;
        if (profile) {
            // An account that was given its own label keeps it on a plain
            // re-login; only a newly supplied label replaces it.
            if (label)
                existing.label = label;
            else if (existing.email === undefined)
                existing.label = profile.email;
            if (existing.label !== profile.email)
                existing.email = profile.email;
            else
                delete existing.email;
            existing.org = profile.org;
            existing.tier = profile.tier;
            existing.profileAt = Date.now();
            existing.error = null;
        }
        else if (label) {
            existing.label = label;
        }
        saveStore(store);
        writeStatus(store, config);
        return existing;
    }
    const account = {
        id: profile?.uuid ?? crypto.randomUUID(),
        label: label ?? profile?.email ?? `account-${store.accounts.length + 1}`,
        ...(label && profile && label !== profile.email
            ? { email: profile.email }
            : {}),
        org: profile?.org ?? null,
        tier: profile?.tier ?? null,
        refresh: credentials.refresh,
        access: credentials.access,
        expires: credentials.expires,
        usage: null,
        profileAt: profile ? Date.now() : null,
        threshold: null,
        weeklyThreshold: null,
        parkedUntil: 0,
        lastUsed: null,
        error: null,
    };
    store.accounts.push(account);
    if (!store.active)
        store.active = account.id;
    saveStore(store);
    writeStatus(store, config);
    return account;
}
