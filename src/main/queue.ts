/**
 * Render queue — every long operation (transcription, HyperFrames renders,
 * stage runs, exports, uploads, OpusClip submission) runs as a cancelable job
 * with progress pushed to the renderer.
 */
import { EventEmitter } from 'events'
import { newId } from '@shared/id'
import { log } from './log'
import type { JobKind, RenderJob } from '@shared/types'

export interface JobContext {
  signal: AbortSignal
  progress: (fraction: number, detail?: string) => void
}

interface InternalJob extends RenderJob {
  controller: AbortController
  run: (ctx: JobContext) => Promise<void>
}

class RenderQueue extends EventEmitter {
  private jobs = new Map<string, InternalJob>()
  private running = 0
  private readonly maxConcurrent = 1 // media jobs are disk/GPU heavy; serialize

  enqueue(kind: JobKind, label: string, projectId: string, run: (ctx: JobContext) => Promise<void>): RenderJob {
    const job: InternalJob = {
      id: newId('job'),
      kind,
      label,
      projectId,
      status: 'queued',
      progress: -1,
      createdAt: new Date().toISOString(),
      controller: new AbortController(),
      run
    }
    this.jobs.set(job.id, job)
    log.info('queue', `queued ${job.id} [${kind}] "${label}" project=${projectId}`)
    this.emitJob(job)
    this.pump()
    return this.publicJob(job)
  }

  cancel(jobId: string): void {
    const job = this.jobs.get(jobId)
    if (!job) return
    log.warn('queue', `cancel requested for ${jobId} ("${job.label}", ${job.status})`)
    if (job.status === 'queued') {
      job.status = 'canceled'
      this.emitJob(job)
    } else if (job.status === 'running') {
      job.controller.abort()
    }
  }

  list(): RenderJob[] {
    return [...this.jobs.values()].map((j) => this.publicJob(j)).reverse()
  }

  private async pump(): Promise<void> {
    if (this.running >= this.maxConcurrent) return
    const next = [...this.jobs.values()].find((j) => j.status === 'queued')
    if (!next) return
    this.running++
    next.status = 'running'
    next.progress = 0
    const startedAt = Date.now()
    log.info('queue', `running ${next.id} "${next.label}"`)
    this.emitJob(next)
    try {
      let lastEmit = 0
      await next.run({
        signal: next.controller.signal,
        progress: (f, detail) => {
          next.progress = f
          if (detail) next.detail = detail
          // Throttle progress fan-out (each emit clones + IPCs to every
          // window); status changes elsewhere always emit unthrottled.
          const now = Date.now()
          if (now - lastEmit >= 150 || f >= 1) {
            lastEmit = now
            this.emitJob(next)
          }
        }
      })
      next.status = next.controller.signal.aborted ? 'canceled' : 'done'
      next.progress = 1
      log.info('queue', `${next.status} ${next.id} "${next.label}" in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
    } catch (err: any) {
      if (next.controller.signal.aborted) {
        next.status = 'canceled'
        log.warn('queue', `canceled ${next.id} "${next.label}" after ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
      } else {
        next.status = 'error'
        next.error = err?.message ?? String(err)
        log.error('queue', `error ${next.id} "${next.label}" after ${((Date.now() - startedAt) / 1000).toFixed(1)}s: ${next.error}`)
      }
    } finally {
      this.running--
      this.emitJob(next)
      // Keep the last 50 finished jobs for the queue panel.
      const finished = [...this.jobs.values()].filter((j) => j.status !== 'queued' && j.status !== 'running')
      for (const old of finished.slice(0, Math.max(0, finished.length - 50))) this.jobs.delete(old.id)
      this.pump()
    }
  }

  private emitJob(job: InternalJob): void {
    this.emit('job', this.publicJob(job))
  }

  private publicJob(j: InternalJob): RenderJob {
    const { controller, run, ...pub } = j
    return { ...pub }
  }
}

export const renderQueue = new RenderQueue()
// enqueueAndWait attaches a short-lived per-call listener; a few can stack up
// during chained stage runs. Lift the default-10 cap to avoid a false warning.
renderQueue.setMaxListeners(50)

/** Enqueue and resolve when the job finishes (done), reject on error/cancel. */
export function enqueueAndWait(
  kind: JobKind,
  label: string,
  projectId: string,
  run: (ctx: JobContext) => Promise<void>
): Promise<void> {
  return new Promise((resolve, reject) => {
    const job = renderQueue.enqueue(kind, label, projectId, run)
    const listener = (j: RenderJob) => {
      if (j.id !== job.id) return
      if (j.status === 'done') {
        renderQueue.off('job', listener)
        resolve()
      } else if (j.status === 'error' || j.status === 'canceled') {
        renderQueue.off('job', listener)
        reject(new Error(j.error ?? 'Canceled'))
      }
    }
    renderQueue.on('job', listener)
  })
}
