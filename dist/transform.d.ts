export declare const MAX_SSE_LINE_BYTES: number;
export declare const MAX_JSON_TOOL_NAME_BYTES = 1024;
export type FetchInput = string | URL | Request;
/**
 * Merge headers from a Request object and/or a RequestInit headers value
 * into a single Headers instance.
 */
export declare function mergeHeaders(input: FetchInput, init?: RequestInit): Headers;
/**
 * Merge incoming beta headers with the required OAuth betas, deduplicating.
 */
export declare function mergeBetaHeaders(headers: Headers): string;
/**
 * Set OAuth-required headers on the request: authorization, beta, user-agent.
 * Removes x-api-key since we're using OAuth.
 *
 * `version` must be the same value passed to rewriteRequestBody for the same
 * request, otherwise the two reported versions disagree.
 */
export declare function setOAuthHeaders(headers: Headers, accessToken: string, version?: string): Headers;
/**
 * Add TOOL_PREFIX to tool names in the request body.
 * Prefixes both tool definitions and tool_use blocks in messages.
 */
export declare function prefixToolNames(parsed: Record<string, unknown>): string;
/**
 * Strip TOOL_PREFIX from tool names in streaming response text.
 */
export declare function stripToolPrefix(text: string): string;
/**
 * Check if TLS verification should be skipped for custom API endpoints.
 * Only effective when ANTHROPIC_BASE_URL is also set.
 */
export declare function isInsecure(): boolean;
/**
 * Rewrite the request URL to add ?beta=true for /v1/messages requests.
 * When ANTHROPIC_BASE_URL is set, overrides the origin (protocol + host)
 * for all API requests flowing through the fetch wrapper.
 * Returns the modified input and URL (if applicable).
 */
export declare function rewriteUrl(input: FetchInput): {
    input: FetchInput;
    url: URL | null;
};
/**
 * Sanitize OpenCode-branded strings from the system prompt text.
 *
 * 1. Removes the OPENCODE_IDENTITY paragraph.
 * 2. Removes any paragraph (text between blank lines) that contains
 *    one of the PARAGRAPH_REMOVAL_ANCHORS — typically URLs that
 *    identify OpenCode-specific content.
 * 3. Applies TEXT_REPLACEMENTS for inline occurrences of "OpenCode"
 *    inside paragraphs we want to keep.
 *
 * This approach is resilient to upstream rewording of the OpenCode
 * prompt — as long as the anchor strings (URLs, etc.) still appear
 * somewhere in the paragraph, the removal works.
 */
export declare function sanitizeSystemText(text: string): string;
type SystemBlock = {
    type: string;
    text: string;
    [k: string]: unknown;
};
/**
 * Sanitize system prompt and prepend Claude Code identity.
 * Handles all Anthropic API system formats: undefined, string, or array of text blocks.
 */
export declare function prependClaudeCodeIdentity(system: unknown): SystemBlock[];
/**
 * Rewrite the full request body: sanitize system prompt and prefix tool names.
 *
 * `version` must be the same value passed to setOAuthHeaders for the same
 * request, otherwise the two reported versions disagree.
 */
export declare function rewriteRequestBody(body: string, version?: string): string;
/**
 * Create a streaming response that strips the tool prefix from tool names.
 */
export declare function createStrippedStream(response: Response): Response;
export {};
