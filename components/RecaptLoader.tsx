'use client'

import Script from 'next/script'

/**
 * Loads the Recapt SDK for authenticated dashboard users only.
 *
 * Privacy guard rails:
 * - Mounted inside the dashboard layout, so the script never loads on
 *   public pages (login, register, privacy policy, marketing). This
 *   prevents pre-consent IP/fingerprint collection on those routes.
 * - The public key is sourced from NEXT_PUBLIC_RECAPT_PUBLIC_KEY so
 *   hosted and self-hosted deployments can each supply their own key
 *   (or disable Recapt entirely by leaving it unset).
 * - data-persist / data-enable-user-comments are intentionally omitted
 *   from the default tag. Persistent cross-session tracking and
 *   unstructured free-text capture are opt-in product decisions, not
 *   defaults (GDPR Art. 25 — privacy by default).
 */
export function RecaptLoader() {
  const publicKey = process.env.NEXT_PUBLIC_RECAPT_PUBLIC_KEY
  if (!publicKey) return null

  return (
    <Script
      src="https://cdn.recapt.app/browser/glimt.js"
      strategy="afterInteractive"
      data-public-key={publicKey}
    />
  )
}
