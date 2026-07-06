/**
 * Project store — creation, JSON persistence (source of truth), SQLite
 * mirroring, and the working-folder layout. Source files are NEVER modified;
 * everything happens inside the project work dir.
 */
import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { newId } from '@shared/id'
import { probe } from './media/ffmpeg'
import { getSettingsStore } from './settings'
import { saveProjectRow, getProjectRow, listProjectRows, deleteProjectRow } from './db'
import { STAGE_ORDER, type EDL, type Project, type ProjectSummary, type StageId, type StageState } from '@shared/types'

function projectsRoot(): string {
  const dir = path.join(app.getPath('userData'), 'projects')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

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

  // JSON file is the source of truth; the SQLite row is the recovery path
  // for a missing OR corrupt file (e.g. truncated by power loss).
  const workDir = path.join(projectsRoot(), id)
  const file = path.join(workDir, 'project.json')
  let project: Project | null = null
  if (fs.existsSync(file)) {
    try {
      project = JSON.parse(fs.readFileSync(file, 'utf-8'))
    } catch {
      console.warn(`[project] ${id}: project.json is corrupt, recovering from database mirror`)
    }
  }
  project ??= getProjectRow(id)
  if (!project) {
    throw new Error('Project not found. Its files may have been deleted from disk.')
  }
  live.set(id, project)
  return project
}

export function listProjects(): ProjectSummary[] {
  return listProjectRows()
}

/** True while the project is open in the registry and its folder exists —
 *  detached background work (e.g. OpusClip polling) checks this to stop
 *  cleanly after a delete. */
export function projectAlive(id: string): boolean {
  const p = live.get(id)
  return Boolean(p && fs.existsSync(p.workDir))
}

export function deleteProject(id: string): void {
  live.delete(id)
  deleteProjectRow(id)
  const workDir = path.join(projectsRoot(), id)
  if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true })
}
