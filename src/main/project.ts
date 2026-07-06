/**
 * Project store — creation, JSON persistence (source of truth), SQLite
 * mirroring, and the working-folder layout. Source files are NEVER modified;
 * everything happens inside the project work dir.
 */
import fs from 'fs'
import path from 'path'
import { newId } from '@shared/id'
import { probe } from './media/ffmpeg'
import { getSettingsStore } from './settings'
import { projectsRoot } from './storage'
import { saveProjectRow, getProjectRow, listProjectRows, deleteProjectRow } from './db'
import { renderQueue } from './queue'
import { STAGE_ORDER, type EDL, type Project, type ProjectSummary, type StageId, type StageState } from '@shared/types'

/**
 * In-memory registry: ONE canonical Project object per id. Long-running
 * pipeline jobs and IPC handlers must mutate the same instance — re-reading
 * project.json per request would create diverging snapshots that clobber
 * each other on save (last-writer-wins data loss).
 */
const live = new Map<string, Project>()

function emptyEdl(): EDL {
  const brand = getSettingsStore().getSettings().brandKit
  return {
    cuts: [],
    transitions: [],
    graphics: [],
    sfx: [],
    music: [],
    captions: {
      enabled: true,
      fontFamily: brand.fontBody,
      fontSizePx: 54,
      primaryColor: brand.palette.text,
      outlineColor: '#000000',
      position: 'bottom'
    },
    version: 0
  }
}

function freshStages(): Record<StageId, StageState> {
  return Object.fromEntries(STAGE_ORDER.map((id) => [id, { id, status: 'pending' } satisfies StageState])) as Record<
    StageId,
    StageState
  >
}

export async function createProject(name: string, sourcePath: string): Promise<Project> {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source file not found: ${sourcePath}. Pick the file again.`)
  }
  const source = await probe(sourcePath)
  const id = newId('proj')
  const workDir = path.join(projectsRoot(), id)
  fs.mkdirSync(workDir, { recursive: true })

  const project: Project = {
    id,
    name: name || path.parse(sourcePath).name,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source,
    workDir,
    edl: emptyEdl(),
    stages: freshStages(),
    revisions: [],
    brandKit: structuredClone(getSettingsStore().getSettings().brandKit),
    approved: false,
    shorts: []
  }
  live.set(id, project)
  saveProject(project)
  return project
}

export function saveProject(project: Project): Project {
  project.updatedAt = new Date().toISOString()
  const file = path.join(project.workDir, 'project.json')
  const tmp = file + '.tmp'
  // Atomic-ish write with fsync so a crash/power-loss can't leave a
  // truncated project.json behind the rename.
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeFileSync(fd, JSON.stringify(project))
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
  saveProjectRow(project)
  return project
}

export function openProject(id: string): Project {
  // One canonical in-memory instance per id (see `live` above).
  const cached = live.get(id)
  if (cached) return cached

  // Prefer the workDir recorded in the DB mirror — projects created under an
  // older folder layout, or imported from another location, don't live under
  // the current projectsRoot(). Fall back to the derived path for a first read.
  const row = getProjectRow(id)
  const workDir = row?.workDir ?? path.join(projectsRoot(), id)
  const file = path.join(workDir, 'project.json')

  // JSON file is the source of truth; the SQLite row is the recovery path
  // for a missing OR corrupt file (e.g. truncated by power loss).
  let project: Project | null = null
  if (fs.existsSync(file)) {
    try {
      project = JSON.parse(fs.readFileSync(file, 'utf-8'))
    } catch {
      console.warn(`[project] ${id}: project.json is corrupt, recovering from database mirror`)
    }
  }
  project ??= row
  if (!project) {
    throw new Error('Project not found. Its files may have been deleted from disk.')
  }
  live.set(id, project)
  return project
}

/**
 * Open a project the user picked manually (its project.json) from anywhere on
 * disk. The folder may have been moved, so we trust the file's current
 * location as the work dir and re-register it in the index so it shows up in
 * the recent-projects list.
 */
export function importProjectFromFile(filePath: string): Project {
  let project: Project
  try {
    project = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch {
    throw new Error('That file could not be read as a Zirtola project (expected a project.json).')
  }
  if (!project?.id || !project?.source || !project?.edl) {
    throw new Error('That file is not a valid Zirtola project (project.json).')
  }
  project.workDir = path.dirname(path.resolve(filePath))
  live.set(project.id, project)
  // Persists the corrected workDir and re-indexes the row for the library list.
  saveProject(project)
  return project
}

export function listProjects(): ProjectSummary[] {
  return listProjectRows()
}

/** Work dirs of currently-open projects — the wcmedia:// handler allows these
 *  so a project imported from outside the master folder can still stream its
 *  preview. */
export function openProjectWorkDirs(): string[] {
  return [...live.values()].map((p) => p.workDir)
}

/** True while the project is open in the registry and its folder exists —
 *  detached background work (e.g. OpusClip polling) checks this to stop
 *  cleanly after a delete. */
export function projectAlive(id: string): boolean {
  const p = live.get(id)
  return Boolean(p && fs.existsSync(p.workDir))
}

export function deleteProject(id: string): void {
  // Resolve the real work dir BEFORE forgetting the project — imported or
  // legacy-layout projects don't live under the current projectsRoot().
  const record = live.get(id) ?? getProjectRow(id)
  live.delete(id)
  // Cancel any queued/running jobs for this project first — otherwise a live
  // FFmpeg keeps writing into the folder we're about to remove and holds the
  // single queue slot hostage.
  for (const job of renderQueue.list()) {
    if (job.projectId === id && (job.status === 'queued' || job.status === 'running')) {
      renderQueue.cancel(job.id)
    }
  }
  deleteProjectRow(id)
  const workDir = record?.workDir ?? path.join(projectsRoot(), id)
  if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true })
}
