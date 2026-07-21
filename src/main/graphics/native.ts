/**
 * Native graphic rendering — builds each template as an alpha .mov using
 * ffmpeg drawtext/drawbox only. This is the DEFAULT renderer when the
 * HyperFrames CLI isn't installed: instead of a grey "placeholder" slate, the
 * user gets a clean, branded lower-third / title / stat card with a smooth
 * fade in/out. Slot text goes through textfile= (no filter-escaping pitfalls).
 */
import fs from 'fs'
import path from 'path'
import { runFFmpeg } from '../media/ffmpeg'
import type { BrandKit, GraphicEvent } from '@shared/types'

const W = 1920
const H = 1080
const FADE = 0.35

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** '#5eead4' → '0x5eead4' (drawtext/drawbox color syntax); fallback on junk. */
function hex(color: string | undefined, fallback: string): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(color ?? '')
  return `0x${(m ? m[1] : fallback).toLowerCase()}`
}

/** Simple greedy word-wrap — drawtext has no auto-wrap. */
function wrap(text: string, maxChars: number, maxLines = 4): string {
  const words = text.trim().split(/\s+/)
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    if (cur && (cur + ' ' + w).length > maxChars) {
      lines.push(cur)
      cur = w
      if (lines.length === maxLines) break
    } else {
      cur = cur ? cur + ' ' + w : w
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur)
  else if (cur) lines[maxLines - 1] += '…'
  return lines.join('\n')
}

/** Escape a path for use inside a filter option value. */
function fpath(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:')
}

let fontCache: { regular: string | null; bold: string | null } | null = null

/** Resolve usable font files: brand fonts first, then system fonts. */
function resolveFonts(brand: BrandKit): { regular: string | null; bold: string | null } {
  const custom = brand.customFonts.map((f) => f.path).filter((p) => fs.existsSync(p))
  if (custom.length > 0) {
    const bold = custom.find((p) => /bold|black|heavy/i.test(path.basename(p))) ?? custom[0]
    const regular = custom.find((p) => !/bold|black|heavy/i.test(path.basename(p))) ?? custom[0]
    return { regular, bold }
  }
  if (fontCache) return fontCache
  const winFonts = 'C:\\Windows\\Fonts'
  const pick = (names: string[]): string | null => {
    for (const n of names) {
      const p = path.join(winFonts, n)
      if (fs.existsSync(p)) return p
    }
    return null
  }
  let bold = pick(['segoeuib.ttf', 'seguisb.ttf', 'arialbd.ttf'])
  let regular = pick(['segoeui.ttf', 'arial.ttf'])
  if (!regular) {
    // Non-Windows dev environments.
    for (const p of [
      '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
      '/System/Library/Fonts/Supplemental/Arial.ttf'
    ]) {
      if (fs.existsSync(p)) {
        regular = p
        break
      }
    }
  }
  if (!bold) {
    for (const p of [
      '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
      '/System/Library/Fonts/Supplemental/Arial Bold.ttf'
    ]) {
      if (fs.existsSync(p)) {
        bold = p
        break
      }
    }
  }
  fontCache = { regular, bold: bold ?? regular }
  return fontCache
}

interface TextSpec {
  text: string
  font: string
  size: number
  color: string
  /** drawtext x/y expressions (may reference text_w/text_h). */
  x: string
  y: string
  lineSpacing?: number
  shadow?: boolean
  box?: { color: string; alpha: number; borderw: number }
}

function drawText(dir: string, id: string, n: number, s: TextSpec): string {
  const file = path.join(dir, `${id}-t${n}.txt`)
  fs.writeFileSync(file, s.text, 'utf-8')
  const parts = [
    `fontfile='${fpath(s.font)}'`,
    `textfile='${fpath(file)}'`,
    // No %{...} expansion — slot text is literal ("87%" must render as-is).
    'expansion=none',
    `fontsize=${s.size}`,
    `fontcolor=${s.color}`,
    `x=${s.x}`,
    `y=${s.y}`
  ]
  if (s.lineSpacing) parts.push(`line_spacing=${s.lineSpacing}`)
  if (s.shadow) parts.push('shadowcolor=black@0.55:shadowx=0:shadowy=4')
  if (s.box) parts.push(`box=1:boxcolor=${s.box.color}@${s.box.alpha}:boxborderw=${s.box.borderw}`)
  return `drawtext=${parts.join(':')}`
}

function drawBox(x: number, y: number, w: number, h: number, color: string, alpha: number, thickness: number | 'fill'): string {
  // replace=1 writes color AND alpha — without it, boxes drawn on the fully
  // transparent canvas blend into alpha=0 and are invisible when overlaid.
  return `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${color}@${alpha}:t=${thickness}:replace=1`
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export async function renderGraphicNative(
  workDir: string,
  graphic: GraphicEvent,
  brand: BrandKit,
  signal?: AbortSignal
): Promise<string | null> {
  const resolved = resolveFonts(brand)
  if (!resolved.regular || !resolved.bold) return null // no usable font → caller falls back
  const fonts = { regular: resolved.regular, bold: resolved.bold }

  const gfxDir = path.join(workDir, 'graphics')
  fs.mkdirSync(gfxDir, { recursive: true })
  const outPath = path.join(gfxDir, `${graphic.id}.native.mov`)

  const ACCENT = hex(brand.palette.accent, '5eead4')
  const TEXT = hex(brand.palette.text, 'f2f5f8')
  const BG = hex(brand.palette.background, '0b0d10')
  const s = graphic.slots
  const dur = graphic.durationSec
  const id = graphic.id
  const t = (n: number, spec: TextSpec) => drawText(gfxDir, id, n, spec)

  let layers: string[]
  switch (graphic.templateId) {
    case 'lower-third':
      layers = [
        drawBox(96, 762, 12, 158, ACCENT, 1, 'fill'),
        t(0, {
          text: s.name || ' ', font: fonts.bold, size: 56, color: TEXT,
          x: '140', y: '780', box: { color: BG, alpha: 0.85, borderw: 18 }
        }),
        t(1, {
          text: s.title || ' ', font: fonts.regular, size: 32, color: ACCENT,
          x: '140', y: '870', box: { color: BG, alpha: 0.85, borderw: 14 }
        })
      ]
      break
    case 'title-card':
      layers = [
        t(0, {
          text: wrap(s.title || ' ', 28, 2), font: fonts.bold, size: 110, color: TEXT,
          x: '(w-text_w)/2', y: '380', lineSpacing: 14, shadow: true
        }),
        t(1, {
          text: wrap(s.subtitle || ' ', 52, 2), font: fonts.regular, size: 46, color: ACCENT,
          x: '(w-text_w)/2', y: '640', shadow: true
        })
      ]
      break
    case 'stat-callout':
      layers = [
        drawBox(1360, 350, 460, 380, BG, 0.9, 'fill'),
        drawBox(1360, 350, 460, 380, ACCENT, 1, 4),
        t(0, {
          text: s.stat || ' ', font: fonts.bold, size: 130, color: ACCENT,
          x: '1590-text_w/2', y: '410'
        }),
        t(1, {
          text: wrap(s.label || ' ', 24, 3), font: fonts.regular, size: 34, color: TEXT,
          x: '1590-text_w/2', y: '590', lineSpacing: 8
        })
      ]
      break
    case 'numbered-list': {
      layers = [
        t(0, {
          text: s.heading || ' ', font: fonts.bold, size: 64, color: TEXT,
          x: '120', y: '200', shadow: true
        })
      ]
      const items = [s.item1, s.item2, s.item3].filter((x): x is string => Boolean(x && x.trim()))
      items.forEach((item, i) => {
        const y = 340 + i * 116
        layers.push(
          t(1 + i * 2, {
            text: `${i + 1}.  ${item}`, font: fonts.regular, size: 44, color: TEXT,
            x: '140', y: String(y), box: { color: BG, alpha: 0.85, borderw: 18 }
          }),
          // Accent overdraw of the number (same font/size/pos → clean cover).
          t(2 + i * 2, {
            text: `${i + 1}.`, font: fonts.regular, size: 44, color: ACCENT,
            x: '140', y: String(y)
          })
        )
      })
      break
    }
    case 'quote-card':
      layers = [
        t(0, {
          text: wrap(`“${(s.quote || ' ').trim()}”`, 36, 3), font: fonts.bold, size: 68, color: TEXT,
          x: '(w-text_w)/2', y: '380', lineSpacing: 16, shadow: true
        }),
        t(1, {
          text: `— ${s.attribution || ''}`, font: fonts.regular, size: 40, color: ACCENT,
          x: '(w-text_w)/2', y: '720', shadow: true
        })
      ]
      break
    case 'section-card':
      layers = [
        drawBox(0, 0, W, H, BG, 0.82, 'fill'),
        t(0, {
          text: (s.kicker || '').toUpperCase() || ' ', font: fonts.regular, size: 36, color: ACCENT,
          x: '(w-text_w)/2', y: '400'
        }),
        t(1, {
          text: wrap(s.title || ' ', 30, 2), font: fonts.bold, size: 104, color: TEXT,
          x: '(w-text_w)/2', y: '470', lineSpacing: 12
        }),
        drawBox(880, 640, 160, 6, ACCENT, 1, 'fill')
      ]
      break
    default:
      return null
  }

  const vf = [
    ...layers,
    // One uniform fade for the whole card — clean, professional, simple.
    `fade=t=in:st=0:d=${FADE}:alpha=1`,
    `fade=t=out:st=${Math.max(0, dur - FADE).toFixed(3)}:d=${FADE}:alpha=1`
  ].join(',')

  await runFFmpeg(
    [
      '-f', 'lavfi',
      '-i', `color=c=black@0.0:s=${W}x${H}:d=${dur}:r=30,format=yuva420p`,
      '-vf', vf,
      '-c:v', 'qtrle',
      outPath
    ],
    { signal }
  )
  return outPath
}
