import type { McpResource } from './types'

export const companyCurrentResource: McpResource = {
  uri: 'gnubok://company/current',
  name: 'Active Company',
  description: 'The currently active company: identity, entity type, fiscal year config, lock date, base currency, and VAT registration. Read this first to understand the bookkeeping context.',
  mimeType: 'application/json',
  read: async ({ supabase, companyId }) => {
    const { data: company, error: companyError } = await supabase
      .from('companies')
      .select('id, name, org_number, entity_type, archived_at, created_at')
      .eq('id', companyId)
      .single()

    if (companyError || !company) {
      throw new Error(`Company not found: ${companyError?.message ?? 'unknown'}`)
    }

    const { data: settings } = await supabase
      .from('company_settings')
      .select(`
        company_name, address_line1, address_line2, postal_code, city, country,
        phone, email, website,
        pays_salaries, f_skatt, vat_registered, vat_number, moms_period,
        fiscal_year_start_month,
        accounting_method, default_voucher_series,
        bookkeeping_locked_through, auto_lock_period_days,
        invoice_prefix, next_invoice_number, invoice_default_days,
        is_sandbox
      `)
      .eq('company_id', companyId)
      .maybeSingle()

    return {
      company,
      settings: settings ?? null,
      base_currency: 'SEK',
    }
  },
}
