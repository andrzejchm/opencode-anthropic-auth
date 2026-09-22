/**
 * Utilization we should act on right now.
 *
 * A stored snapshot describes a window that may already have rolled over. Once
 * `reset5h` is in the past the window is empty regardless of what the last
 * reading said, so this is what makes an account come back by itself after its
 * five hours elapse — no polling required.
 */
export function effectiveU5h(account, now) {
    const usage = account.usage;
    if (!usage)
        return 0;
    if (usage.reset5h && now >= usage.reset5h * 1000)
        return 0;
    return usage.u5h;
}
export function effectiveU7d(account, now) {
    const usage = account.usage;
    if (!usage)
        return 0;
    if (usage.reset7d && now >= usage.reset7d * 1000)
        return 0;
    return usage.u7d;
}
/**
 * The 5h utilization at which this specific account should hand over.
 *
 * Precedence is most-specific-wins: a value stored on the account (set via
 * `oc-anthropic threshold`) beats a `accountThresholds` entry in config, which
 * beats the global default. Letting each account differ matters because plans
 * differ — a 20x account can safely absorb far more before you step off it
 * than a 5x one.
 */
export function thresholdFor(account, config) {
    if (account.threshold !== null && account.threshold !== undefined) {
        return account.threshold;
    }
    return (config.accountThresholds[account.label] ??
        config.accountThresholds[account.id] ??
        config.switchThreshold);
}
/** Weekly limit exhausted — the account cannot serve anything until it resets. */
export function isBlocked(account, config, now) {
    return effectiveU7d(account, now) >= config.weeklyThreshold;
}
/** Under its threshold, not parked, not weekly-blocked. */
export function isEligible(account, config, now) {
    if (now < account.parkedUntil)
        return false;
    if (isBlocked(account, config, now))
        return false;
    return effectiveU5h(account, now) < thresholdFor(account, config);
}
/** Apply the configured rotation order; unlisted accounts keep store order. */
export function ordered(store, config) {
    if (config.accountOrder.length === 0)
        return store.accounts;
    const rank = (account) => {
        const index = config.accountOrder.findIndex((entry) => entry === account.id || entry === account.label);
        return index === -1 ? Number.MAX_SAFE_INTEGER : index;
    };
    return [...store.accounts].sort((a, b) => rank(a) - rank(b));
}
/**
 * Pick the account to serve the next request.
 *
 * First choice is the earliest account in rotation order that still has
 * headroom — which means a reset account is picked back up automatically, and
 * in preference to later ones.
 *
 * When nothing has headroom we do not fail: we fall back to the last usable
 * account and keep going until Anthropic actually rejects us. That is the
 * "stay on the last one until it runs out" case.
 */
export function select(store, config, now = Date.now()) {
    const candidates = ordered(store, config);
    if (candidates.length === 0)
        return null;
    const eligible = candidates.find((account) => isEligible(account, config, now));
    if (eligible)
        return { account: eligible, reason: 'eligible' };
    const usable = candidates.filter((account) => now >= account.parkedUntil && !isBlocked(account, config, now));
    const fallback = usable.at(-1);
    if (fallback)
        return { account: fallback, reason: 'last-resort' };
    // Everything is parked or weekly-blocked. Take whichever frees up soonest so
    // the resulting error names the shortest wait.
    const soonest = [...candidates].sort((a, b) => waitUntil(a, now) - waitUntil(b, now))[0];
    return soonest ? { account: soonest, reason: 'last-resort' } : null;
}
function waitUntil(account, now) {
    const reset = account.usage?.reset5h ? account.usage.reset5h * 1000 : now;
    return Math.max(account.parkedUntil, reset);
}
export function stateOf(account, store, config, now = Date.now()) {
    if (store.active === account.id)
        return 'active';
    if (isBlocked(account, config, now))
        return 'blocked';
    if (now < account.parkedUntil)
        return 'parked';
    if (effectiveU5h(account, now) >= thresholdFor(account, config))
        return 'parked';
    if (account.error)
        return 'error';
    return 'idle';
}
