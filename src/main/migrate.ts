/**
 * One-time recovery of user data across the WickedCut → Zirtola rebrand.
 *
 * Electron derives the userData directory from the app name, so renaming the
 * product moved it and orphaned the user's settings.json (which holds their
 * chosen projects folder), encrypted keys, and the project index — making the
 * app ask for the master folder again after an update. If the current userData
 * has no settings yet but a legacy directory does, copy those files across so
 * an update never silently loses the user's setup.
 *
 * safeStorage secrets are encrypted with the OS user's DPAPI key, so copying
 * secrets.json between folders for the same user keeps the keys decryptable.
 */
import { app } from 'electron'
import fs from 'fs'
import path from 'path'

const LEGACY_APP_NAMES = ['WickedCut', 'wickedcut']
const FILES = [
  'settings.json',
  'secrets.json',
  'wickedcut.db',
  'wickedcut.db-wal',
  'wickedcut.db-shm',
  'projects-index.json'
]

export function migrateLegacyUserData(): void {
  try {
    const current = app.getPath('userData')
    // Already set up in the current location — nothing to recover.
    if (fs.existsSync(path.join(current, 'settings.json'))) return

    const appData = app.getPath('appData')
    for (const name of LEGACY_APP_NAMES) {
      const legacy = path.join(appData, name)
      if (path.resolve(legacy) === path.resolve(current)) continue
      if (!fs.existsSync(path.join(legacy, 'settings.json'))) continue

      fs.mkdirSync(current, { recursive: true })
      for (const f of FILES) {
        const src = path.join(legacy, f)
        if (!fs.existsSync(src)) continue
        try {
          fs.copyFileSync(src, path.join(current, f))
        } catch (err) {
          console.warn(`[migrate] could not copy ${f}:`, err)
        }
      }
      console.log(`[migrate] recovered user settings from legacy folder: ${legacy}`)
      return
    }
  } catch (err) {
    console.warn('[migrate] legacy userData migration skipped:', err)
  }
}
