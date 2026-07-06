/**
 * Update dialog opened from Help → Check for Updates. Runs the check on open
 * and shows either "you're up to date" or "update available" with install /
 * later actions. Install closes the app and applies the downloaded update.
 */
import { useEffect, useState } from 'react'
import type { UpdateCheckResult } from '@shared/types'

export default function UpdateModal({ onClose }: { onClose: () => void }) {
  const [result, setResult] = useState<UpdateCheckResult | null>(null)
  const [installing, setInstalling] = useState(false)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const r = await window.zirtola.checkForUpdates()
        if (alive) setResult(r)
      } catch (err: any) {
        if (alive)
          setResult({ status: 'error', currentVersion: '', message: err?.message ?? 'Update check failed. Try again.' })
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const ready = result?.status === 'downloaded'
  const available = ready || result?.status === 'update-available'

  async function install() {
    setInstalling(true)
    try {
      await window.zirtola.installUpdate()
    } catch (err: any) {
      setInstalling(false)
      setResult({
        status: 'error',
        currentVersion: result?.currentVersion ?? '',
        message: err?.message ?? 'Could not start the install. Try again.'
      })
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={() => !installing && onClose()}
      role="dialog"
      aria-modal="true"
    >
      <div className="panel bg-ink-850 w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="font-display text-lg font-bold text-ink-50 mb-2">
          {!result ? 'Checking for updates…' : available ? 'Update available' : "You're up to date"}
        </h2>

        {!result ? (
          <p className="text-sm text-ink-400">Contacting the update server…</p>
        ) : (
          <p className={`text-sm ${result.status === 'error' ? 'text-cut' : 'text-ink-300'}`}>{result.message}</p>
        )}

        {ready ? (
          <div className="flex flex-col sm:flex-row justify-end gap-2 mt-5">
            <button className="btn" onClick={onClose} disabled={installing}>
              I'll do this later
            </button>
            <button className="btn btn-primary" onClick={install} disabled={installing}>
              {installing ? 'Closing & installing…' : 'Install and restart'}
            </button>
          </div>
        ) : (
          result && (
            <div className="flex justify-end mt-5">
              <button className="btn btn-primary" onClick={onClose}>
                {available ? 'OK' : 'Close'}
              </button>
            </div>
          )
        )}

        {available && !ready && (
          <p className="text-[11px] text-ink-500 mt-3">
            The update is downloading in the background — reopen this dialog in a moment to install it.
          </p>
        )}
      </div>
    </div>
  )
}
