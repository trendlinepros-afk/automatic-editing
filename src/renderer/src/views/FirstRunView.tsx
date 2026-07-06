/**
 * First-run setup — shown once, before anything else, until the user chooses
 * a master folder where all projects and intermediate renders will live.
 */
import { useState } from 'react'
import { useStore } from '../state/store'

export default function FirstRunView() {
  const completeOnboarding = useStore((s) => s.completeOnboarding)
  const [dir, setDir] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function choose() {
    setError(null)
    const picked = await window.zirtola.pickDirectory()
    if (picked) setDir(picked)
  }

  async function finish(useDefault: boolean) {
    setBusy(true)
    setError(null)
    try {
      await completeOnboarding(useDefault ? null : dir)
    } catch (err: any) {
      setError(err?.message ?? 'Could not set that folder. Pick a different one.')
      setBusy(false)
    }
  }

  return (
    <div className="h-screen flex items-center justify-center bg-ink-950 p-8">
      <div className="panel max-w-xl w-full p-8">
        <h1 className="font-display text-3xl font-bold text-ink-50 mb-1">
          Welcome to Zir<span className="text-signal">tola</span>
        </h1>
        <p className="text-sm text-ink-400 mb-6">
          First, choose a <b className="text-ink-200">master folder</b>. Every project you create — and all its
          intermediate renders and exports — will live inside it. Your original source videos are never moved or
          modified.
        </p>

        <div className="panel bg-ink-850 p-4 mb-4">
          <div className="label">Projects folder</div>
          <div className="flex items-center gap-2">
            <span className="input flex-1 truncate text-ink-300">
              {dir ?? 'No folder chosen — a default location will be used'}
            </span>
            <button className="btn shrink-0" onClick={choose} disabled={busy}>
              Choose folder…
            </button>
          </div>
          <p className="text-[11px] text-ink-500 mt-2">
            Pick a drive with plenty of free space — video renders are large. You can change this later in Settings.
          </p>
        </div>

        {error && <p className="text-xs text-cut mb-3">{error}</p>}

        <div className="flex items-center justify-between">
          <button className="text-xs text-ink-500 hover:text-ink-300" onClick={() => finish(true)} disabled={busy}>
            Use default location instead
          </button>
          <button className="btn btn-primary" onClick={() => finish(false)} disabled={busy || !dir}>
            {busy ? 'Setting up…' : 'Continue'}
          </button>
        </div>
      </div>
    </div>
  )
}
