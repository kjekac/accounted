export function clearRecaptIdentity(): void {
  if (typeof window === 'undefined') return
  if (typeof window.recapt !== 'function') return
  try {
    window.recapt('identify', {
      uid: undefined,
      email: undefined,
      nickname: undefined,
    })
  } catch {
    // best-effort — we're already in a logout flow
  }
}
