import { afterEach, describe, expect, mock, test } from 'bun:test'
import {
  fetchProfile,
  isLimitResponse,
  parseUsageHeaders,
  probeUsage,
  resetFromResponse,
} from '../accounts/usage.ts'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('parseUsageHeaders', () => {
  test('reads the unified rate-limit headers Anthropic stamps on every response', () => {
    const usage = parseUsageHeaders(
      new Headers({
        'anthropic-ratelimit-unified-5h-utilization': '0.06',
        'anthropic-ratelimit-unified-5h-reset': '1790035800',
        'anthropic-ratelimit-unified-7d-utilization': '0.27',
        'anthropic-ratelimit-unified-7d-reset': '1790031600',
      }),
    )

    expect(usage).toMatchObject({
      u5h: 0.06,
      reset5h: 1790035800,
      u7d: 0.27,
      reset7d: 1790031600,
    })
  })

  test('returns null when the headers are absent', () => {
    // Non-inference endpoints carry no rate-limit headers; treating a missing
    // reading as 0% would wrongly make a spent account look fresh.
    expect(parseUsageHeaders(new Headers())).toBeNull()
  })

  test('defaults the weekly fields when only the 5h window is reported', () => {
    const usage = parseUsageHeaders(
      new Headers({ 'anthropic-ratelimit-unified-5h-utilization': '0.5' }),
    )
    expect(usage).toMatchObject({ u5h: 0.5, reset5h: 0, u7d: 0, reset7d: 0 })
  })

  test('ignores an unparseable utilization', () => {
    expect(
      parseUsageHeaders(
        new Headers({ 'anthropic-ratelimit-unified-5h-utilization': 'n/a' }),
      ),
    ).toBeNull()
  })
})

describe('isLimitResponse', () => {
  test('treats 429 as a limit', () => {
    expect(isLimitResponse(new Response(null, { status: 429 }), '')).toBe(true)
  })

  test('treats a rejected unified status as a limit', () => {
    const response = new Response(null, {
      status: 400,
      headers: { 'anthropic-ratelimit-unified-5h-status': 'rejected' },
    })
    expect(isLimitResponse(response, '')).toBe(true)
  })

  test('recognises the 400 that Anthropic disguises usage limits as', () => {
    const response = new Response(null, { status: 400 })
    expect(isLimitResponse(response, "You're out of extra usage.")).toBe(true)
  })

  test('leaves ordinary 400s alone', () => {
    // Rotating on a malformed request would burn every account on one bad call.
    const response = new Response(null, { status: 400 })
    expect(isLimitResponse(response, 'invalid_request_error: bad model')).toBe(
      false,
    )
  })

  test('leaves 500s alone', () => {
    expect(isLimitResponse(new Response(null, { status: 500 }), '')).toBe(false)
  })
})

describe('resetFromResponse', () => {
  test('prefers the 5h reset header', () => {
    const response = new Response(null, {
      headers: {
        'anthropic-ratelimit-unified-5h-reset': '1790035800',
        'anthropic-ratelimit-unified-reset': '1790000000',
      },
    })
    expect(resetFromResponse(response)).toBe(1790035800)
  })

  test('falls back to the generic reset header', () => {
    const response = new Response(null, {
      headers: { 'anthropic-ratelimit-unified-reset': '1790000000' },
    })
    expect(resetFromResponse(response)).toBe(1790000000)
  })

  test('returns 0 when no reset is stated', () => {
    expect(resetFromResponse(new Response(null))).toBe(0)
  })
})

describe('probeUsage', () => {
  test('converts the endpoint percentages into fractions', async () => {
    // /api/oauth/usage reports 5.0 for 5%, while the headers report 0.05.
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            five_hour: {
              utilization: 5.0,
              resets_at: '2026-09-22T00:10:00.000Z',
            },
            seven_day: { utilization: 28.0, resets_at: null },
          }),
        ),
      ),
    ) as unknown as typeof fetch

    const usage = await probeUsage('access')

    expect(usage?.u5h).toBe(0.05)
    expect(usage?.u7d).toBe(0.28)
    expect(usage?.reset5h).toBe(
      Math.floor(new Date('2026-09-22T00:10:00.000Z').getTime() / 1000),
    )
    expect(usage?.reset7d).toBe(0)
  })

  test('returns null on a failed request rather than reporting zero usage', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(null, { status: 401 })),
    ) as unknown as typeof fetch

    expect(await probeUsage('access')).toBeNull()
  })

  test('returns null when the network is down', async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new Error('fetch failed')),
    ) as unknown as typeof fetch

    expect(await probeUsage('access')).toBeNull()
  })
})

describe('fetchProfile', () => {
  test('extracts the identity used to label an account', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            account: { uuid: 'uuid-1', email: 'you@work.example' },
            organization: {
              name: 'Acme',
              rate_limit_tier: 'default_claude_max_5x',
            },
          }),
        ),
      ),
    ) as unknown as typeof fetch

    expect(await fetchProfile('access')).toEqual({
      uuid: 'uuid-1',
      email: 'you@work.example',
      org: 'Acme',
      tier: 'max_5x',
    })
  })

  test('handles a personal account with no organization', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            account: { uuid: 'uuid-2', email: 'you@personal.example' },
          }),
        ),
      ),
    ) as unknown as typeof fetch

    expect(await fetchProfile('access')).toEqual({
      uuid: 'uuid-2',
      email: 'you@personal.example',
      org: null,
      tier: null,
    })
  })

  test('returns null when the payload lacks an identity', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ account: {} }))),
    ) as unknown as typeof fetch

    expect(await fetchProfile('access')).toBeNull()
  })
})
