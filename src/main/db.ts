/**
 * SQLite persistence (better-sqlite3) mirroring the JSON project files.
 * The JSON file in each project's folder is the source of truth for reload;
 * SQLite provides the fast project index and crash-safe write-ahead copy.
 *
 * If the native module fails to load (e.g. ABI mismatch during development),
 * the app degrades to JSON-only persistence with a console warning instead of
 * refusing to start.
 */
import { app } from 'electron'
import path from 'path'
import fs from 'fs'
import type { Project, ProjectSummary } from '@shared/types'

type Sqlite = import('better-sqlite3').Database

let db: Sqlite | null = null

export function initDb(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3')
    const dbPath = path.join(app.getPath('userData'), 'wickedcut.db')
    db = new Database(dbPath)
    db!.pragma('journal_mode = WAL')
    db!.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        source_path TEXT NOT NULL,
        duration_sec REAL NOT NULL,
        approved INTEGER NOT NULL DEFAULT 0,
        json TEXT NOT NULL
      );
    `)
  } catch (err) {
    // Native module unavailable → degrade to JSON-only persistence (guarded by
    // `if (db)` everywhere below).
    console.warn('[db] better-sqlite3 unavailable, falling back to JSON-only persistence:', err)
  }
}

function indexPath(): string {
  return path.join(app.getPath('userData'), 'projects-index.json')
}

export function saveProjectRow(p: Project): void {
  if (db) {
    db.prepare(
      `INSERT INTO projects (id, name, created_at, updated_at, source_path, duration_sec, approved, json)
       VALUES (@id, @name, @createdAt, @updatedAt, @sourcePath, @durationSec, @approved, @json)
       ON CONFLICT(id) DO UPDATE SET name=@name, updated_at=@updatedAt, approved=@approved, json=@json`
    ).run({
      id: p.id,
      name: p.name,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      sourcePath: p.source.path,
      durationSec: p.source.durationSec,
      approved: p.approved ? 1 : 0,
      json: JSON.stringify(p)
    })
    return
  }
  // JSON fallback index
  const idx = listProjectRows().filter((r) => r.id !== p.id)
  idx.push(summarize(p))
  fs.writeFileSync(indexPath(), JSON.stringify(idx, null, 2))
}

export function listProjectRows(): ProjectSummary[] {
  if (db) {
    const rows = db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as any[]
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      sourcePath: r.source_path,
      durationSec: r.duration_sec,
      approved: Boolean(r.approved)
    }))
  }
  try {
    return JSON.parse(fs.readFileSync(indexPath(), 'utf-8'))
  } catch {
    return []
  }
}

export function getProjectRow(id: string): Project | null {
  if (db) {
    const row = db.prepare('SELECT json FROM projects WHERE id = ?').get(id) as any
    if (row?.json) return JSON.parse(row.json)
  }
  return null
}

export function deleteProjectRow(id: string): void {
  if (db) {
    db.prepare('DELETE FROM projects WHERE id = ?').run(id)
    return
  }
  const idx = listProjectRows().filter((r) => r.id !== id)
  fs.writeFileSync(indexPath(), JSON.stringify(idx, null, 2))
}

function summarize(p: Project): ProjectSummary {
  return {
    id: p.id,
    name: p.name,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    sourcePath: p.source.path,
    durationSec: p.source.durationSec,
    approved: p.approved
  }
}
