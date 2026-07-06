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
  saveProject(project)
  return project
}

export function saveProject(project: Project): Project {
  project.updatedAt = new Date().toISOString()
  const file = path.join(project.workDir, 'project.json')
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(project, null, 2))
  fs.renameSync(tmp, file) // atomic-ish write — crash-safe reload
  saveProjectRow(project)
  return project
}

export function openProject(id: string): Project {
  // JSON file is the source of truth; SQLite row is the fallback.
  const workDir = path.join(projectsRoot(), id)
  const file = path.join(workDir, 'project.json')
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, 'utf-8'))
  }
  const row = getProjectRow(id)
  if (row) return row
  throw new Error('Project not found. It may have been deleted from disk.')
}

export function listProjects(): ProjectSummary[] {
  return listProjectRows()
}

export function deleteProject(id: string): void {
  deleteProjectRow(id)
  const workDir = path.join(projectsRoot(), id)
  if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true })
}
