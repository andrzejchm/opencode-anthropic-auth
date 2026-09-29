export type AuthorizationResult = {
    url: string;
    redirectUri: string;
    state: string;
    verifier: string;
};
export declare function authorize(mode: 'max' | 'console'): Promise<AuthorizationResult>;
export type ExchangeResult = {
    type: 'success';
    refresh: string;
    access: string;
    expires: number;
} | {
    type: 'failed';
};
export type RefreshResult = {
    type: 'success';
    refresh: string;
    access: string;
    expires: number;
} | {
    type: 'failed';
    status: number;
};
/**
 * Exchange a refresh token for a new access/refresh token pair.
 *
 * Used only to satisfy OpenCode v2's own single-credential bookkeeping (the
 * `refresh` callback registered on the OAuth method). The multi-account
 * rotation path has its own refresh with retries and cross-process locking —
 * see `accounts/refresh.ts` — and does not call this function.
 */
export declare function refreshToken(refreshTokenValue: string): Promise<RefreshResult>;
export declare function exchange(input: string, verifier: string, redirectUri: string, expectedState?: string): Promise<ExchangeResult>;
