/**
 * Settings + secrets store.
 *
 * Non-secret settings live in settings.json in userData. API keys and S3
 * credentials are encrypted with Electron safeStorage and stored as base64
 * blobs in secrets.json — never hardcoded, never sent to the renderer.
 */
import { app, safeStorage } from 'electron'
import fs from 'fs'
import path from 'path'
import type { AppSettings, BrandKit } from '@shared/types'

export type SecretName = 'gemini' | 'openai' | 'deepseek' | 'anthropic' | 'opusclip' | 's3-access' | 's3-secret'

const DEFAULT_BRAND: BrandKit = {
  fontDisplay: 'Segoe UI Variable Display',
  fontBody: 'Segoe UI Variable Text',
  customFonts: [],
  palette: {
    primary: '#5eead4',
    secondary: '#0f766e',
    accent: '#5eead4',
    background: '#0b0d10',
    text: '#f2f5f8'
  }
}

const DEFAULTS: AppSettings = {
  onboarded: false,
  keysPresent: { gemini: false, openai: false, deepseek: false, anthropic: false, opusclip: false },
  routing: {
    taskProviders: {
      'cut-review': 'gemini',
      'graphic-planning': 'gemini',
      'graphic-slot-filling': 'gemini',
      'revision-parsing': 'gemini'
    }
  },
  silence: { thresholdDb: -35, minSilenceSec: 0.6, keepPadMs: 150 },
  scene: { threshold: 0.4, defaultTransition: 'crossfade', defaultDurationSec: 0.5 },
  hosting: { kind: 's3', configured: false },
  export: { preferNvenc: true },
  opusclip: {},
  brandKit: DEFAULT_BRAND
}

class SettingsStore {
  private settingsPath: string
  private secretsPath: string
  private settings: AppSettings
  private secrets: Record<string, string> = {}

  constructor() {
    const dir = app.getPath('userData')
    fs.mkdirSync(dir, { recursive: true })
    this.settingsPath = path.join(dir, 'settings.json')
    this.secretsPath = path.join(dir, 'secrets.json')
    this.settings = this.load()
    this.loadSecrets()
  }

  private load(): AppSettings {
    try {
      const raw = JSON.parse(fs.readFileSync(this.settingsPath, 'utf-8'))
      return {
        ...DEFAULTS,
        ...raw,
        routing: { taskProviders: { ...DEFAULTS.routing.taskProviders, ...raw?.routing?.taskProviders } },
        brandKit: { ...DEFAULT_BRAND, ...raw?.brandKit, palette: { ...DEFAULT_BRAND.palette, ...raw?.brandKit?.palette } }
      }
    } catch {
      return structuredClone(DEFAULTS)
    }
  }

  private loadSecrets(): void {
    try {
      this.secrets = JSON.parse(fs.readFileSync(this.secretsPath, 'utf-8'))
    } catch {
      this.secrets = {}
    }
    this.refreshKeyPresence()
  }

  private refreshKeyPresence(): void {
    this.settings.keysPresent = {
      gemini: Boolean(this.secrets['gemini']),
      openai: Boolean(this.secrets['openai']),
      deepseek: Boolean(this.secrets['deepseek']),
      anthropic: Boolean(this.secrets['anthropic']),
      opusclip: Boolean(this.secrets['opusclip'])
    }
    this.settings.hosting.configured = Boolean(this.secrets['s3-access'] && this.secrets['s3-secret'] && this.settings.hosting.bucket)
  }

  getSettings(): AppSettings {
    return this.settings
  }

  update(patch: Partial<AppSettings>): AppSettings {
    this.settings = {
      ...this.settings,
      ...patch,
      // Deep-merge nested objects so a partial patch (e.g. only brandKit.logoPath
      // or one task provider) can't clobber sibling fields.
      routing: patch.routing
        ? { taskProviders: { ...this.settings.routing.taskProviders, ...patch.routing.taskProviders } }
        : this.settings.routing,
      brandKit: patch.brandKit
        ? {
            ...this.settings.brandKit,
            ...patch.brandKit,
            palette: { ...this.settings.brandKit.palette, ...patch.brandKit.palette }
          }
        : this.settings.brandKit,
      hosting: patch.hosting ? { ...this.settings.hosting, ...patch.hosting } : this.settings.hosting
    }
    this.refreshKeyPresence()
    fs.writeFileSync(this.settingsPath, JSON.stringify({ ...this.settings }, null, 2))
    return this.settings
  }

  setSecret(name: SecretName, value: string): void {
    if (!value) {
      delete this.secrets[name]
    } else if (safeStorage.isEncryptionAvailable()) {
      this.secrets[name] = safeStorage.encryptString(value).toString('base64')
    } else {
      // Encryption unavailable (rare on Windows) — refuse rather than store plaintext.
      throw new Error('Secure storage is unavailable on this machine. Keys cannot be saved safely.')
    }
    fs.writeFileSync(this.secretsPath, JSON.stringify(this.secrets, null, 2))
    this.refreshKeyPresence()
  }

  getSecret(name: SecretName): string | null {
    const blob = this.secrets[name]
    if (!blob) return null
    try {
      return safeStorage.decryptString(Buffer.from(blob, 'base64'))
    } catch {
      return null
    }
  }
}

let store: SettingsStore | null = null
export function getSettingsStore(): SettingsStore {
  if (!store) store = new SettingsStore()
  return store
}
