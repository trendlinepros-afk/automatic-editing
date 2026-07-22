/**
 * Task → provider routing. Default is Gemini for every task; the user can
 * override per task in Settings. Falls back to the Mock provider whenever the
 * routed provider has no key, so keyless runs still complete.
 */
import { BEST_TASK_PROVIDERS, TASK_FALLBACK_CHAINS, type AITask, type AIProviderId } from '@shared/types'
import { AnthropicProvider, GeminiProvider, makeDeepSeekProvider, makeOpenAIProvider, type AIProvider, type AIRequest } from './provider'
import { MockProvider } from './mock'
import { getSettingsStore } from '../settings'
import { log } from '../log'

const mock = new MockProvider()

const FACTORIES: Record<Exclude<AIProviderId, 'mock'>, (key: string, model?: string) => AIProvider> = {
  gemini: (key, model) => new GeminiProvider(key, model || undefined),
  openai: (key, model) => makeOpenAIProvider(key, model || undefined),
  deepseek: (key, model) => makeDeepSeekProvider(key, model || undefined),
  anthropic: (key, model) => new AnthropicProvider(key, model || undefined)
}

/**
 * ONE place that resolves the provider for a task:
 *  1. The routed provider, when its key exists (honoring any model override).
 *  2. Otherwise the task's fallback chain — the next-best REAL provider with a
 *     key takes over (logged), so a missing key never silently disables AI.
 *  3. Mock only when NO real provider has a key.
 */
export function providerForTask(task: AITask): AIProvider {
  const settings = getSettingsStore().getSettings()
  const store = getSettingsStore()
  const models = settings.routing.providerModels ?? {}
  const routed = settings.routing.taskProviders[task] ?? BEST_TASK_PROVIDERS[task]

  const tryBuild = (id: AIProviderId): AIProvider | null => {
    if (id === 'mock') return mock
    const key = store.getSecret(id)
    return key ? FACTORIES[id](key, models[id]) : null
  }

  const primary = tryBuild(routed)
  if (primary) return primary

  for (const id of TASK_FALLBACK_CHAINS[task]) {
    if (id === routed) continue
    const p = tryBuild(id)
    if (p) {
      log.warn('ai', `task=${task}: no ${routed} key — falling back to ${id}`)
      return p
    }
  }
  log.warn('ai', `task=${task}: no provider keys at all — using MOCK (results are canned)`)
  return mock
}

/** Run a task with one automatic retry on malformed-output errors. */
export async function runTask(task: AITask, req: AIRequest, signal?: AbortSignal): Promise<string> {
  const provider = providerForTask(task)
  const t0 = Date.now()
  log.info('ai', `task=${task} provider=${provider.id} start (system ${req.system.length} chars, user ${req.user.length} chars, maxTokens ${req.maxTokens ?? 4096})`)
  try {
    const out = await provider.complete(req, signal)
    log.info('ai', `task=${task} provider=${provider.id} ok in ${((Date.now() - t0) / 1000).toFixed(1)}s (${out.length} chars)`)
    return out
  } catch (err: any) {
    if (signal?.aborted) throw err
    log.warn('ai', `task=${task} provider=${provider.id} attempt 1 failed after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${err?.message ?? err} — retrying once`)
    // One retry — transient failures and malformed responses are common.
    const t1 = Date.now()
    try {
      const out = await provider.complete(
        { ...req, user: req.user + '\n\nIMPORTANT: Respond with STRICT valid JSON only. No prose, no code fences.' },
        signal
      )
      log.info('ai', `task=${task} provider=${provider.id} retry ok in ${((Date.now() - t1) / 1000).toFixed(1)}s (${out.length} chars)`)
      return out
    } catch (err2: any) {
      log.error('ai', `task=${task} provider=${provider.id} retry failed after ${((Date.now() - t1) / 1000).toFixed(1)}s: ${err2?.message ?? err2}`)
      throw err2
    }
  }
}
