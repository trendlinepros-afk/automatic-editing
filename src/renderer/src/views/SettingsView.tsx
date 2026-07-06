import { useEffect, useState } from 'react'
import { useStore } from '../state/store'
import type { AITask, AIProviderId, UpdateCheckResult } from '@shared/types'

const TASKS: { id: AITask; label: string }[] = [
  { id: 'cut-review', label: 'Cut review (stage 2)' },
  { id: 'graphic-planning', label: 'Graphic planning (stage 4)' },
  { id: 'graphic-slot-filling', label: 'Graphic slot filling (stage 4)' },
  { id: 'revision-parsing', label: 'Revision parsing (review loop)' }
]
const PROVIDERS: AIProviderId[] = ['gemini', 'openai', 'deepseek']

export default function SettingsView() {
  const { settings, refreshSettings } = useStore()
  useEffect(() => {
    refreshSettings()
  }, [])
  if (!settings) return <div className="p-8 text-ink-500">Loading settings…</div>

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-8 max-w-3xl mx-auto space-y-8">
        <h1 className="font-display text-2xl font-bold text-ink-50">Settings</h1>
        <ApiKeys />
        <Routing />
        <PipelineTuning />
        <BrandKitPanel />
        <Libraries />
        <HostingPanel />
        <OpusClipPanel />
        <Updates />
      </div>
    </div>
  )
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="panel p-5">
      <h2 className="font-display font-semibold text-ink-50 mb-1">{title}</h2>
      {hint && <p className="text-xs text-ink-500 mb-4">{hint}</p>}
      <div className="space-y-3">{children}</div>
    </section>
  )
}

// ---------------------------------------------------------------------------

function ApiKeys() {
  const { settings, refreshSettings } = useStore()
  const [values, setValues] = useState<Record<string, string>>({})
  const keys = [
    { id: 'gemini' as const, label: 'Gemini (default AI provider)' },
    { id: 'openai' as const, label: 'OpenAI (Whisper transcription + optional AI)' },
    { id: 'deepseek' as const, label: 'DeepSeek (optional AI)' },
    { id: 'opusclip' as const, label: 'OpusClip (shorts — Pro Beta / Max / Business plan)' }
  ]
  return (
    <Section
      title="API keys"
      hint="Keys are encrypted with Windows credential storage (Electron safeStorage) and never leave this machine except to call the provider. Leave a key empty to run that feature in mock mode."
    >
      {keys.map((k) => (
        <div key={k.id} className="flex items-center gap-2">
          <span className="w-72 text-sm text-ink-300 shrink-0">
            {k.label}
            {settings?.keysPresent[k.id] && <span className="ml-2 text-signal text-xs">● saved</span>}
          </span>
          <input
            className="input"
            type="password"
            placeholder={settings?.keysPresent[k.id] ? '•••••••• (enter new value to replace)' : 'paste key'}
            value={values[k.id] ?? ''}
            onChange={(e) => setValues((v) => ({ ...v, [k.id]: e.target.value }))}
          />
          <button
            className="btn text-xs shrink-0"
            onClick={async () => {
              await window.wickedcut.setApiKey(k.id, values[k.id] ?? '')
              setValues((v) => ({ ...v, [k.id]: '' }))
              refreshSettings()
            }}
          >
            Save
          </button>
        </div>
      ))}
    </Section>
  )
}

function Routing() {
  const { settings, refreshSettings } = useStore()
  if (!settings) return null
  return (
    <Section title="AI routing" hint="Per-task provider. Default is Gemini. Transcription is pinned to OpenAI Whisper and is not routable.">
      {TASKS.map((t) => (
        <div key={t.id} className="flex items-center gap-2">
          <span className="w-72 text-sm text-ink-300 shrink-0">{t.label}</span>
          <select
            className="input !w-44"
            value={settings.routing.taskProviders[t.id]}
            onChange={async (e) => {
              await window.wickedcut.updateSettings({
                routing: {
                  taskProviders: { ...settings.routing.taskProviders, [t.id]: e.target.value as AIProviderId }
                }
              })
              refreshSettings()
            }}
          >
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
      ))}
    </Section>
  )
}

function PipelineTuning() {
  const { settings, refreshSettings } = useStore()
  if (!settings) return null
  const num = (v: string) => Number(v)
  return (
    <Section title="Pipeline tuning">
      <Row label="Silence threshold (dB)">
        <input
          className="input !w-28" type="number" defaultValue={settings.silence.thresholdDb}
          onBlur={async (e) => { await window.wickedcut.updateSettings({ silence: { ...settings.silence, thresholdDb: num(e.target.value) } }); refreshSettings() }}
        />
      </Row>
      <Row label="Min silence duration (s)">
        <input
          className="input !w-28" type="number" step="0.1" defaultValue={settings.silence.minSilenceSec}
          onBlur={async (e) => { await window.wickedcut.updateSettings({ silence: { ...settings.silence, minSilenceSec: num(e.target.value) } }); refreshSettings() }}
        />
      </Row>
      <Row label="Keep-pad (ms)">
        <input
          className="input !w-28" type="number" defaultValue={settings.silence.keepPadMs}
          onBlur={async (e) => { await window.wickedcut.updateSettings({ silence: { ...settings.silence, keepPadMs: num(e.target.value) } }); refreshSettings() }}
        />
      </Row>
      <Row label="Scene threshold (0–1)">
        <input
          className="input !w-28" type="number" step="0.05" defaultValue={settings.scene.threshold}
          onBlur={async (e) => { await window.wickedcut.updateSettings({ scene: { ...settings.scene, threshold: num(e.target.value) } }); refreshSettings() }}
        />
      </Row>
      <Row label="Default transition">
        <select
          className="input !w-44" value={settings.scene.defaultTransition}
          onChange={async (e) => { await window.wickedcut.updateSettings({ scene: { ...settings.scene, defaultTransition: e.target.value as any } }); refreshSettings() }}
        >
          <option value="crossfade">crossfade</option>
          <option value="dip-to-black">dip-to-black</option>
        </select>
      </Row>
      <Row label="Prefer NVENC (GPU) encoding">
        <input
          type="checkbox" checked={settings.export.preferNvenc} className="accent-[#5eead4]"
          onChange={async (e) => { await window.wickedcut.updateSettings({ export: { preferNvenc: e.target.checked } }); refreshSettings() }}
        />
      </Row>
    </Section>
  )
}

function BrandKitPanel() {
  const { settings, refreshSettings } = useStore()
  if (!settings) return null
  const bk = settings.brandKit
  const save = async (patch: Partial<typeof bk>) => {
    await window.wickedcut.updateSettings({ brandKit: { ...bk, ...patch } })
    refreshSettings()
  }
  return (
    <Section title="Brand kit" hint="Every generated graphic AND every caption pulls from here, so output stays consistent.">
      <Row label="Display font">
        <input className="input" defaultValue={bk.fontDisplay} onBlur={(e) => save({ fontDisplay: e.target.value })} />
      </Row>
      <Row label="Body / caption font">
        <input className="input" defaultValue={bk.fontBody} onBlur={(e) => save({ fontBody: e.target.value })} />
      </Row>
      <Row label="Custom fonts (.ttf/.otf)">
        <div className="flex-1">
          {bk.customFonts.map((f) => (
            <div key={f.path} className="flex items-center gap-2 text-xs text-ink-400 mb-1">
              <span className="flex-1 truncate">{f.name} — {f.path}</span>
              <button className="text-cut hover:underline" onClick={() => save({ customFonts: bk.customFonts.filter((x) => x.path !== f.path) })}>remove</button>
            </div>
          ))}
          <button
            className="btn text-xs"
            onClick={async () => {
              const font = await window.wickedcut.pickFontFile()
              if (font) save({ customFonts: [...bk.customFonts, font] })
            }}
          >
            + Load font file
          </button>
        </div>
      </Row>
      <Row label="Palette">
        <div className="flex gap-2">
          {(Object.keys(bk.palette) as (keyof typeof bk.palette)[]).map((k) => (
            <label key={k} className="flex flex-col items-center gap-1 text-[10px] text-ink-500">
              <input
                type="color"
                value={bk.palette[k]}
                className="w-9 h-9 rounded cursor-pointer bg-transparent"
                onChange={(e) => save({ palette: { ...bk.palette, [k]: e.target.value } })}
              />
              {k}
            </label>
          ))}
        </div>
      </Row>
      <Row label="Logo">
        <div className="flex items-center gap-2 flex-1">
          <span className="text-xs text-ink-500 truncate flex-1">{bk.logoPath ?? 'none'}</span>
          <button
            className="btn text-xs"
            onClick={async () => {
              const p = await window.wickedcut.pickLogoFile()
              if (p) save({ logoPath: p })
            }}
          >
            Pick logo
          </button>
        </div>
      </Row>
    </Section>
  )
}

function Libraries() {
  const { settings, refreshSettings } = useStore()
  if (!settings) return null
  const pick = async (key: 'musicLibraryDir' | 'sfxLibraryDir') => {
    const dir = await window.wickedcut.pickDirectory()
    if (dir) {
      await window.wickedcut.updateSettings({ [key]: dir })
      refreshSettings()
    }
  }
  return (
    <Section title="Music & SFX libraries" hint="Point at local folders. Stage 5 lays background music from the music library and ducks it under speech automatically.">
      <Row label="Music folder">
        <span className="text-xs text-ink-500 truncate flex-1">{settings.musicLibraryDir ?? 'not set'}</span>
        <button className="btn text-xs" onClick={() => pick('musicLibraryDir')}>Browse</button>
      </Row>
      <Row label="SFX folder">
        <span className="text-xs text-ink-500 truncate flex-1">{settings.sfxLibraryDir ?? 'not set'}</span>
        <button className="btn text-xs" onClick={() => pick('sfxLibraryDir')}>Browse</button>
      </Row>
    </Section>
  )
}

function HostingPanel() {
  const { settings, refreshSettings } = useStore()
  const [creds, setCreds] = useState({ access: '', secret: '' })
  if (!settings) return null
  const h = settings.hosting
  const save = async (patch: Partial<typeof h>) => {
    await window.wickedcut.updateSettings({ hosting: { ...h, ...patch } })
    refreshSettings()
  }
  return (
    <Section
      title="Final video hosting (required for Shorts)"
      hint="OpusClip ingests a video URL, not a local file — your approved final render is uploaded here first, then the URL is passed to OpusClip. Any S3-compatible bucket works (AWS S3, Cloudflare R2, Backblaze B2, MinIO)."
    >
      <Row label="Bucket"><input className="input" defaultValue={h.bucket ?? ''} onBlur={(e) => save({ bucket: e.target.value })} /></Row>
      <Row label="Region"><input className="input" defaultValue={h.region ?? ''} placeholder="us-east-1" onBlur={(e) => save({ region: e.target.value })} /></Row>
      <Row label="Endpoint (non-AWS)"><input className="input" defaultValue={h.endpoint ?? ''} placeholder="https://…r2.cloudflarestorage.com" onBlur={(e) => save({ endpoint: e.target.value })} /></Row>
      <Row label="Public base URL (optional)"><input className="input" defaultValue={h.publicBaseUrl ?? ''} placeholder="https://cdn.example.com — leave empty to use signed URLs" onBlur={(e) => save({ publicBaseUrl: e.target.value })} /></Row>
      <Row label="Access key">
        <input className="input" type="password" value={creds.access} onChange={(e) => setCreds((c) => ({ ...c, access: e.target.value }))} />
        <button className="btn text-xs" onClick={async () => { await window.wickedcut.setApiKey('s3-access', creds.access); setCreds((c) => ({ ...c, access: '' })); refreshSettings() }}>Save</button>
      </Row>
      <Row label="Secret key">
        <input className="input" type="password" value={creds.secret} onChange={(e) => setCreds((c) => ({ ...c, secret: e.target.value }))} />
        <button className="btn text-xs" onClick={async () => { await window.wickedcut.setApiKey('s3-secret', creds.secret); setCreds((c) => ({ ...c, secret: '' })); refreshSettings() }}>Save</button>
      </Row>
      <p className={`text-xs ${h.configured ? 'text-signal' : 'text-warn'}`}>
        {h.configured ? '✓ Hosting configured.' : 'Hosting not configured yet — Shorts generation will be blocked until it is.'}
      </p>
    </Section>
  )
}

function OpusClipPanel() {
  const { settings, refreshSettings } = useStore()
  if (!settings) return null
  return (
    <Section
      title="OpusClip"
      hint="Requires a Pro Beta, Max, or Business plan. Rate limit: 30 requests/min. Minimum ~10 credits (≈10 min of video) per project."
    >
      <Row label="Brand template ID">
        <input
          className="input" defaultValue={settings.opusclip.brandTemplateId ?? ''} placeholder="from your OpusClip dashboard"
          onBlur={async (e) => { await window.wickedcut.updateSettings({ opusclip: { ...settings.opusclip, brandTemplateId: e.target.value || undefined } }); refreshSettings() }}
        />
      </Row>
      <Row label="Webhook URL (optional)">
        <input
          className="input" defaultValue={settings.opusclip.webhookUrl ?? ''} placeholder="left empty → WickedCut polls for results"
          onBlur={async (e) => { await window.wickedcut.updateSettings({ opusclip: { ...settings.opusclip, webhookUrl: e.target.value || undefined } }); refreshSettings() }}
        />
      </Row>
    </Section>
  )
}

function Updates() {
  const [result, setResult] = useState<UpdateCheckResult | null>(null)
  const [checking, setChecking] = useState(false)
  return (
    <Section title="Updates">
      <div className="flex items-center gap-3">
        <button
          className="btn btn-primary"
          disabled={checking}
          onClick={async () => {
            setChecking(true)
            setResult(null)
            try {
              setResult(await window.wickedcut.checkForUpdates())
            } finally {
              setChecking(false)
            }
          }}
        >
          {checking ? 'Checking…' : 'Check for updates'}
        </button>
        {result?.status === 'downloaded' && (
          <button className="btn" onClick={() => window.wickedcut.installUpdate()}>
            Restart & install v{result.latestVersion}
          </button>
        )}
      </div>
      {result && (
        <p className={`text-xs ${result.status === 'error' ? 'text-cut' : 'text-ink-400'}`}>{result.message}</p>
      )}
    </Section>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-72 text-sm text-ink-300 shrink-0">{label}</span>
      {children}
    </div>
  )
}
