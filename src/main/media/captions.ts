/**
 * Caption generation — timed transcript → ASS subtitle file styled from the
 * brand kit (font, size, color, position). Burned in at export via the `ass`
 * filter in render.ts.
 */
import path from 'path'
import fs from 'fs'
import type { BrandKit, CaptionStyle, TimeRegion, Transcript } from '@shared/types'
import { sourceToTrimmedTime } from './silence'

export function buildAssFile(
  workDir: string,
  transcript: Transcript,
  style: CaptionStyle,
  brand: BrandKit,
  keep: TimeRegion[]
): string | null {
  if (!style.enabled) return null

  const fontName = style.fontPath
    ? path.parse(style.fontPath).name
    : style.fontFamily || brand.fontBody || 'Segoe UI'

  const alignment = style.position === 'top' ? 8 : style.position === 'center' ? 5 : 2
  const primary = hexToAss(style.primaryColor || brand.palette.text || '#FFFFFF')
  const outline = hexToAss(style.outlineColor || '#000000')

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1920',
    'PlayResY: 1080',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Italic, Alignment, MarginL, MarginR, MarginV, Outline, Shadow, BorderStyle',
    `Style: Default,${fontName},${style.fontSizePx},${primary},${outline},&H80000000,0,0,${alignment},60,60,60,2,0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Text'
  ].join('\n')

  const lines: string[] = []
  for (const seg of transcript.segments) {
    // Remap source-time captions onto the trimmed timeline; skip segments that
    // fall fully inside a cut.
    const start = sourceToTrimmedTime(seg.start, keep)
    const end = sourceToTrimmedTime(seg.end, keep)
    if (end - start < 0.15) continue
    lines.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Default,${escapeAss(seg.text.trim())}`)
  }

  const assPath = path.join(workDir, 'captions.ass')
  fs.writeFileSync(assPath, header + '\n' + lines.join('\n') + '\n', 'utf-8')
  return assPath
}

function assTime(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  const cs = Math.floor((sec % 1) * 100)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

function hexToAss(hex: string): string {
  const clean = hex.replace('#', '')
  const r = clean.slice(0, 2)
  const g = clean.slice(2, 4)
  const b = clean.slice(4, 6)
  return `&H00${b}${g}${r}`.toUpperCase()
}

function escapeAss(text: string): string {
  return text.replace(/\{/g, '(').replace(/\}/g, ')').replace(/\n/g, '\\N')
}
