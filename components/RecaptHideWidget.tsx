'use client'

import { useEffect } from 'react'

/**
 * Hides Recapt's floating feedback bubble while keeping the SDK active so
 * `window.recapt('identify', ...)` and programmatic `window.recapt('feedback',
 * { message })` calls continue to work. Mounted globally in the root layout.
 */
export function RecaptHideWidget() {
  useEffect(() => {
    let attempts = 0
    const maxAttempts = 50

    const hide = (): boolean => {
      if (typeof window.recapt !== 'function') return false
      try {
        window.recapt('feedback', { widget: 'hide' })
      } catch {
        // best-effort
      }
      return true
    }

    if (hide()) return

    const interval = setInterval(() => {
      attempts++
      if (hide() || attempts >= maxAttempts) {
        clearInterval(interval)
      }
    }, 100)

    return () => clearInterval(interval)
  }, [])

  return null
}
