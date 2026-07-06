/**
 * OpusClip API client — post-approval shorts generation.
 *
 * Constraints honored here:
 *  - API access requires a qualifying plan (Pro Beta / Max / Business); auth
 *    failures point the user at their dashboard API key.
 *  - 30 requests/min rate limit → minimum 2s spacing between calls.
 *  - ~10-credit (≈10 min) minimum per project — warned in the UI.
 */
import { getSettingsStore } from '../settings'
import { newId } from '@shared/id'
import type { OpusClipResult, Project, ShortsProjectState } from '@shared/types'
import { getHost } from './hosting'
import { saveProject } from '../project'
import { pushProject } from '../pipeline/runner'
import type { JobContext } from '../queue'

const BASE = 'https://api.opus.pro/api'
let lastCall = 0

async function opusFetch(pathname: string, init: RequestInit = {}): Promise<any> {
  const key = getSettingsStore().getSecret('opusclip')
  if (!key) {
    throw new Error('No OpusClip API key. Add it in Settings → API Keys (requires a Pro Beta, Max, or Business plan).')
  }
  // 30 req/min rate limit — simple spacing guard.
  const wait = Math.max(0, lastCall + 2000 - Date.now())
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastCall = Date.now()

  const res = await fetch(`${BASE}${pathname}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
      ...(init.headers ?? {})
    }
  })
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      'OpusClip rejected the API key. API access needs a Pro Beta, Max, or Business plan — copy a fresh key from your OpusClip dashboard.'
    )
  }
  if (res.status === 429) {
    throw new Error('OpusClip rate limit hit (30 requests/min). Wait a minute and try again.')
  }
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300)
    throw new Error(`OpusClip request failed (${res.status}). ${detail}`)
  }
  return res.json()
}

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
    const url = await getHost().upload(project.finalPath, ctx.signal, (f) => ctx.progress(0.05 + f * 0.4, 'Uploading…'))
    state.videoUrl = url
    state.status = 'submitted'
    saveProject(project)

    // 2. Submit the clip project.
    ctx.progress(0.5, 'Submitting to OpusClip…')
    const settings = getSettingsStore().getSettings().opusclip
    const body: Record<string, unknown> = {
      videoUrl: url,
      curationPref: 'auto'
    }
    if (settings.brandTemplateId) body.brandTemplateId = settings.brandTemplateId
    if (settings.webhookUrl) body.conclusionActions = [{ type: 'WEBHOOK', url: settings.webhookUrl }]

    const created = await opusFetch('/clip-projects', { method: 'POST', body: JSON.stringify(body) })
    state.opusProjectId = created?.id ?? created?.projectId
    state.status = 'processing'
    saveProject(project)
    pushProject(project)

    // 3. Poll until done (webhook is optional; polling is the default path).
    ctx.progress(0.6, 'OpusClip processing… this can take a while')
    await pollUntilDone(project, state, ctx)
  } catch (err: any) {
    state.status = 'error'
    state.error = err?.message ?? String(err)
    saveProject(project)
    pushProject(project)
    throw err
  }
}

async function pollUntilDone(project: Project, state: ShortsProjectState, ctx: JobContext): Promise<void> {
  const deadline = Date.now() + 60 * 60 * 1000 // 1h cap
  while (Date.now() < deadline) {
    if (ctx.signal.aborted) throw new Error('Canceled')
    await new Promise((r) => setTimeout(r, 15000))
    const proj = await opusFetch(`/clip-projects/${state.opusProjectId}`)
    const status = String(proj?.status ?? proj?.state ?? '').toUpperCase()
    if (['COMPLETED', 'DONE', 'SUCCEEDED'].includes(status)) {
      state.clips = await fetchClips(state.opusProjectId!)
      state.status = 'done'
      saveProject(project)
      pushProject(project)
      return
    }
    if (['FAILED', 'ERROR'].includes(status)) {
      throw new Error(`OpusClip processing failed: ${proj?.error ?? 'no detail provided'}.`)
    }
  }
  throw new Error('OpusClip processing timed out after an hour. Use Refresh in the Shorts panel to check again.')
}

export async function refreshShorts(project: Project): Promise<void> {
  for (const state of project.shorts) {
    if (state.status !== 'processing' || !state.opusProjectId) continue
    try {
      const proj = await opusFetch(`/clip-projects/${state.opusProjectId}`)
      const status = String(proj?.status ?? proj?.state ?? '').toUpperCase()
      if (['COMPLETED', 'DONE', 'SUCCEEDED'].includes(status)) {
        state.clips = await fetchClips(state.opusProjectId)
        state.status = 'done'
      }
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
