/**
 * Shorts — post-approval OpusClip stage. Upload final render → submit clip
 * project → poll → list generated shorts with preview + download links.
 */
import { useStore, formatTime } from '../state/store'

export default function ShortsPanel() {
  const { project, settings, applyProjectPush } = useStore()
  if (!project) return null

  const hostingReady = settings?.hosting.configured
  const keyReady = settings?.keysPresent.opusclip
  const canGenerate = project.approved && project.finalPath

  return (
    <div className="p-8 max-w-3xl mx-auto overflow-y-auto h-full space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold text-ink-50">Generate Shorts</h1>
        <p className="text-sm text-ink-400 mt-1">
          OpusClip turns your approved final render into short-form clips. Minimum ~10 credits (≈10 minutes of video)
          per project.
        </p>
      </div>

      {!project.approved && (
        <div className="panel p-4 text-sm text-warn">Approve the final edit in the Editor before generating shorts.</div>
      )}
      {project.approved && !project.finalPath && (
        <div className="panel p-4 text-sm text-warn">Export a final render first (Editor → Export).</div>
      )}
      {!hostingReady && (
        <div className="panel p-4 text-sm text-warn">
          OpusClip needs your video reachable by URL. Configure an S3-compatible bucket in Settings → Hosting first.
        </div>
      )}
      {!keyReady && (
        <div className="panel p-4 text-sm text-warn">
          No OpusClip API key saved. Add it in Settings → API keys (requires Pro Beta / Max / Business plan).
        </div>
      )}

      <button
        className="btn btn-primary"
        disabled={!canGenerate || !hostingReady || !keyReady}
        onClick={() => window.zirtola.generateShorts(project.id)}
      >
        Upload final render & generate shorts
      </button>

      {project.shorts.map((s) => (
        <div key={s.id} className="panel p-4">
          <div className="flex items-center gap-3 mb-2">
            <span className="text-sm font-medium text-ink-200">Batch {new Date(s.createdAt).toLocaleString()}</span>
            <span className={`text-xs uppercase tracking-wide ${s.status === 'error' ? 'text-cut' : s.status === 'done' ? 'text-signal' : 'text-warn'}`}>
              {s.status}
            </span>
            <div className="flex-1" />
            {s.status === 'processing' && (
              <button
                className="btn text-xs"
                onClick={async () => applyProjectPush(await window.zirtola.refreshShorts(project.id))}
              >
                Refresh
              </button>
            )}
          </div>
          {s.error && <p className="text-xs text-cut mb-2">{s.error}</p>}
          {s.clips.length > 0 && (
            <div className="grid gap-2">
              {s.clips.map((c) => (
                <div key={c.id} className="flex items-center gap-3 bg-ink-850 rounded-md p-2.5 text-sm">
                  <span className="flex-1 text-ink-200 truncate">{c.title ?? c.id}</span>
                  {c.durationSec !== undefined && <span className="text-xs font-mono text-ink-500">{formatTime(c.durationSec)}</span>}
                  {c.viralityScore !== undefined && <span className="text-xs text-signal">virality {c.viralityScore}</span>}
                  {c.previewUrl && (
                    <a className="text-xs text-signal hover:underline" href={c.previewUrl} target="_blank" rel="noreferrer">
                      preview
                    </a>
                  )}
                  {c.downloadUrl && (
                    <a className="text-xs text-signal hover:underline" href={c.downloadUrl} target="_blank" rel="noreferrer">
                      download
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
