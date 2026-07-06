/**
 * Safe JSON extraction for model output. Models occasionally wrap JSON in code
 * fences or prose, emit slightly-malformed JSON (a missing/trailing comma), or
 * get truncated at the token limit (unterminated arrays/objects). This strips
 * wrappers, attempts repairs, parses, and validates with a caller-supplied type
 * guard. On total failure it throws an error that INCLUDES the raw output so the
 * exact problem is visible.
 */

/**
 * Repair the two most common LLM JSON mistakes without corrupting string
 * contents: missing commas between adjacent values and trailing commas.
 * Strings are masked first so their contents are never rewritten.
 */
function repairJson(s: string): string {
  const strings: string[] = []
  const masked = s.replace(/"(?:[^"\\]|\\.)*"/g, (m) => {
    strings.push(m)
    return `@@STR${strings.length - 1}@@`
  })
  const repaired = masked
    .replace(/,(\s*[}\]])/g, '$1')
    .replace(
      /(@@STR\d+@@|[}\]]|true|false|null|-?\d(?:\.\d+)?(?:[eE][+-]?\d+)?)(\s*)(@@STR\d+@@|[{[])/g,
      '$1,$2$3'
    )
  return repaired.replace(/@@STR(\d+)@@/g, (_, i) => strings[Number(i)])
}

/**
 * Complete JSON that was cut off at the token limit: trim back to the last
 * fully-formed element and append the closing brackets the open structures
 * need. String-aware so a brace inside a value doesn't confuse the scan.
 * Returns null when the input is already balanced (not truncated).
 */
function completeTruncated(s: string): string | null {
  const depth = () => {
    const stack: string[] = []
    let inStr = false
    let esc = false
    let lastElementEnd = -1
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]
      if (inStr) {
        if (esc) esc = false
        else if (ch === '\\') esc = true
        else if (ch === '"') inStr = false
        continue
      }
      if (ch === '"') inStr = true
      else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']')
      else if (ch === '}' || ch === ']') {
        stack.pop()
        if (stack.length > 0) lastElementEnd = i // a nested element just closed
      }
    }
    return { open: stack.length, lastElementEnd }
  }

  const { open, lastElementEnd } = depth()
  if (open === 0) return null // balanced — not truncated
  if (lastElementEnd < 0) return null // nothing complete to salvage

  // Keep everything through the last complete element, drop a dangling
  // separator/partial, then close all still-open structures (LIFO).
  const head = s.slice(0, lastElementEnd + 1).replace(/[,:]\s*$/, '')
  const closers: string[] = []
  let inStr = false
  let esc = false
  for (let i = 0; i < head.length; i++) {
    const ch = head[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') closers.push('}')
    else if (ch === '[') closers.push(']')
    else if (ch === '}' || ch === ']') closers.pop()
  }
  return head + closers.reverse().join('')
}

export function extractJson<T>(raw: string, guard: (v: unknown) => v is T): T {
  const bases: string[] = []
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) bases.push(fenced[1])
  bases.push(raw)
  const first = raw.indexOf('{')
  const last = raw.lastIndexOf('}')
  if (first >= 0 && last > first) bases.push(raw.slice(first, last + 1))

  // For each base: as-is, comma-repaired, truncation-completed, and both.
  const candidates: string[] = []
  for (const b of bases) {
    candidates.push(b, repairJson(b))
    const completed = completeTruncated(b.trim())
    if (completed) candidates.push(completed, repairJson(completed))
  }

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
  const snippet = raw.length > 1200 ? raw.slice(0, 1200) + `\n…(+${raw.length - 1200} more chars)` : raw
  throw new Error(`Could not parse model output as valid JSON: ${lastErr?.message ?? 'unknown'}\n--- raw model output ---\n${snippet}`)
}

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
