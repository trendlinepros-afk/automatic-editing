/**
 * Fixed HyperFrames template library. Each template is an HTML/CSS
 * composition with named content slots and brand-kit style tokens (CSS custom
 * properties). The AI chooses templates and fills slots — it NEVER writes
 * freeform HTML.
 *
 * EXTENSION POINT (future, intentionally not built): a 'freeform' template
 * whose single slot is AI-generated HTML. If added, it must be sandboxed and
 * user-previewed before render. Search for FREEFORM_EXTENSION_POINT.
 */
import type { BrandKit, GraphicTemplateId } from '@shared/types'

export interface TemplateSlot {
  name: string
  description: string
}

export interface GraphicTemplate {
  id: GraphicTemplateId
  description: string
  slots: TemplateSlot[]
  /** Build the full HTML document for HyperFrames given slot values + brand. */
  html: (slots: Record<string, string>, brand: BrandKit) => string
}

function brandCss(brand: BrandKit): string {
  const fontFaces = brand.customFonts
    .map(
      (f) => `@font-face { font-family: '${f.name}'; src: url('file://${f.path.replace(/\\/g, '/')}'); }`
    )
    .join('\n')
  return `
    ${fontFaces}
    :root {
      --brand-primary: ${brand.palette.primary};
      --brand-secondary: ${brand.palette.secondary};
      --brand-accent: ${brand.palette.accent};
      --brand-bg: ${brand.palette.background};
      --brand-text: ${brand.palette.text};
      --font-display: '${brand.fontDisplay}', 'Segoe UI', sans-serif;
      --font-body: '${brand.fontBody}', 'Segoe UI', sans-serif;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 1920px; height: 1080px; background: transparent; overflow: hidden; }
  `
}

function esc(s: string | undefined): string {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const doc = (brand: BrandKit, body: string, extraCss = '') => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>${brandCss(brand)}${extraCss}</style></head>
<body>${body}</body></html>`

export const TEMPLATE_LIBRARY: Record<GraphicTemplateId, GraphicTemplate> = {
  'lower-third': {
    id: 'lower-third',
    description: 'Name + title bar in the lower-left, for introducing a speaker',
    slots: [
      { name: 'name', description: "Person's name" },
      { name: 'title', description: 'Their role/title, one short line' }
    ],
    html: (s, b) =>
      doc(
        b,
        `<div class="lt">
          <div class="bar"></div>
          <div class="text"><div class="name">${esc(s.name)}</div><div class="title">${esc(s.title)}</div></div>
        </div>`,
        `.lt { position: absolute; left: 96px; bottom: 140px; display: flex; align-items: stretch;
               animation: slide .5s cubic-bezier(.2,.9,.3,1) both; }
         .bar { width: 10px; background: var(--brand-accent); border-radius: 5px; }
         .text { background: color-mix(in srgb, var(--brand-bg) 88%, transparent); padding: 22px 44px 22px 28px;
                 margin-left: 14px; border-radius: 8px; }
         .name { font: 700 52px var(--font-display); color: var(--brand-text); }
         .title { font: 400 30px var(--font-body); color: var(--brand-accent); margin-top: 4px; }
         @keyframes slide { from { transform: translateX(-40px); opacity: 0; } to { transform: none; opacity: 1; } }`
      )
  },
  'title-card': {
    id: 'title-card',
    description: 'Full-screen centered title with subtitle, for openings',
    slots: [
      { name: 'title', description: 'Main title, a few words' },
      { name: 'subtitle', description: 'Supporting line' }
    ],
    html: (s, b) =>
      doc(
        b,
        `<div class="tc"><h1>${esc(s.title)}</h1><p>${esc(s.subtitle)}</p></div>`,
        `.tc { width: 100%; height: 100%; display: flex; flex-direction: column; align-items: center;
               justify-content: center; gap: 24px; animation: fade .6s ease both; }
         h1 { font: 800 120px var(--font-display); color: var(--brand-text);
              text-shadow: 0 4px 32px rgba(0,0,0,.5); text-align: center; padding: 0 120px; }
         p { font: 400 44px var(--font-body); color: var(--brand-accent); }
         @keyframes fade { from { opacity: 0; transform: scale(.97); } to { opacity: 1; transform: none; } }`
      )
  },
  'stat-callout': {
    id: 'stat-callout',
    description: 'Large number/stat with a label, for emphasizing a figure',
    slots: [
      { name: 'stat', description: 'The number itself, e.g. "87%"' },
      { name: 'label', description: 'What the number means, one line' }
    ],
    html: (s, b) =>
      doc(
        b,
        `<div class="sc"><div class="stat">${esc(s.stat)}</div><div class="label">${esc(s.label)}</div></div>`,
        `.sc { position: absolute; right: 110px; top: 50%; transform: translateY(-50%); text-align: center;
               background: color-mix(in srgb, var(--brand-bg) 90%, transparent); border: 2px solid var(--brand-accent);
               border-radius: 20px; padding: 56px 72px; animation: pop .45s cubic-bezier(.2,1.4,.4,1) both; }
         .stat { font: 800 140px var(--font-display); color: var(--brand-accent); }
         .label { font: 500 36px var(--font-body); color: var(--brand-text); margin-top: 12px; max-width: 520px; }
         @keyframes pop { from { transform: translateY(-50%) scale(.8); opacity: 0; } to { transform: translateY(-50%) scale(1); opacity: 1; } }`
      )
  },
  'numbered-list': {
    id: 'numbered-list',
    description: 'Three numbered tips/points revealed as a stack',
    slots: [
      { name: 'heading', description: 'List heading' },
      { name: 'item1', description: 'First item' },
      { name: 'item2', description: 'Second item' },
      { name: 'item3', description: 'Third item' }
    ],
    html: (s, b) =>
      doc(
        b,
        `<div class="nl"><h2>${esc(s.heading)}</h2>
          ${[s.item1, s.item2, s.item3]
            .map((item, i) => `<div class="row" style="animation-delay:${0.3 + i * 0.5}s"><span class="n">${i + 1}</span><span>${esc(item)}</span></div>`)
            .join('')}
        </div>`,
        `.nl { position: absolute; left: 120px; top: 50%; transform: translateY(-50%); }
         h2 { font: 700 64px var(--font-display); color: var(--brand-text); margin-bottom: 36px; }
         .row { display: flex; align-items: center; gap: 24px; margin: 22px 0; font: 500 44px var(--font-body);
                color: var(--brand-text); animation: rise .4s ease both;
                background: color-mix(in srgb, var(--brand-bg) 85%, transparent); padding: 18px 36px 18px 18px; border-radius: 12px; }
         .n { display: inline-flex; width: 64px; height: 64px; align-items: center; justify-content: center;
              background: var(--brand-accent); color: var(--brand-bg); border-radius: 50%;
              font: 700 36px var(--font-display); }
         @keyframes rise { from { transform: translateY(16px); opacity: 0; } to { transform: none; opacity: 1; } }`
      )
  },
  'quote-card': {
    id: 'quote-card',
    description: 'Pull-quote with attribution, for a strong line worth repeating',
    slots: [
      { name: 'quote', description: 'The quote text' },
      { name: 'attribution', description: 'Who said it' }
    ],
    html: (s, b) =>
      doc(
        b,
        `<div class="qc"><div class="mark">“</div><blockquote>${esc(s.quote)}</blockquote><cite>— ${esc(s.attribution)}</cite></div>`,
        `.qc { width: 100%; height: 100%; display: flex; flex-direction: column; align-items: center;
               justify-content: center; padding: 0 220px; animation: fade .6s ease both; }
         .mark { font: 800 200px var(--font-display); color: var(--brand-accent); line-height: .5; margin-bottom: 20px; }
         blockquote { font: 600 64px var(--font-display); color: var(--brand-text); text-align: center;
                      text-shadow: 0 4px 28px rgba(0,0,0,.55); }
         cite { font: 400 36px var(--font-body); color: var(--brand-accent); margin-top: 36px; font-style: normal; }
         @keyframes fade { from { opacity: 0; } to { opacity: 1; } }`
      )
  },
  'section-card': {
    id: 'section-card',
    description: 'Brief full-screen section-change card (chapter marker)',
    slots: [
      { name: 'kicker', description: 'Small label above, e.g. "PART 2"' },
      { name: 'title', description: 'Section name' }
    ],
    html: (s, b) =>
      doc(
        b,
        `<div class="sec"><div class="kicker">${esc(s.kicker)}</div><h1>${esc(s.title)}</h1><div class="rule"></div></div>`,
        `.sec { width: 100%; height: 100%; display: flex; flex-direction: column; align-items: center;
                justify-content: center; gap: 20px; background: color-mix(in srgb, var(--brand-bg) 82%, transparent); }
         .kicker { font: 700 32px var(--font-body); letter-spacing: .35em; color: var(--brand-accent); }
         h1 { font: 800 100px var(--font-display); color: var(--brand-text); }
         .rule { width: 160px; height: 6px; background: var(--brand-accent); border-radius: 3px; margin-top: 12px;
                 animation: grow .5s ease both .2s; }
         @keyframes grow { from { width: 0; } to { width: 160px; } }`
      )
  }
}

// FREEFORM_EXTENSION_POINT: register a 'freeform' GraphicTemplate here when
// the escape hatch ships. Do not enable it in AI planning prompts by default.
