/**
 * Task → provider routing. Default is Gemini for every task; the user can
 * override per task in Settings. Falls back to the Mock provider whenever the
 * routed provider has no key, so keyless runs still complete.
 */
import type { AITask, AIProviderId } from '@shared/types'
import { GeminiProvider, makeDeepSeekProvider, makeOpenAIProvider, type AIProvider, type AIRequest } from './provider'
import { MockProvider } from './mock'
import { getSettingsStore } from '../settings'

const mock = new MockProvider()

const FACTORIES: Record<Exclude<AIProviderId, 'mock'>, (key: string) => AIProvider> = {
  gemini: (key) => new GeminiProvider(key),
  openai: makeOpenAIProvider,
  deepseek: makeDeepSeekProvider
}

/** ONE place that decides real-vs-mock: no key for the routed provider →
 *  mock, and the substitution is logged so silent-mock surprises are
 *  diagnosable ("why did cut review accept everything?"). */
function buildProvider(id: AIProviderId): AIProvider {
  if (id === 'mock') return mock
  const key = getSettingsStore().getSecret(id)
  if (!key) {
    console.warn(`[ai] no ${id} key configured — falling back to mock provider`)
    return mock
  }
  return FACTORIES[id](key)
}

export function providerForTask(task: AITask): AIProvider {
  const routing = getSettingsStore().getSettings().routing
  return buildProvider(routing.taskProviders[task] ?? 'gemini')
}

/** Run a task with one automatic retry on malformed-output errors. */
export async function runTask(task: AITask, req: AIRequest, signal?: AbortSignal): Promise<string> {
  const provider = providerForTask(task)
  try {
    return await provider.complete(req, signal)
  } catch (err) {
    if (signal?.aborted) throw err
    // One retry — transient failures and malformed responses are common.
    return await provider.complete(
      { ...req, user: req.user + '\n\nIMPORTANT: Respond with STRICT valid JSON only. No prose, no code fences.' },
      signal
    )
  }
}
