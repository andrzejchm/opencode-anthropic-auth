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
export declare function exchange(input: string, verifier: string, redirectUri: string, expectedState?: string): Promise<ExchangeResult>;
