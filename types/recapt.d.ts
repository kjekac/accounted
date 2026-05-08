type RecaptFeedbackPayload =
  | { message: string; rating?: number }
  | { widget: 'show' | 'hide' | 'open' | 'close'; position?: string }

type RecaptIdentifyPayload = {
  uid: string | undefined
  email?: string
  nickname?: string
}

interface RecaptFn {
  (action: 'feedback', data: RecaptFeedbackPayload): void
  (action: 'identify', data: RecaptIdentifyPayload): void
}

declare global {
  interface Window {
    Recapt?: unknown
    recapt?: RecaptFn
  }
}

export {}
