import crypto from 'crypto'
import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { createAuthCode } from '@/lib/auth/oauth-codes'
import { requireCompanyId } from '@/lib/company/context'
import { getBranding } from '@/lib/branding/service'
import { isAllowedRedirectUri } from '@/lib/auth/oauth-allowlist'
import {
  ALL_SCOPES,
  API_KEY_SCOPES,
  DEFAULT_OAUTH_SCOPES,
  SCOPE_GROUPS,
  validateScopes,
  type ApiKeyScope,
} from '@/lib/auth/api-keys'

/**
 * OAuth 2.0 Authorization Endpoint.
 *
 * GET  → show consent page (or redirect to login)
 * POST → process consent, create auth code, redirect to callback
 *
 * The API key is NOT created here — it's created in the token endpoint
 * after PKCE verification, preventing orphaned keys on abandoned flows.
 */

type ScopeParseResult =
  | { kind: 'ok'; scopes: ApiKeyScope[] | undefined }
  | { kind: 'invalid_scope'; description: string }

/**
 * Parse the OAuth `scope` query param (RFC 6749 §3.3 — space-delimited list)
 * into the subset of API_KEY_SCOPES the client is asking for. Used to drive
 * pre-checked defaults on the consent UI; the user's actual grant comes from
 * their checkbox selection.
 *
 * Returns:
 *   - { ok, scopes: undefined } when no scope param was supplied — the consent
 *     UI pre-checks DEFAULT_OAUTH_SCOPES (read-only, GDPR Art. 25(2)).
 *   - { ok, scopes: [...] } when at least one valid scope was requested.
 *   - { invalid_scope } when a scope param was supplied but every value was
 *     unknown — refusing the request is safer than silently dropping it back
 *     to defaults the caller didn't ask for (V10.2.6).
 *
 * The bare `mcp` marker is treated as "no granular scopes" and accepted for
 * backwards compatibility with Claude's connector — it falls through to
 * `undefined` so the read-only defaults apply.
 */
function parseRequestedScopes(scopeParam: string | null): ScopeParseResult {
  if (!scopeParam) return { kind: 'ok', scopes: undefined }
  const requested = scopeParam.split(/\s+/).filter(Boolean)
  if (requested.length === 0) return { kind: 'ok', scopes: undefined }
  // The coarse-grained `mcp` marker is treated as "no granular request" so
  // we can keep Claude's existing flow working unchanged.
  const onlyMcp = requested.length === 1 && requested[0] === 'mcp'
  if (onlyMcp) return { kind: 'ok', scopes: undefined }
  const valid = requested.filter((s): s is ApiKeyScope => s in API_KEY_SCOPES)
  if (valid.length === 0) {
    return {
      kind: 'invalid_scope',
      description: 'none of the requested scopes are recognised',
    }
  }
  return { kind: 'ok', scopes: valid }
}

/**
 * Sign the scope payload so a tampered POST cannot widen the grant
 * displayed at GET. The HMAC binds the originally requested scope param to
 * the consent page that the user actually saw (V10.3.1).
 *
 * Derived from SUPABASE_SERVICE_ROLE_KEY — same root secret the auth-code
 * AEAD uses, so deploying the OAuth surface doesn't require a separate
 * signing key. Missing env vars cause /authorize to fail closed.
 */
function getScopeSigningKey(): Buffer {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!secret) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for OAuth scope binding')
  return crypto.createHash('sha256').update(`oauth-scope:${secret}`).digest()
}

function signScopeBinding(scopeParam: string): string {
  return crypto.createHmac('sha256', getScopeSigningKey()).update(scopeParam).digest('base64url')
}

function verifyScopeBinding(scopeParam: string, signature: string): boolean {
  if (typeof signature !== 'string' || signature.length === 0) return false
  const expected = signScopeBinding(scopeParam)
  const expectedBuf = Buffer.from(expected, 'base64url')
  let presentedBuf: Buffer
  try {
    presentedBuf = Buffer.from(signature, 'base64url')
  } catch {
    return false
  }
  if (expectedBuf.length !== presentedBuf.length) return false
  return crypto.timingSafeEqual(expectedBuf, presentedBuf)
}

function buildLoginRedirect(request: Request): Response {
  const url = new URL(request.url)
  const next = `${url.pathname}${url.search}`
  return NextResponse.redirect(
    new URL(`/login?next=${encodeURIComponent(next)}`, url.origin)
  )
}

function errorRedirect(redirectUri: string, state: string | null, error: string, desc: string): Response {
  const url = new URL(redirectUri)
  url.searchParams.set('error', error)
  url.searchParams.set('error_description', desc)
  if (state) url.searchParams.set('state', state)
  return NextResponse.redirect(url.toString(), 303)
}

/**
 * GET /api/mcp-oauth/authorize — show consent page
 */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const redirectUri = url.searchParams.get('redirect_uri')
  // state and code_challenge are carried through to the POST handler via
  // the form action's url.search, so we don't read them here — they're only
  // validated on POST.
  const codeChallengeMethod = url.searchParams.get('code_challenge_method') || 'S256'
  const responseType = url.searchParams.get('response_type')
  const scopeParam = url.searchParams.get('scope')

  if (responseType !== 'code') {
    return NextResponse.json(
      { error: 'unsupported_response_type' },
      { status: 400 }
    )
  }

  if (!redirectUri) {
    return NextResponse.json(
      { error: 'invalid_request', error_description: 'redirect_uri is required' },
      { status: 400 }
    )
  }

  if (codeChallengeMethod !== 'S256') {
    return NextResponse.json(
      { error: 'invalid_request', error_description: 'Only S256 code_challenge_method is supported' },
      { status: 400 }
    )
  }

  // Parse the requested scopes up front so the consent display reflects the
  // exact grant. Reject early if the client sent only unknown scopes (V10.2.6).
  const parsed = parseRequestedScopes(scopeParam)
  if (parsed.kind === 'invalid_scope') {
    return NextResponse.json(
      { error: 'invalid_scope', error_description: parsed.description },
      { status: 400 }
    )
  }

  // Check if user is logged in
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return buildLoginRedirect(request)
  }

  // Validate redirect_uri against allowlist (prevents open redirect). Passing
  // the authenticated client makes the trust boundary explicit (SOC 2 CC6.1).
  if (!(await isAllowedRedirectUri(redirectUri, supabase))) {
    return NextResponse.json(
      { error: 'invalid_request', error_description: 'redirect_uri is not allowed' },
      { status: 400 }
    )
  }

  const companyId = await requireCompanyId(supabase, user.id)

  // Get company name for the consent page
  const { data: settings } = await supabase
    .from('company_settings')
    .select('company_name')
    .eq('company_id', companyId)
    .single()

  const companyName = settings?.company_name || user.email

  const appNameLower = escapeHtml(getBranding().appName.toLowerCase())

  // CSP nonce for the inline consent UI controls. A nonce-bound script-src
  // makes the inline block executable while keeping the rest of the page
  // immune to script injection — without this the consent page is
  // incompatible with a strict CSP and counts as unsafe-inline (ASVS V3.3,
  // SOC 2 CC6.1). The nonce is regenerated per response.
  const cspNonce = crypto.randomBytes(16).toString('base64')

  // Bind the requested scope to the consent display. The HMAC signature is
  // verified on POST so a tampered form submission cannot widen the grant
  // beyond what the user actually saw (V10.3.1).
  const scopeBindingValue = scopeParam ?? ''
  const scopeBindingSignature = signScopeBinding(scopeBindingValue)

  // The grant ceiling is the set of scopes the client requested, or
  // DEFAULT_OAUTH_SCOPES when the client passed no scope param. Pre-checks
  // everything in the ceiling. The POST handler enforces the same ceiling
  // server-side so a tampered form can't widen the grant past what the
  // client actually asked for (RFC 6749 §3.3, SOC 2 CC6.3).
  const grantCeiling = new Set<ApiKeyScope>(parsed.scopes ?? DEFAULT_OAUTH_SCOPES)
  const scopeCheckboxesHtml = renderScopeCheckboxes(grantCeiling, grantCeiling)

  // Render consent page
  const html = `<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="translate" content="no">
  <title>Anslut MCP-klient — ${appNameLower}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #fafafa; color: #111; display: flex; align-items: flex-start; justify-content: center; min-height: 100vh; padding: 2rem 1rem; }
    .card { background: white; border-radius: 12px; border: 1px solid #e5e5e5; padding: 2rem; max-width: 520px; width: 100%; }
    h1 { font-size: 1.25rem; font-weight: 600; margin-bottom: 0.5rem; }
    p { font-size: 0.875rem; color: #666; line-height: 1.5; margin-bottom: 1rem; }
    .account { font-size: 0.875rem; color: #111; font-weight: 500; background: #f5f5f5; padding: 0.75rem 1rem; border-radius: 8px; margin-bottom: 1.5rem; }
    .scopes-header { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #666; margin-bottom: 0.75rem; }
    .scopes-controls { display: flex; gap: 0.75rem; margin-bottom: 1rem; }
    .scopes-controls button { padding: 0.25rem 0.625rem; font-size: 0.75rem; font-weight: 500; background: white; color: #444; border: 1px solid #e5e5e5; border-radius: 6px; cursor: pointer; }
    .scopes-controls button:hover { background: #f5f5f5; }
    .scope-group { border: 1px solid #ececec; border-radius: 8px; padding: 0.75rem 1rem; margin-bottom: 0.5rem; }
    .scope-group-title { font-size: 0.8125rem; font-weight: 600; color: #111; margin-bottom: 0.5rem; }
    .scope-row { display: flex; gap: 0.625rem; padding: 0.375rem 0; align-items: flex-start; }
    .scope-row input { margin-top: 0.1875rem; cursor: pointer; }
    .scope-row label { font-size: 0.8125rem; color: #333; cursor: pointer; line-height: 1.4; }
    .scope-row .scope-name { font-weight: 500; color: #111; }
    .scope-row .scope-desc { color: #666; font-size: 0.75rem; display: block; margin-top: 0.125rem; }
    .scope-row.write .scope-name::after { content: " · skriv"; color: #b85c2c; font-weight: 500; }
    .warn { font-size: 0.75rem; color: #8b5a00; background: #fff7e6; border: 1px solid #f0d6a1; border-radius: 6px; padding: 0.625rem 0.75rem; margin: 1rem 0; line-height: 1.4; }
    .actions { display: flex; gap: 0.75rem; margin-top: 1.5rem; }
    .actions button { flex: 1; padding: 0.625rem 1rem; border-radius: 8px; font-size: 0.875rem; font-weight: 500; cursor: pointer; border: 1px solid #e5e5e5; }
    .allow { background: #111; color: white; border-color: #111; }
    .allow:hover { background: #333; }
    .deny { background: white; color: #111; }
    .deny:hover { background: #f5f5f5; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Anslut MCP-klient</h1>
    <p>En extern applikation vill ansluta till ditt ${appNameLower}-konto. Välj vilka behörigheter du vill ge.</p>
    <div class="account">${escapeHtml(companyName)}</div>

    <form method="POST" action="${url.pathname}${url.search}" id="consent-form">
      <input type="hidden" name="scope_binding" value="${escapeHtml(scopeBindingValue)}">
      <input type="hidden" name="scope_binding_sig" value="${escapeHtml(scopeBindingSignature)}">

      <div class="scopes-header">Behörigheter</div>
      <div class="scopes-controls">
        <button type="button" id="select-read">Endast läs</button>
        <button type="button" id="select-all">Markera alla</button>
        <button type="button" id="select-none">Avmarkera alla</button>
      </div>

      ${scopeCheckboxesHtml}

      <div class="warn">
        Skrivbehörigheter låter agenten stagea verifikationer, fakturor och löner. Alla skrivoperationer kräver din godkännande i ${appNameLower} innan de skrivs till databasen.
      </div>

      <div class="actions">
        <button type="submit" name="consent" value="deny" class="deny">Neka</button>
        <button type="submit" name="consent" value="allow" class="allow">Tillåt</button>
      </div>
    </form>

    <script nonce="${cspNonce}">
      (function() {
        var form = document.getElementById('consent-form');
        var boxes = form.querySelectorAll('input[name="scopes"]');
        function setAll(predicate) {
          boxes.forEach(function(b) { b.checked = predicate(b); });
        }
        document.getElementById('select-read').addEventListener('click', function() {
          setAll(function(b) { return b.dataset.kind === 'read'; });
        });
        document.getElementById('select-all').addEventListener('click', function() {
          setAll(function() { return true; });
        });
        document.getElementById('select-none').addEventListener('click', function() {
          setAll(function() { return false; });
        });
      })();
    </script>
  </div>
</body>
</html>`

  // script-src bound to the per-request nonce ensures the consent page's
  // inline JS can only be the block we actually emitted. Anything injected
  // by a forged response or persisted XSS would be blocked.
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${cspNonce}'`,
    "style-src 'unsafe-inline'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ')

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': csp,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  })
}

/**
 * POST /api/mcp-oauth/authorize — process consent, issue auth code
 */
export async function POST(request: Request) {
  const url = new URL(request.url)
  const redirectUri = url.searchParams.get('redirect_uri')
  const state = url.searchParams.get('state')
  const codeChallenge = url.searchParams.get('code_challenge') || ''
  const querystringScopeParam = url.searchParams.get('scope')

  if (!redirectUri) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 })
  }

  // Check auth
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return buildLoginRedirect(request)
  }

  // Pass the authenticated client so the lookup is bound to the same session
  // that the consent display ran under (SOC 2 CC6.1).
  if (!(await isAllowedRedirectUri(redirectUri, supabase))) {
    return NextResponse.json(
      { error: 'invalid_request', error_description: 'redirect_uri is not allowed' },
      { status: 400 }
    )
  }

  await requireCompanyId(supabase, user.id)

  // Parse form body
  const formData = await request.formData()
  const consent = formData.get('consent')

  if (consent !== 'allow') {
    return errorRedirect(redirectUri, state, 'access_denied', 'User denied the request')
  }

  // Verify the scope binding signed at consent display matches what was
  // submitted with the form. This pins the form to the GET that minted it,
  // so an attacker who tricks the user into submitting a crafted form can't
  // change the client's `scope=` querystring midway through the flow
  // (V10.3.1). The granted scopes themselves come from the user's checkbox
  // selection and are bounded server-side by API_KEY_SCOPES.
  const presentedScopeBinding = formData.get('scope_binding')
  const presentedScopeBindingSig = formData.get('scope_binding_sig')
  const presentedScopeStr = typeof presentedScopeBinding === 'string' ? presentedScopeBinding : ''
  const presentedSigStr = typeof presentedScopeBindingSig === 'string' ? presentedScopeBindingSig : ''
  const expectedScopeStr = querystringScopeParam ?? ''
  if (
    presentedScopeStr !== expectedScopeStr ||
    !verifyScopeBinding(presentedScopeStr, presentedSigStr)
  ) {
    return errorRedirect(
      redirectUri,
      state,
      'invalid_request',
      'Scope binding mismatch — consent token is invalid or has been tampered with'
    )
  }

  // Validate the client's original scope request (rejects an entirely-unknown
  // scope set — V10.2.6). The actual grant comes from the user's checkbox
  // selection below, not from this querystring.
  const parsed = parseRequestedScopes(querystringScopeParam)
  if (parsed.kind === 'invalid_scope') {
    return errorRedirect(redirectUri, state, 'invalid_scope', parsed.description)
  }

  // The user selects scopes via checkboxes on the consent page. Two upper
  // bounds apply server-side, regardless of what the form posts:
  //
  //   1. validateScopes drops any value that isn't in API_KEY_SCOPES — guards
  //      against forged values from a tampered POST.
  //   2. The grant must be a subset of what the client *originally asked for*
  //      (the `scope` querystring on the GET). Otherwise a client that
  //      requested only read scopes could end up with write grants because
  //      the user ticked extra boxes — that's a least-privilege violation
  //      (RFC 6749 §3.3, SOC 2 CC6.3, NIST AC-6) and removes the client's
  //      ability to advertise the access surface it actually intends to use.
  //
  // When the client didn't pass a scope param at all (parsed.scopes is
  // undefined), the consent UI defaults to DEFAULT_OAUTH_SCOPES — that becomes
  // the implicit ceiling for the grant.
  const submittedScopes = formData.getAll('scopes').filter((s): s is string => typeof s === 'string')
  const validated = validateScopes(submittedScopes)
  const clientCeiling: ApiKeyScope[] = parsed.scopes ?? [...DEFAULT_OAUTH_SCOPES]
  const ceilingSet = new Set<ApiKeyScope>(clientCeiling)
  const boundedToClient = (validated ?? []).filter(s => ceilingSet.has(s))
  const grantedScopes: ApiKeyScope[] = boundedToClient.length > 0
    ? boundedToClient
    : [...DEFAULT_OAUTH_SCOPES].filter(s => ceilingSet.has(s))

  // Create auth code with userId (NO API key — that's created at /token after PKCE)
  const code = createAuthCode({
    userId: user.id,
    codeChallenge,
    redirectUri,
    scopes: grantedScopes,
  })

  // Redirect to callback with the code
  const callbackUrl = new URL(redirectUri)
  callbackUrl.searchParams.set('code', code)
  if (state) callbackUrl.searchParams.set('state', state)

  // 303 See Other: forces browser to GET the callback URL, even though this
  // handler was reached via POST. NextResponse.redirect() defaults to 307,
  // which preserves POST and causes Claude's callback to return 405.
  return NextResponse.redirect(callbackUrl.toString(), 303)
}

/**
 * Render the scope checkbox UI grouped by domain. Only scopes in `ceiling`
 * (the client's `scope` querystring, or DEFAULT_OAUTH_SCOPES) are surfaced —
 * scopes outside the ceiling are dropped from the consent UI so the user
 * can't tick boxes that the POST handler would refuse anyway. Pre-checks
 * every visible row by default.
 */
function renderScopeCheckboxes(
  preChecked: Set<ApiKeyScope>,
  ceiling: Set<ApiKeyScope>,
): string {
  const renderedInGroups = new Set<ApiKeyScope>()
  const groups: string[] = []

  for (const group of SCOPE_GROUPS) {
    const rows: string[] = []
    if (group.read && ceiling.has(group.read)) {
      rows.push(scopeRow(group.read, preChecked.has(group.read), 'read'))
      renderedInGroups.add(group.read)
    }
    if (group.write && ceiling.has(group.write)) {
      rows.push(scopeRow(group.write, preChecked.has(group.write), 'write'))
      renderedInGroups.add(group.write)
    }
    if (rows.length > 0) {
      groups.push(
        `<div class="scope-group"><div class="scope-group-title">${escapeHtml(group.label)}</div>${rows.join('')}</div>`
      )
    }
  }

  const remaining = ALL_SCOPES.filter(s => ceiling.has(s) && !renderedInGroups.has(s))
  if (remaining.length > 0) {
    const rows = remaining.map((s) =>
      scopeRow(s, preChecked.has(s), s.endsWith(':write') || s.endsWith(':manage') || s.endsWith(':approve') ? 'write' : 'read')
    )
    groups.push(
      `<div class="scope-group"><div class="scope-group-title">Övriga</div>${rows.join('')}</div>`
    )
  }

  return groups.join('')
}

function scopeRow(scope: ApiKeyScope, checked: boolean, kind: 'read' | 'write'): string {
  const meta = API_KEY_SCOPES[scope]
  const id = `scope-${scope.replace(/[^a-z0-9]/gi, '-')}`
  return `
    <div class="scope-row ${kind}">
      <input type="checkbox" id="${id}" name="scopes" value="${escapeHtml(scope)}" data-kind="${kind}" ${checked ? 'checked' : ''}>
      <label for="${id}">
        <span class="scope-name">${escapeHtml(meta.label)}</span>
        <span class="scope-desc">${escapeHtml(meta.description)}</span>
      </label>
    </div>
  `
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
