/**
 * Render queue — every long operation (transcription, HyperFrames renders,
 * stage runs, exports, uploads, OpusClip submission) runs as a cancelable job
 * with progress pushed to the renderer.
 */
import { EventEmitter } from 'events'
import { newId } from '@shared/id'
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
    this.emitJob(job)
    this.pump()
    return this.publicJob(job)
  }

  cancel(jobId: string): void {
    const job = this.jobs.get(jobId)
    if (!job) return
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
    } catch (err: any) {
      if (next.controller.signal.aborted) {
        next.status = 'canceled'
      } else {
        next.status = 'error'
        next.error = err?.message ?? String(err)
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
