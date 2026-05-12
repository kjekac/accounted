/**
 * v1 REST API endpoint → required scope map.
 *
 * This is the REST-route analogue of `TOOL_SCOPE_MAP` in api-keys.ts (which
 * maps MCP tool names to scopes). Both share the same `ApiKeyScope` registry.
 *
 * Key format: `<METHOD> <pattern>` where pattern uses `:param` for path
 * variables, matching Next.js dynamic-segment conventions (one for one).
 *
 * Endpoints not listed here are public (no auth) — only the discovery routes
 * (`/llms.txt`, `/.well-known/skills`, `/api/v1/health`, `/api/v1/openapi.json`)
 * fall into that bucket. Everything else under `/api/v1/` MUST be in this map
 * or the wrapper will refuse the request with INSUFFICIENT_SCOPE.
 */

import type { ApiKeyScope } from './api-keys'

/**
 * Routes that require authentication but no scope check beyond "is the key
 * valid?". The wrapper still validates the key and runs rate limiting.
 */
export const V1_PUBLIC_ENDPOINTS: ReadonlyArray<string> = [
  'GET /api/v1/health',
  'GET /api/v1/openapi.json',
  'GET /api/v1/openapi.yaml',
]

/**
 * Map of v1 endpoint pattern → required scope.
 *
 * Patterns use `:param` placeholders that match a single path segment.
 * The wrapper compiles these into regexes at startup and matches incoming
 * requests by (method, normalized-path) tuple.
 *
 * When adding a new endpoint, add it here BEFORE shipping the route file —
 * otherwise the wrapper will reject all requests to it.
 */
export const V1_ENDPOINT_SCOPES: Record<string, ApiKeyScope> = {
  // Companies
  'GET /api/v1/companies': 'companies:read',
  'GET /api/v1/companies/:companyId': 'companies:read',

  // Operations (async long-running tasks)
  'GET /api/v1/operations/:id': 'operations:read',

  // Events (webhook fallback / event log polling)
  'GET /api/v1/companies/:companyId/events': 'events:read',

  // Customers (Phase 2 PR-A — reads; Phase 2 PR-B-1 — writes)
  'GET /api/v1/companies/:companyId/customers': 'customers:read',
  'GET /api/v1/companies/:companyId/customers/:id': 'customers:read',
  'POST /api/v1/companies/:companyId/customers': 'customers:write',
  'PATCH /api/v1/companies/:companyId/customers/:id': 'customers:write',
  'DELETE /api/v1/companies/:companyId/customers/:id': 'customers:write',

  // Invoices (Phase 2 PR-A — reads; Phase 2 PR-B-2a — draft writes)
  'GET /api/v1/companies/:companyId/invoices': 'invoices:read',
  'GET /api/v1/companies/:companyId/invoices/:id': 'invoices:read',
  'POST /api/v1/companies/:companyId/invoices': 'invoices:write',
  'PATCH /api/v1/companies/:companyId/invoices/:id': 'invoices:write',
  // Phase 2 PR-B-2b — action verbs. URL uses /verb subpath (not Google-AIP-style :verb)
  // because Next.js routes don't support `:` in folder names.
  'POST /api/v1/companies/:companyId/invoices/:id/mark-sent': 'invoices:write',
  'POST /api/v1/companies/:companyId/invoices/:id/mark-paid': 'invoices:write',
  'POST /api/v1/companies/:companyId/invoices/:id/credit': 'invoices:write',

  // Webhooks (Phase 6 — placeholder so the catalogue is complete)
  'GET /api/v1/companies/:companyId/webhooks': 'webhooks:manage',
  'POST /api/v1/companies/:companyId/webhooks': 'webhooks:manage',
  'GET /api/v1/companies/:companyId/webhooks/:id': 'webhooks:manage',
  'PATCH /api/v1/companies/:companyId/webhooks/:id': 'webhooks:manage',
  'DELETE /api/v1/companies/:companyId/webhooks/:id': 'webhooks:manage',
}

interface CompiledRoute {
  method: string
  regex: RegExp
  scope: ApiKeyScope
}

let compiledCache: CompiledRoute[] | null = null

function compileAll(): CompiledRoute[] {
  if (compiledCache) return compiledCache
  compiledCache = Object.entries(V1_ENDPOINT_SCOPES).map(([pattern, scope]) => {
    const [method, path] = pattern.split(' ', 2)
    const regexStr = '^' + path.replace(/:[^/]+/g, '[^/]+') + '$'
    return { method, regex: new RegExp(regexStr), scope }
  })
  return compiledCache
}

/**
 * Resolve the required scope for a given (method, path) request.
 *
 * - Returns the scope when a registered v1 endpoint matches.
 * - Returns 'public' for paths in V1_PUBLIC_ENDPOINTS (no scope check needed,
 *   but the wrapper may still want to log the key id).
 * - Returns null when the path is unknown — the wrapper should treat this as
 *   a 404 NOT_FOUND rather than letting the request through unauthenticated.
 */
export function resolveRequiredScope(method: string, path: string): ApiKeyScope | 'public' | null {
  const key = `${method} ${path}`

  if (V1_PUBLIC_ENDPOINTS.includes(key)) return 'public'

  const compiled = compileAll()
  for (const route of compiled) {
    if (route.method === method && route.regex.test(path)) {
      return route.scope
    }
  }

  return null
}
