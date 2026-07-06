/**
 * Safe JSON extraction for model output. Models occasionally wrap JSON in
 * code fences or prose; this strips that, parses, and validates with a
 * caller-supplied type guard. Throws a readable error on failure so callers
 * can surface it or retry.
 */

export function extractJson<T>(raw: string, guard: (v: unknown) => v is T): T {
  const candidates: string[] = []
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) candidates.push(fenced[1])
  candidates.push(raw)
  const first = raw.indexOf('{')
  const last = raw.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(raw.slice(first, last + 1))

  let lastErr: Error | null = null
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c.trim())
      if (guard(parsed)) return parsed
      lastErr = new Error('JSON parsed but failed shape validation.')
    } catch (e) {
      lastErr = e as Error
    }
  }
  throw new Error(`Could not parse model output as valid JSON: ${lastErr?.message ?? 'unknown'}`)
}

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
