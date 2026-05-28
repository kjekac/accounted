export interface SubmitFeedbackInput {
  message: string
  subject?: string
}

export type SupportChannel = 'recapt' | 'email'

export interface SubmitFeedbackResult {
  ok: boolean
  channels: SupportChannel[]
  error?: string
}

function composeMessage({ message, subject }: SubmitFeedbackInput): string {
  if (!subject) return message
  return `[${subject}]\n\n${message}`
}

async function submitViaEmail(
  { message, subject }: SubmitFeedbackInput
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch('/api/support/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject, message }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      return { ok: false, error: data.error || 'Kunde inte skicka meddelandet' }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Nätverksfel' }
  }
}

function submitViaRecapt(
  input: SubmitFeedbackInput
): { ok: true } | { ok: false; error: string } | null {
  const recapt = typeof window !== 'undefined' ? window.recapt : undefined
  if (typeof recapt !== 'function') return null
  try {
    recapt('feedback', { message: composeMessage(input) })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Recapt-fel' }
  }
}

export async function submitFeedback(input: SubmitFeedbackInput): Promise<SubmitFeedbackResult> {
  const recaptResult = submitViaRecapt(input)
  const emailResult = await submitViaEmail(input)

  const channels: SupportChannel[] = []
  if (recaptResult?.ok) channels.push('recapt')
  if (emailResult.ok) channels.push('email')

  if (channels.length > 0) {
    return { ok: true, channels }
  }

  return {
    ok: false,
    channels: [],
    error: emailResult.ok ? undefined : emailResult.error,
  }
}
