/**
 * Media pool: build a tree of imported videos/folders, referenced IN PLACE.
 * Nothing is copied — items store absolute paths the pipeline reads directly.
 */
import fs from 'fs'
import path from 'path'
import { newId } from '@shared/id'
import type { MediaItem } from '@shared/types'

const VIDEO_EXT = new Set([
  '.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v',
  '.mpg', '.mpeg', '.wmv', '.flv', '.ts', '.mts', '.m2ts', '.3gp'
])

export function isVideoFile(p: string): boolean {
  return VIDEO_EXT.has(path.extname(p).toLowerCase())
}

/**
 * Build a media item from a file or folder path. Folders keep their structure;
 * non-video files and folders that contain no videos (at any depth) are pruned.
 * Returns null when nothing usable is found. A depth cap guards against symlink
 * loops / pathological trees.
 */
export function buildMediaItem(p: string, depth = 0): MediaItem | null {
  if (depth > 24) return null
  let stat: fs.Stats
  try {
    stat = fs.statSync(p)
  } catch {
    return null
  }

  if (stat.isDirectory()) {
    let entries: string[] = []
    try {
      entries = fs.readdirSync(p)
    } catch {
      return null
    }
    const children = entries
      .map((name) => buildMediaItem(path.join(p, name), depth + 1))
      .filter((x): x is MediaItem => x !== null)
      .sort((a, b) =>
        a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1
      )
    if (children.length === 0) return null // no videos anywhere under here
    return { id: newId('media'), name: path.basename(p) || p, path: path.resolve(p), kind: 'folder', children }
  }

  if (isVideoFile(p)) {
    return { id: newId('media'), name: path.basename(p), path: path.resolve(p), kind: 'video' }
  }
  return null
}

export function buildMediaItems(paths: string[]): MediaItem[] {
  return paths.map((p) => buildMediaItem(p)).filter((x): x is MediaItem => x !== null)
}

/** Remove the item with `id` from a media tree (top-level or nested). */
export function pruneMediaById(items: MediaItem[], id: string): MediaItem[] {
  return items
    .filter((it) => it.id !== id)
    .map((it) => (it.children ? { ...it, children: pruneMediaById(it.children, id) } : it))
}
