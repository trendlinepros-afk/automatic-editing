/** Tiny dependency-free id generator (sortable-ish, collision-safe enough). */
let counter = 0
export function newId(prefix: string): string {
  counter = (counter + 1) % 46656
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36).padStart(3, '0')}${Math.floor(
    Math.random() * 46656
  )
    .toString(36)
    .padStart(3, '0')}`
}
