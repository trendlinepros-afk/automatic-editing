/**
 * Text-similarity helpers for retake detection. Deliberately dependency-free:
 * token-level Levenshtein ratio + prefix ratio over normalized transcript text.
 */

/** Lowercase, strip punctuation and common verbal fillers, collapse spaces. */
export function normalizeTokens(text: string): string[] {
  const FILLERS = new Set(['um', 'uh', 'uhm', 'like', 'so', 'okay', 'ok', 'well'])
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !FILLERS.has(t))
}

function levenshtein(a: string[], b: string[]): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = new Array(n + 1)
  let cur = new Array(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    cur[0] = i
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    ;[prev, cur] = [cur, prev]
  }
  return prev[n]
}

/** 0..1 — how similar two token sequences are (1 = identical). */
export function tokenSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1
  const max = Math.max(a.length, b.length)
  if (max === 0) return 1
  return 1 - levenshtein(a, b) / max
}

/** 0..1 — how well `a` matches the BEGINNING of `b` (false start that was
 *  re-taken and extended: "Now you guys know" vs "Now you guys know I'm a…").
 *  Slides over the first few tokens of `b` because retakes often prepend a
 *  connective ("But now you guys know…"). */
export function prefixSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length < a.length) return 0
  let best = 0
  for (let off = 0; off <= 2 && off + a.length <= b.length; off++) {
    best = Math.max(best, tokenSimilarity(a, b.slice(off, off + a.length)))
  }
  return best
}

/**
 * 0..1 — similarity of the two sequences' shared ENDING. Catches re-records
 * where only the intro phrase changed: "But now you guys know I'm a sucker for
 * scale things" vs "I mean I'm a sucker for scale things" — retakes rephrase
 * the lead-in but land on the same line. Suffix alignment is deliberately
 * strict against false positives: two sentences that merely share a mid-phrase
 * ("…drove it into the sandbox hard" vs "…drove it into the sandbox again")
 * have different endings and score low. The matched suffix must be ≥5 tokens
 * AND cover ≥70% of the shorter line.
 */
export function coreSimilarity(a: string[], b: string[]): number {
  const shorter = Math.min(a.length, b.length)
  let best = 0
  for (let L = 5; L <= shorter; L++) {
    if (L / shorter < 0.7) continue
    best = Math.max(best, tokenSimilarity(a.slice(a.length - L), b.slice(b.length - L)))
  }
  return best
}
