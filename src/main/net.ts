/**
 * Shared HTTP helpers for the main process — one place for the
 * status-code → readable-error ladder so every provider fails the same way.
 */

export interface ApiErrorHints {
  /** Where the user fixes a bad key, e.g. 'Settings → API Keys'. */
  keyHint?: string
  /** Extra context for 401/403, e.g. plan requirements. */
  authDetail?: string
}

export async function apiError(label: string, res: Response, hints: ApiErrorHints = {}): Promise<Error> {
  let detail = ''
  try {
    detail = (await res.text()).slice(0, 300)
  } catch {
    /* ignore */
  }
  if (res.status === 401 || res.status === 403) {
    return new Error(
      `${label} rejected the API key.${hints.authDetail ? ` ${hints.authDetail}` : ''} Check it in ${hints.keyHint ?? 'Settings → API Keys'}.`
    )
  }
  if (res.status === 429) {
    return new Error(`${label} rate limit hit. Wait a moment and try again.`)
  }
  return new Error(`${label} request failed (${res.status}). ${detail}`)
}

/** Abort-aware sleep — rejects immediately when the signal fires. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Canceled'))
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(new Error('Canceled'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
