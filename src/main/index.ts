/**
 * Zirtola — Electron main process entry.
 */
import { app, BrowserWindow, Menu, protocol, net, shell } from 'electron'
import path from 'path'
import url from 'url'
import { IPC } from '@shared/ipc'
import { registerIpc } from './ipc'
import { initDb } from './db'
import { getSettingsStore } from './settings'
import { openProjectWorkDirs } from './project'
import { migrateLegacyUserData } from './migrate'

// Pin the userData directory name so it can NEVER move again if the product's
// display name changes (as it did in the WickedCut → Zirtola rebrand). All
// settings, keys, and the project index live under %APPDATA%\Zirtola and must
// stay there across every future update.
app.setName('Zirtola')

// Register a privileged scheme so the renderer can play files from project
// work dirs (preview.mp4 etc.) without disabling webSecurity.
protocol.registerSchemesAsPrivileged([
  { scheme: 'wcmedia', privileges: { stream: true, supportFetchAPI: true, bypassCSP: true } }
])

/** Canonical roots the wcmedia:// scheme is allowed to read from — the app's
 *  user-data dir and the configured projects folder. Anything else is denied
 *  so the scheme can never be used to read arbitrary files off disk. */
function mediaRoots(): string[] {
  const roots = [path.resolve(app.getPath('userData'))]
  const dir = getSettingsStore().getSettings().projectsDir
  if (dir) roots.push(path.resolve(dir))
  // Projects opened from outside the master folder (via "Open Project…") stream
  // their preview from their own work dir.
  for (const wd of openProjectWorkDirs()) roots.push(path.resolve(wd))
  return roots
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1180,
    minHeight: 720,
    backgroundColor: '#0b0d10',
    title: 'Zirtola - AI Video Editor',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith('https://')) shell.openExternal(target)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
  return win
}

function buildMenu(): void {
  const menu = Menu.buildFromTemplate([
    { label: 'File', submenu: [{ role: 'quit' }] },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' }
      ]
    },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Check for Updates…',
          // The renderer runs the check and shows the up-to-date / install
          // dialog (the menu can't host the install buttons itself).
          click: () => {
            for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.menuCheckUpdates)
          }
        },
        { type: 'separator' },
        { label: 'Help Documentation', click: () => openHelpWindow() }
      ]
    }
  ])
  Menu.setApplicationMenu(menu)
}

let helpWindow: BrowserWindow | null = null

/** Placeholder help/guide window. Content is a stub for now — the walkthrough
 *  gets written later; this just makes the menu item work. Loaded as a data URL
 *  so it needs no bundling or on-disk asset path. */
function openHelpWindow(): void {
  if (helpWindow && !helpWindow.isDestroyed()) {
    helpWindow.focus()
    return
  }
  helpWindow = new BrowserWindow({
    width: 900,
    height: 720,
    title: 'Zirtola — Help & Guide',
    backgroundColor: '#0b0d10',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  })
  helpWindow.setMenuBarVisibility(false)
  helpWindow.on('closed', () => {
    helpWindow = null
  })
  helpWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HELP_HTML))
}

const HELP_HTML = `<!doctype html><html><head><meta charset="utf-8">
<title>Zirtola — Help & Guide</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: "Segoe UI", system-ui, sans-serif; background:#0b0d10; color:#ccd4de;
         display:flex; align-items:center; justify-content:center; min-height:100vh; padding:40px; }
  .card { max-width:640px; text-align:center; }
  h1 { font-size:28px; color:#f2f5f8; margin:0 0 6px; }
  .brand { color:#5eead4; }
  p { color:#8b96a5; line-height:1.6; margin:0 0 14px; }
  .soon { display:inline-block; margin-top:18px; padding:8px 14px; border:1px solid #262d36; border-radius:8px;
          color:#8b96a5; font-size:13px; }
</style></head>
<body><div class="card">
  <h1>Zir<span class="brand">tola</span> — Help &amp; Guide</h1>
  <p>A full walkthrough of the editing pipeline — cutting dead space, reviewing AI cuts,
     transitions, graphics, sound &amp; music, and export — will live here.</p>
  <p>Documentation is being written. This page is a placeholder so the menu item works.</p>
  <span class="soon">Guide coming soon</span>
</div></body></html>`

// Single-instance lock: a second launch would write the same SQLite DB and
// project files concurrently and corrupt them. Focus the existing window.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    // wcmedia://<absolute-path> → stream a local file to the <video> element,
    // confined to the app's own media roots (never arbitrary disk paths).
    protocol.handle('wcmedia', (request) => {
      try {
        const decoded = decodeURIComponent(request.url.slice('wcmedia://'.length))
        const resolved = path.resolve(decoded)
        const allowed = mediaRoots().some((r) => resolved === r || resolved.startsWith(r + path.sep))
        if (!allowed) return new Response('Forbidden', { status: 403 })
        return net.fetch(url.pathToFileURL(resolved).toString())
      } catch {
        return new Response('Bad request', { status: 400 })
      }
    })

    // Recover settings orphaned by the rebrand (no-op once set up here).
    migrateLegacyUserData()
    initDb()
    getSettingsStore()
    registerIpc()
    createWindow()
    buildMenu()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  app.quit()
})
