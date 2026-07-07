import { useEffect, useState } from 'react'
import { useStore } from '../state/store'
import type { AITask, AIProviderId, UpdateCheckResult } from '@shared/types'

const TASKS: { id: AITask; label: string }[] = [
  { id: 'retake-detection', label: 'Retake removal (stage 1)' },
  { id: 'cut-review', label: 'Cut review (stage 2)' },
  { id: 'graphic-planning', label: 'Graphic planning (stage 4)' },
  { id: 'graphic-slot-filling', label: 'Graphic slot filling (stage 4)' },
  { id: 'revision-parsing', label: 'Revision parsing (review loop)' }
]
const PROVIDERS: AIProviderId[] = ['gemini', 'openai', 'deepseek', 'anthropic']

export default function SettingsView() {
  const { settings, refreshSettings, project, setView, viewBeforeSettings } = useStore()
  useEffect(() => {
    refreshSettings()
  }, [])
  if (!settings) return <div className="p-8 text-ink-500">Loading settings…</div>

  // Back returns to the view the user came from (editor, shorts, or library),
  // falling back to the library if that view needs a project and none is open.
  const needsProject = viewBeforeSettings === 'editor' || viewBeforeSettings === 'shorts'
  const backTarget = needsProject && !project ? 'library' : viewBeforeSettings
  const backLabel = backTarget === 'editor' ? 'editor' : backTarget === 'shorts' ? 'shorts' : 'projects'

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-8 max-w-3xl mx-auto space-y-8">
        <div className="flex items-center justify-between">
          <h1 className="font-display text-2xl font-bold text-ink-50">Settings</h1>
          <button className="btn" onClick={() => setView(backTarget)}>
            ← Back to {backLabel}
          </button>
        </div>
        <ProjectStorage />
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

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-72 text-sm text-ink-300 shrink-0">{label}</span>
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------

function ProjectStorage() {
  const { settings, completeOnboarding } = useStore()
  const [error, setError] = useState<string | null>(null)
  if (!settings) return null
  return (
    <Section
      title="Project storage"
      hint="The master folder where all projects and their renders live. Changing it affects new projects; existing projects stay where they were created."
    >
      <Row label="Projects folder">
        <span className="text-xs text-ink-500 truncate flex-1">
          {settings.projectsDir ?? 'Default location (app data folder)'}
        </span>
        <button
          className="btn text-xs"
          onClick={async () => {
            setError(null)
            const dir = await window.zirtola.pickDirectory()
            if (!dir) return
            try {
              await completeOnboarding(dir)
            } catch (err: any) {
              setError(err?.message ?? "Couldn't use that folder — pick a different one.")
            }
          }}
        >
          Change…
        </button>
      </Row>
      {error && <p className="text-xs text-cut">{error}</p>}
    </Section>
  )
}

function ApiKeys() {
  const { settings, refreshSettings } = useStore()
  const [values, setValues] = useState<Record<string, string>>({})
  const keys = [
    { id: 'gemini' as const, label: 'Gemini (default AI provider)' },
    { id: 'openai' as const, label: 'OpenAI (Whisper transcription + optional AI)' },
    { id: 'deepseek' as const, label: 'DeepSeek (optional AI)' },
    { id: 'anthropic' as const, label: 'Anthropic (Claude — optional AI)' },
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
            disabled={!(values[k.id] ?? '').trim()}
            onClick={async () => {
              const val = (values[k.id] ?? '').trim()
              if (!val) return // empty Save must not silently delete a saved key
              await window.zirtola.setApiKey(k.id, val)
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
  const { settings, saveSettings } = useStore()
  if (!settings) return null
  return (
    <Section title="AI routing" hint="Per-task provider. Default is Gemini. Transcription is pinned to OpenAI Whisper and is not routable. A task whose provider has no key runs in mock mode.">
      {TASKS.map((t) => (
        <Row key={t.id} label={t.label}>
          <select
            className="input !w-44"
            value={settings.routing.taskProviders[t.id]}
            onChange={(e) =>
              saveSettings({
                routing: {
                  taskProviders: { ...settings.routing.taskProviders, [t.id]: e.target.value as AIProviderId }
                }
              })
            }
          >
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p}
                {!settings.keysPresent[p as 'gemini' | 'openai' | 'deepseek' | 'anthropic'] ? ' (no key → mock)' : ''}
              </option>
            ))}
          </select>
        </Row>
      ))}
    </Section>
  )
}

function PipelineTuning() {
  const { settings, saveSettings } = useStore()
  if (!settings) return null
  const num = (v: string, fallback: number) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : fallback
  }
  return (
    <Section title="Pipeline tuning">
      <Row label="Silence threshold (dB)">
        <input
          className="input !w-28" type="number" defaultValue={settings.silence.thresholdDb}
          onBlur={(e) => saveSettings({ silence: { ...settings.silence, thresholdDb: num(e.target.value, -35) } })}
        />
      </Row>
      <Row label="Min silence duration (s)">
        <input
          className="input !w-28" type="number" step="0.1" defaultValue={settings.silence.minSilenceSec}
          onBlur={(e) => saveSettings({ silence: { ...settings.silence, minSilenceSec: num(e.target.value, 0.6) } })}
        />
      </Row>
      <Row label="Keep-pad (ms)">
        <input
          className="input !w-28" type="number" defaultValue={settings.silence.keepPadMs}
          onBlur={(e) => saveSettings({ silence: { ...settings.silence, keepPadMs: num(e.target.value, 150) } })}
        />
      </Row>
      <Row label="Scene threshold (0–1)">
        <input
          className="input !w-28" type="number" step="0.05" defaultValue={settings.scene.threshold}
          onBlur={(e) => saveSettings({ scene: { ...settings.scene, threshold: num(e.target.value, 0.4) } })}
        />
      </Row>
      <Row label="Default transition">
        <select
          className="input !w-44" value={settings.scene.defaultTransition}
          onChange={(e) => saveSettings({ scene: { ...settings.scene, defaultTransition: e.target.value as any } })}
        >
          <option value="crossfade">crossfade</option>
          <option value="dip-to-black">dip-to-black</option>
        </select>
      </Row>
      <Row label="Prefer NVENC (GPU) encoding">
        <input
          type="checkbox" checked={settings.export.preferNvenc} className="accent-[#5eead4]"
          onChange={(e) => saveSettings({ export: { preferNvenc: e.target.checked } })}
        />
      </Row>
    </Section>
  )
}

function BrandKitPanel() {
  const { settings, saveSettings } = useStore()
  if (!settings) return null
  const bk = settings.brandKit
  const save = (patch: Partial<typeof bk>) => saveSettings({ brandKit: { ...bk, ...patch } })
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
              const font = await window.zirtola.pickFontFile()
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
                // Uncontrolled + persist on blur: onChange fires on every drag
                // tick of the OS picker, which would hammer disk with a save
                // per tick. The native input shows the live color itself.
                defaultValue={bk.palette[k]}
                key={bk.palette[k]}
                className="w-9 h-9 rounded cursor-pointer bg-transparent"
                onBlur={(e) => save({ palette: { ...bk.palette, [k]: e.target.value } })}
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
              const p = await window.zirtola.pickLogoFile()
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
  const { settings, saveSettings } = useStore()
  if (!settings) return null
  const pick = async (key: 'musicLibraryDir' | 'sfxLibraryDir') => {
    const dir = await window.zirtola.pickDirectory()
    if (dir) saveSettings({ [key]: dir })
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
  const { settings, saveSettings, refreshSettings } = useStore()
  const [creds, setCreds] = useState({ access: '', secret: '' })
  if (!settings) return null
  const h = settings.hosting
  const save = (patch: Partial<typeof h>) => saveSettings({ hosting: { ...h, ...patch } })
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
        <button className="btn text-xs" onClick={async () => { await window.zirtola.setApiKey('s3-access', creds.access); setCreds((c) => ({ ...c, access: '' })); refreshSettings() }}>Save</button>
      </Row>
      <Row label="Secret key">
        <input className="input" type="password" value={creds.secret} onChange={(e) => setCreds((c) => ({ ...c, secret: e.target.value }))} />
        <button className="btn text-xs" onClick={async () => { await window.zirtola.setApiKey('s3-secret', creds.secret); setCreds((c) => ({ ...c, secret: '' })); refreshSettings() }}>Save</button>
      </Row>
      <p className={`text-xs ${h.configured ? 'text-signal' : 'text-warn'}`}>
        {h.configured ? '✓ Hosting configured.' : 'Hosting not configured yet — Shorts generation will be blocked until it is.'}
      </p>
    </Section>
  )
}

function OpusClipPanel() {
  const { settings, saveSettings } = useStore()
  if (!settings) return null
  return (
    <Section
      title="OpusClip"
      hint="Requires a Pro Beta, Max, or Business plan. Rate limit: 30 requests/min. Minimum ~10 credits (≈10 min of video) per project."
    >
      <Row label="Brand template ID">
        <input
          className="input" defaultValue={settings.opusclip.brandTemplateId ?? ''} placeholder="from your OpusClip dashboard"
          onBlur={(e) => saveSettings({ opusclip: { ...settings.opusclip, brandTemplateId: e.target.value || undefined } })}
        />
      </Row>
      <Row label="Webhook URL (optional)">
        <input
          className="input" defaultValue={settings.opusclip.webhookUrl ?? ''} placeholder="left empty → Zirtola polls for results"
          onBlur={(e) => saveSettings({ opusclip: { ...settings.opusclip, webhookUrl: e.target.value || undefined } })}
        />
      </Row>
    </Section>
  )
}

function Updates() {
  const [result, setResult] = useState<UpdateCheckResult | null>(null)
  const [checking, setChecking] = useState(false)
  const [installing, setInstalling] = useState(false)
  const downloaded = result?.status === 'downloaded'

  return (
    <Section title="Updates">
      <div className="flex items-center gap-3">
        <button
          className="btn btn-primary"
          disabled={checking || installing}
          onClick={async () => {
            setChecking(true)
            setResult(null)
            try {
              setResult(await window.zirtola.checkForUpdates())
            } catch (err: any) {
              setResult({
                status: 'error',
                currentVersion: '',
                message: err?.message ?? 'Update check failed unexpectedly. Try again.'
              })
            } finally {
              setChecking(false)
            }
          }}
        >
          {checking ? 'Checking…' : 'Check for updates'}
        </button>
      </div>

      {downloaded && (
        <div className="panel bg-ink-850 p-4 space-y-3">
          <p className="text-sm text-ink-200">
            Version <b className="text-signal">{result.latestVersion}</b> is downloaded and ready to install.
            Your projects are saved automatically, so it's safe to install any time.
          </p>
          <div className="flex flex-col sm:flex-row gap-2">
            <button
              className="btn btn-primary"
              disabled={installing}
              onClick={async () => {
                setInstalling(true)
                // Projects autosave on every edit, so progress is already on
                // disk; this closes the app and installs the update. If it
                // rejects (e.g. nothing staged), reset so the button isn't stuck.
                try {
                  await window.zirtola.installUpdate()
                } catch (err: any) {
                  setInstalling(false)
                  setResult({
                    status: 'error',
                    currentVersion: result?.currentVersion ?? '',
                    message: err?.message ?? 'Could not start the install. Try "Check for updates" again.'
                  })
                }
              }}
            >
              {installing ? 'Closing & installing…' : 'Save, close app & install update now'}
            </button>
            <button
              className="btn"
              disabled={installing}
              onClick={() => setResult(null)}
              title="The update will install automatically the next time you quit Zirtola."
            >
              I'll close & relaunch it myself later
            </button>
          </div>
          <p className="text-[11px] text-ink-500">
            If you choose to relaunch yourself, the update installs automatically the next time you fully quit the app.
          </p>
        </div>
      )}

      {result && !downloaded && (
        <p className={`text-xs ${result.status === 'error' ? 'text-cut' : 'text-ink-400'}`}>{result.message}</p>
      )}
    </Section>
  )
}
