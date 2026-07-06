/**
 * Application menu. File actions are dispatched to the renderer as menu
 * commands (it owns navigation + dialogs); the Open Recent submenu is rebuilt
 * from the project list whenever buildAppMenu() is called.
 */
import { BrowserWindow, Menu } from 'electron'
import { IPC } from '@shared/ipc'
import { listProjects } from './project'

function send(channel: string, payload?: unknown): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  win?.webContents.send(channel, payload)
}

function command(command: string, projectId?: string): void {
  send(IPC.menuCommand, { command, projectId })
}

export function buildAppMenu(): void {
  const recent = listProjects().slice(0, 10)
  const recentSubmenu: Electron.MenuItemConstructorOptions[] = recent.length
    ? recent.map((p) => ({ label: p.name, click: () => command('open-project-id', p.id) }))
    : [{ label: 'No recent projects', enabled: false }]

  const menu = Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        { label: 'New Project…', accelerator: 'CmdOrCtrl+N', click: () => command('new-project') },
        { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: () => command('open-project') },
        { label: 'Open Recent', submenu: recentSubmenu },
        { type: 'separator' },
        { label: 'Import Media…', accelerator: 'CmdOrCtrl+I', click: () => command('import') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => command('save') },
        { label: 'Save As a Copy…', accelerator: 'CmdOrCtrl+Shift+S', click: () => command('save-as') },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
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
        { label: 'Check for Updates…', click: () => send(IPC.menuCheckUpdates) },
        { type: 'separator' },
        { label: 'Help Documentation', click: () => openHelpWindow() }
      ]
    }
  ])
  Menu.setApplicationMenu(menu)
}

let helpWindow: BrowserWindow | null = null

/** Placeholder help/guide window (data URL — no bundled asset needed). */
export function openHelpWindow(): void {
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
  <p>A full walkthrough of the editing pipeline — importing media, ordering clips, cutting dead space,
     reviewing AI cuts, transitions, graphics, sound &amp; music, and export — will live here.</p>
  <p>Documentation is being written. This page is a placeholder so the menu item works.</p>
  <span class="soon">Guide coming soon</span>
</div></body></html>`
