import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { WIN_SET_OVERLAY_CHANNEL, type WindowOverlayTheme } from '../shared/protocol.ts'
import { registerChatIpc } from './chat/ipc.ts'
import { openDb } from './db.ts'
import { registerMemoryIpc } from './memory/ipc.ts'
import { registerRagIpc } from './rag/ipc.ts'
import { ensurePiProviderSeed } from './rag/pi-seed.ts'

// .env 只补未设置的环境变量：部署环境显式注入的变量优先；.env 已在 .gitignore
function loadDotEnv(): void {
  for (const file of [join(process.cwd(), '.env'), join(import.meta.dirname, '../../.env')]) {
    if (!existsSync(file)) continue
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
      if (!match) continue
      const key = match[1]
      const raw = match[2]
      if (!key || raw === undefined) continue
      if (process.env[key] === undefined) process.env[key] = raw.replace(/^(['"])(.*)\1$/, '$2')
    }
    return
  }
}
loadDotEnv()

let mainWin: BrowserWindow | null = null
let chatIpc: ReturnType<typeof registerChatIpc> | null = null

// titleBarOverlay 的 color 需不透明色，值与 index.css 的 --background/--foreground 实值一致；主题同步经 win:set-overlay
const WINDOW_OVERLAY_COLORS: Record<WindowOverlayTheme, { color: string; symbolColor: string }> = {
  light: { color: '#fcfcfc', symbolColor: '#0a0a0a' },
  dark: { color: '#0a0a0a', symbolColor: '#fafafa' }
}

const isWindows = process.platform === 'win32'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: isWindows ? 'hidden' : undefined,
    // height 48 与 header h-12 对齐（height 仅 Windows 支持，非 win32 不启用）
    titleBarOverlay: isWindows ? { ...WINDOW_OVERLAY_COLORS.light, height: 48 } : undefined,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.js'),
      sandbox: true
    }
  })
  mainWin = win

  win.on('closed', () => {
    mainWin = null
  })

  win.once('ready-to-show', () => win.show())

  win.webContents.on('did-finish-load', () => {
    if (mainWin === win) chatIpc?.flushToRenderer(win)
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  const db = openDb()
  // pi 只在 createAgentSession 时读 models.json，而 registerChatIpc 注册即建 Router：
  // seed 必须先于它落盘，否则 real 是唯一模式时首启会拿着空 provider 起会话
  ensurePiProviderSeed(db, join(app.getPath('userData'), 'pi-agent'))
  chatIpc = registerChatIpc(() => mainWin)
  registerRagIpc(() => mainWin)
  // 记忆整理完成且 Router 空闲时热重建会话，让新记忆当次启动就生效
  registerMemoryIpc({ getWindow: () => mainWin, rebuildRouterIfIdle: chatIpc.rebuildRouterIfIdle })
  ipcMain.handle(WIN_SET_OVERLAY_CHANNEL, (event, request: { theme?: unknown }) => {
    const theme = request?.theme
    if (theme !== 'light' && theme !== 'dark') throw new Error(`非法 overlay 主题：${String(theme)}`)
    if (!isWindows) return
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && !win.isDestroyed()) win.setTitleBarOverlay(WINDOW_OVERLAY_COLORS[theme])
  })
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
