/**
 * OpusClip API client — post-approval shorts generation.
 *
 * Constraints honored here:
 *  - API access requires a qualifying plan (Pro Beta / Max / Business); auth
 *    failures point the user at their dashboard API key.
 *  - 30 requests/min rate limit → minimum 2s spacing between calls.
 *  - ~10-credit (≈10 min) minimum per project — warned in the UI.
 *
 * Queue behavior: the render-queue job covers upload + submission only.
 * Polling runs DETACHED so an hour-long OpusClip processing wait never
 * blocks renders/exports behind it (the queue is single-slot on purpose —
 * media jobs are disk/GPU heavy).
 */
import { getSettingsStore } from '../settings'
import { newId } from '@shared/id'
import { apiError, sleep } from '../net'
import type { OpusClipResult, Project, ShortsProjectState } from '@shared/types'
import { getHost } from './hosting'
import { saveProject } from '../project'
import { pushProject } from '../pipeline/runner'
import type { JobContext } from '../queue'

const BASE = 'https://api.opus.pro/api'
const OPUS_AUTH_DETAIL = 'API access needs a Pro Beta, Max, or Business plan — copy a fresh key from your OpusClip dashboard.'
let lastCall = 0

async function opusFetch(pathname: string, init: RequestInit = {}, signal?: AbortSignal): Promise<any> {
  const key = getSettingsStore().getSecret('opusclip')
  if (!key) {
    throw new Error('No OpusClip API key. Add it in Settings → API Keys (requires a Pro Beta, Max, or Business plan).')
  }
  // 30 req/min rate limit — simple spacing guard (abort-aware).
  const wait = Math.max(0, lastCall + 2000 - Date.now())
  if (wait > 0) await sleep(wait, signal)
  lastCall = Date.now()

  const res = await fetch(`${BASE}${pathname}`, {
    ...init,
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
      ...(init.headers ?? {})
    }
  })
  if (!res.ok) throw await apiError('OpusClip', res, { authDetail: OPUS_AUTH_DETAIL })
  return res.json()
}

type OpusStatus = 'done' | 'failed' | 'processing'

/** One interpretation of OpusClip's project status for poll + refresh. */
function opusStatus(proj: any): { status: OpusStatus; error?: string } {
  const s = String(proj?.status ?? proj?.state ?? '').toUpperCase()
  if (['COMPLETED', 'DONE', 'SUCCEEDED'].includes(s)) return { status: 'done' }
  if (['FAILED', 'ERROR', 'CANCELED'].includes(s)) {
    return { status: 'failed', error: String(proj?.error ?? proj?.failureReason ?? 'no detail provided') }
  }
  return { status: 'processing' }
}

/** Upload + submit inside the queue job; polling detaches (see module doc). */
export async function generateShorts(project: Project, ctx: JobContext): Promise<void> {
  if (!project.approved || !project.finalPath) {
    throw new Error('Approve the final render before generating shorts.')
  }

  const state: ShortsProjectState = {
    id: newId('shorts'),
    status: 'uploading',
    clips: [],
    createdAt: new Date().toISOString()
  }
  project.shorts.push(state)
  saveProject(project)
  pushProject(project)

  try {
    // 1. Host the final render so OpusClip can fetch it (URL-in API).
    ctx.progress(0.05, 'Uploading final render for OpusClip…')
    const url = await getHost().upload(project.finalPath, ctx.signal, (f) => ctx.progress(0.05 + f * 0.55, 'Uploading…'))
    state.videoUrl = url
    state.status = 'submitted'
    saveProject(project)

    // 2. Submit the clip project.
    ctx.progress(0.7, 'Submitting to OpusClip…')
    const settings = getSettingsStore().getSettings().opusclip
    const body: Record<string, unknown> = {
      videoUrl: url,
      curationPref: 'auto'
    }
    if (settings.brandTemplateId) body.brandTemplateId = settings.brandTemplateId
    if (settings.webhookUrl) body.conclusionActions = [{ type: 'WEBHOOK', url: settings.webhookUrl }]

    const created = await opusFetch('/clip-projects', { method: 'POST', body: JSON.stringify(body) }, ctx.signal)
    state.opusProjectId = created?.id ?? created?.projectId
    if (!state.opusProjectId) {
      throw new Error('OpusClip accepted the request but returned no project id — check the Shorts panel later or resubmit.')
    }
    state.status = 'processing'
    saveProject(project)
    pushProject(project)
    ctx.progress(1, 'Submitted — OpusClip is processing (tracked in the Shorts panel)')

    // 3. Poll detached — never holds the render queue.
    void pollDetached(project, state)
  } catch (err: any) {
    state.status = 'error'
    state.error = err?.message ?? String(err)
    saveProject(project)
    pushProject(project)
    throw err
  }
}

async function pollDetached(project: Project, state: ShortsProjectState): Promise<void> {
  const deadline = Date.now() + 60 * 60 * 1000 // 1h cap; Refresh keeps working after
  try {
    while (Date.now() < deadline && state.status === 'processing') {
      await sleep(15000)
      await checkOne(project, state)
    }
  } catch (err: any) {
    // Polling failures are non-fatal — the Refresh button re-checks.
    state.error = err?.message ?? String(err)
    saveProject(project)
    pushProject(project)
  }
}

async function checkOne(project: Project, state: ShortsProjectState): Promise<void> {
  if (!state.opusProjectId) return
  const proj = await opusFetch(`/clip-projects/${state.opusProjectId}`)
  const { status, error } = opusStatus(proj)
  if (status === 'done') {
    state.clips = await fetchClips(state.opusProjectId)
    state.status = 'done'
    state.error = undefined
  } else if (status === 'failed') {
    state.status = 'error'
    state.error = `OpusClip processing failed: ${error}.`
  } else {
    return // still processing — no state change, no save
  }
  saveProject(project)
  pushProject(project)
}

export async function refreshShorts(project: Project): Promise<void> {
  for (const state of project.shorts) {
    if (state.status !== 'processing') continue
    try {
      await checkOne(project, state)
    } catch (err: any) {
      state.error = err?.message
    }
  }
  saveProject(project)
  pushProject(project)
}

async function fetchClips(opusProjectId: string): Promise<OpusClipResult[]> {
  const list = await opusFetch(`/clip-projects/${opusProjectId}/clips`)
  const items: any[] = Array.isArray(list) ? list : (list?.clips ?? list?.data ?? [])
  return items.map((c) => ({
    id: String(c.id ?? newId('clip')),
    title: c.title ?? c.name,
    previewUrl: c.previewUrl ?? c.preview_url ?? c.url,
    downloadUrl: c.downloadUrl ?? c.download_url ?? c.exportUrl,
    durationSec: c.duration ?? c.durationSec,
    viralityScore: c.viralityScore ?? c.virality_score
  }))
}
