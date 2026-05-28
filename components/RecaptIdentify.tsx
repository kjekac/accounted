'use client'

import { useEffect } from 'react'

export function RecaptIdentify({
  userId,
  email,
  displayName,
}: {
  userId: string
  email?: string
  displayName?: string
}) {
  useEffect(() => {
    let attempts = 0
    const maxAttempts = 50
    const interval = setInterval(() => {
      if (typeof window.recapt === 'function') {
        window.recapt('identify', {
          uid: userId,
          email,
          nickname: displayName,
        })
        clearInterval(interval)
        return
      }
      attempts++
      if (attempts >= maxAttempts) {
        clearInterval(interval)
      }
    }, 100)

    return () => clearInterval(interval)
  }, [userId, email, displayName])

  return null
}
