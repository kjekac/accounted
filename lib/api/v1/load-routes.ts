/**
 * Side-effect import that ensures every v1 route module's top-level
 * `registerEndpoint()` call has been executed before the OpenAPI generator
 * reads the registry.
 *
 * Why this exists: route files register themselves at module load time. The
 * OpenAPI endpoint runs in its own module which would otherwise not pull in
 * the other route files. Importing them here as side-effects populates the
 * shared `ENDPOINTS` map.
 *
 * When a new v1 route is added, append a `import '...'` line.
 */

// Phase 1 surface.
import '@/app/api/v1/health/route'
import '@/app/api/v1/companies/route'

// Phase 2 PR-A — invoice + customer reads.
import '@/app/api/v1/companies/[companyId]/invoices/route'
import '@/app/api/v1/companies/[companyId]/invoices/[id]/route'
import '@/app/api/v1/companies/[companyId]/customers/route'
import '@/app/api/v1/companies/[companyId]/customers/[id]/route'
// Phase 2 PR-B-2b — invoice action verbs.
import '@/app/api/v1/companies/[companyId]/invoices/[id]/mark-sent/route'
import '@/app/api/v1/companies/[companyId]/invoices/[id]/mark-paid/route'
import '@/app/api/v1/companies/[companyId]/invoices/[id]/credit/route'

export {}
