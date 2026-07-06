/**
 * Safe JSON extraction for model output. Models occasionally wrap JSON in code
 * fences or prose, or emit slightly-malformed JSON (a missing comma between
 * array elements, a trailing comma). This strips wrappers, attempts a repair,
 * parses, and validates with a caller-supplied type guard. Throws a readable
 * error on failure so callers can surface it or retry.
 */

/**
 * Repair the two most common LLM JSON mistakes without corrupting string
 * contents: missing commas between adjacent values (`}{`, `] [`, `"a" "b"`)
 * and trailing commas. Strings are masked first so their contents are never
 * rewritten.
 */
function repairJson(s: string): string {
  const strings: string[] = []
  const masked = s.replace(/"(?:[^"\\]|\\.)*"/g, (m) => {
    strings.push(m)
    return `@@STR${strings.length - 1}@@`
  })
  const repaired = masked
    // trailing comma before a close: {"a":1,} / [1,]
    .replace(/,(\s*[}\]])/g, '$1')
    // value immediately followed by another value with no separator → add comma
    .replace(
      /(@@STR\d+@@|[}\]]|true|false|null|-?\d(?:\.\d+)?(?:[eE][+-]?\d+)?)(\s*)(@@STR\d+@@|[{[])/g,
      '$1,$2$3'
    )
  return repaired.replace(/@@STR(\d+)@@/g, (_, i) => strings[Number(i)])
}

export function extractJson<T>(raw: string, guard: (v: unknown) => v is T): T {
  const candidates: string[] = []
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) candidates.push(fenced[1])
  candidates.push(raw)
  const first = raw.indexOf('{')
  const last = raw.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(raw.slice(first, last + 1))

  // Try each candidate as-is, then a repaired version, before giving up.
  const withRepairs = candidates.flatMap((c) => [c, repairJson(c)])

  let lastErr: Error | null = null
  for (const c of withRepairs) {
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
