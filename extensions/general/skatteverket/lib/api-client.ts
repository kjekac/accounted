import crypto from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { refreshAccessToken } from './oauth'
import { getTokens, storeTokens } from './token-store'
import type { SkatteverketTokens } from '../types'

/**
 * Skatteverket API client.
 *
 * Handles:
 * - Automatic token refresh (transparent to callers)
 * - Required API gateway headers
 * - Rate limiting (4 req/sec per consumer)
 * - Correlation ID generation
 */

const DEFAULT_API_BASE_URL = 'https://api.test.skatteverket.se/momsdeklaration/v1'
const MAX_REFRESH_COUNT = 10
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000 // Refresh 5 min before expiry

// Simple in-memory token bucket for 4 req/sec rate limit
let lastRequestTime = 0
const MIN_REQUEST_INTERVAL_MS = 250 // 1000ms / 4 = 250ms

function getApiBaseUrl(): string {
  return process.env.SKATTEVERKET_API_BASE_URL || DEFAULT_API_BASE_URL
}

function getApiGwClientId(): string {
  const id = process.env.SKATTEVERKET_APIGW_CLIENT_ID
  if (!id) throw new Error('SKATTEVERKET_APIGW_CLIENT_ID is required')
  return id
}

function getApiGwClientSecret(): string {
  const secret = process.env.SKATTEVERKET_APIGW_CLIENT_SECRET
  if (!secret) throw new Error('SKATTEVERKET_APIGW_CLIENT_SECRET is required')
  return secret
}

/**
 * Ensure rate limit compliance (4 req/sec).
 * Delays if the last request was too recent.
 */
async function enforceRateLimit(): Promise<void> {
  const now = Date.now()
  const elapsed = now - lastRequestTime
  lastRequestTime = now // Claim the slot immediately to prevent concurrent bypass
  if (elapsed < MIN_REQUEST_INTERVAL_MS) {
    await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_INTERVAL_MS - elapsed))
  }
}

// Coalesce concurrent refresh attempts within this Node.js process. Without
// this, two parallel SKV requests from the same user (e.g. rapid UI clicks)
// would both call SKV's /token endpoint with the same refresh_token; SKV
// rotates that token on first use, so the second call would fail with 401.
// Cross-process races (separate Vercel function instances) are mitigated by
// the re-read inside the critical section: if another process refreshed
// while we waited on the network, we just use that newer token.
const refreshInFlight = new Map<string, Promise<string>>()

/**
 * Get a valid access token, refreshing if needed.
 * Throws if no tokens exist or refresh is exhausted.
 */
async function getValidToken(
  supabase: SupabaseClient,
  userId: string
): Promise<string> {
  const tokens = await getTokens(supabase, userId)
  if (!tokens) {
    throw new SkatteverketAuthError(
      'Inte ansluten till Skatteverket. Anslut med BankID först.',
      'NOT_CONNECTED'
    )
  }

  // Token still valid (with 5-min margin)
  if (tokens.expires_at > Date.now() + TOKEN_REFRESH_MARGIN_MS) {
    return tokens.access_token
  }

  // Need refresh — coalesce concurrent attempts.
  const inFlight = refreshInFlight.get(userId)
  if (inFlight) return inFlight

  const promise = refreshTokenForUser(supabase, userId)
    .finally(() => refreshInFlight.delete(userId))
  refreshInFlight.set(userId, promise)
  return promise
}

async function refreshTokenForUser(
  supabase: SupabaseClient,
  userId: string,
): Promise<string> {
  // Re-read after entering the critical section. Another process may have
  // refreshed while we were waiting; if so, the row now has a new
  // refresh_token and a future expiry — just hand it back.
  const tokens = await getTokens(supabase, userId)
  if (!tokens) {
    throw new SkatteverketAuthError(
      'Inte ansluten till Skatteverket. Anslut med BankID först.',
      'NOT_CONNECTED'
    )
  }
  if (tokens.expires_at > Date.now() + TOKEN_REFRESH_MARGIN_MS) {
    return tokens.access_token
  }
  if (!tokens.refresh_token) {
    throw new SkatteverketAuthError(
      'Sessionen har gått ut. Logga in med BankID igen.',
      'SESSION_EXPIRED'
    )
  }
  if (tokens.refresh_count >= MAX_REFRESH_COUNT) {
    throw new SkatteverketAuthError(
      'Maximalt antal förnyelser uppnått. Logga in med BankID igen.',
      'REFRESH_EXHAUSTED'
    )
  }

  const refreshed = await refreshAccessToken(tokens.refresh_token, tokens.refresh_count)
  const updatedTokens: SkatteverketTokens = {
    ...refreshed,
    scope: tokens.scope,
  }
  await storeTokens(supabase, userId, updatedTokens)
  return updatedTokens.access_token
}

/**
 * Make an authenticated request to the Skatteverket API.
 *
 * Automatically handles:
 * - Token refresh if expired
 * - Required headers (Client_Id, Client_Secret, correlation ID)
 * - Rate limiting
 */
export async function skvRequest(
  supabase: SupabaseClient,
  userId: string,
  method: string,
  path: string,
  body?: unknown,
  options?: { baseUrl?: string; contentType?: string }
): Promise<Response> {
  const accessToken = await getValidToken(supabase, userId)

  await enforceRateLimit()

  const url = `${options?.baseUrl || getApiBaseUrl()}${path}`
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${accessToken}`,
    'Client_Id': getApiGwClientId(),
    'Client_Secret': getApiGwClientSecret(),
    'skv_client_correlation_id': crypto.randomUUID(),
  }

  // contentType defaults to application/json, which is right for moms +
  // skattekonto. AGI's POST /underlag takes application/xml — callers pass
  // the XML as a string body and override contentType.
  let serializedBody: string | undefined
  if (body !== undefined) {
    const contentType = options?.contentType ?? 'application/json'
    headers['Content-Type'] = contentType
    serializedBody = typeof body === 'string' ? body : JSON.stringify(body)
  }

  const response = await fetch(url, {
    method,
    headers,
    body: serializedBody,
  })

  // Handle Skatteverket-specific auth/throttle errors uniformly so callers
  // can catch a single error type rather than parsing status codes inline.
  if (response.status === 401) {
    throw new SkatteverketAuthError(
      'Sessionen har gått ut. Logga in med BankID igen.',
      'SESSION_EXPIRED'
    )
  }

  if (response.status === 403) {
    const text = await response.text()
    // Missing scope on the access token — fires when an existing connection
    // pre-dates an extension that needed a new scope (the AGI/`agd` rollout
    // is the canonical example). The user has to disconnect + reconnect to
    // re-issue a token with the broader scope set; we want to say so
    // explicitly instead of letting it surface as a generic 403.
    // Body shape per SKV's AGI service description (Tjänstebeskrivning v1.7
    // §4.1.2.2): { "error": "invalid_scope", "description": "The required
    // scope agd has been requested for that access token." }
    if (text.includes('invalid_scope') || text.includes('required scope')) {
      throw new SkatteverketAuthError(
        'Anslutningen mot Skatteverket saknar nödvändig behörighet för denna ' +
        'tjänst. Koppla bort och anslut igen via Inställningar → Skatteverket ' +
        'för att förnya tokenen med rätt scope.',
        'MISSING_SCOPE'
      )
    }
    // Behörighet saknas — user is authenticated but not authorized for this company
    if (text.includes('Behörighet') || text.includes('behörighet')) {
      throw new SkatteverketAuthError(
        'Du har inte behörighet att agera för detta företag hos Skatteverket. ' +
        'Kontrollera att du är registrerad som firmatecknare eller deklarationsombud.',
        'BEHORIGHET_SAKNAS'
      )
    }
    throw new SkatteverketAuthError(
      `Åtkomst nekad av Skatteverket (403): ${text}`,
      'ACCESS_DENIED'
    )
  }

  if (response.status === 429) {
    // Skatteverket may include a Retry-After header. We surface a generic
    // Swedish message — callers can inspect the header on the thrown error
    // if they need to schedule a retry. The 4 req/sec local rate limiter
    // should normally prevent this; a 429 here implies the per-consumer
    // gateway quota was exceeded.
    throw new SkatteverketAuthError(
      'Skatteverket är överbelastat eller har strypt anropen. Försök igen om en stund.',
      'RATE_LIMITED'
    )
  }

  return response
}

/**
 * Structured error for Skatteverket auth/access/throttle issues.
 * The `code` field helps the frontend show appropriate UI.
 *
 * Codes:
 *   NOT_CONNECTED      — no tokens stored; user needs to run BankID flow
 *   SESSION_EXPIRED    — 401 from SKV; refresh exhausted or token rejected
 *   REFRESH_EXHAUSTED  — refresh count hit cap (10) before user re-auth
 *   BEHORIGHET_SAKNAS  — 403 with "Behörighet" body; user not authorized
 *                        for this company at SKV (firmatecknare / ombud)
 *   MISSING_SCOPE      — 403 with "invalid_scope" body; the stored token
 *                        was issued before the required scope existed.
 *                        User must disconnect + reconnect.
 *   ACCESS_DENIED      — generic 403
 *   RATE_LIMITED       — 429 from SKV API gateway
 *   TOKEN_CORRUPTED    — stored tokens cannot be decrypted (key rotated
 *                        or row tampered with); user must reconnect
 */
export class SkatteverketAuthError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'NOT_CONNECTED'
      | 'SESSION_EXPIRED'
      | 'REFRESH_EXHAUSTED'
      | 'BEHORIGHET_SAKNAS'
      | 'MISSING_SCOPE'
      | 'ACCESS_DENIED'
      | 'RATE_LIMITED'
      | 'TOKEN_CORRUPTED'
  ) {
    super(message)
    this.name = 'SkatteverketAuthError'
  }
}
