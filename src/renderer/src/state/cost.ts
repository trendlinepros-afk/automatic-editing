/**
 * Rough per-stage USD cost estimate for one pipeline run. Costs come from two
 * sources: Whisper transcription (metered by audio length) and the routed AI
 * tasks (token-based). Everything else (silence math, ffmpeg renders,
 * HyperFrames) runs locally and is free. These are ESTIMATES — actual spend
 * varies with content, provider, and how much the model returns.
 */
import { TASK_FALLBACK_CHAINS, type AIProviderId, type AITask, type AppSettings, type Project, type StageId } from '@shared/types'

// Approximate $ per 1M tokens for each provider's default model.
const RATES: Record<AIProviderId, { in: number; out: number }> = {
  gemini: { in: 0.3, out: 2.5 }, // gemini-3.6-flash
  openai: { in: 1.25, out: 10.0 }, // gpt-5.6 flagship (approx.)
  deepseek: { in: 0.28, out: 1.1 }, // deepseek-chat
  anthropic: { in: 5.0, out: 25.0 }, // claude-opus-4-8
  mock: { in: 0, out: 0 }
}

const WHISPER_USD_PER_MIN = 0.006
const OUTPUT_TOKENS_EST = 1500 // per AI task, rough
const PROMPT_OVERHEAD_TOKENS = 800

function transcriptTokens(project: Project): number {
  if (project.transcript) {
    const chars = project.transcript.segments.reduce((a, s) => a + s.text.length, 0)
    return Math.ceil(chars / 4)
  }
  // No transcript yet — estimate from duration (~180 wpm, ~1.3 tokens/word).
  return Math.ceil(((project.source?.durationSec ?? 0) / 60) * 180 * 1.3)
}

function providerFor(settings: AppSettings, task: AITask): AIProviderId {
  // Mirrors the main-process router: routed provider if keyed, else the
  // task's fallback chain, else mock (free).
  const routed = settings.routing.taskProviders[task] ?? 'gemini'
  if (routed === 'mock') return 'mock'
  if (settings.keysPresent[routed]) return routed
  for (const id of TASK_FALLBACK_CHAINS[task]) {
    if (settings.keysPresent[id]) return id
  }
  return 'mock'
}

function aiTaskCost(project: Project, settings: AppSettings, task: AITask): number {
  const rate = RATES[providerFor(settings, task)]
  const inTok = transcriptTokens(project) + PROMPT_OVERHEAD_TOKENS
  return (inTok * rate.in + OUTPUT_TOKENS_EST * rate.out) / 1_000_000
}

function transcriptionCost(project: Project, settings: AppSettings): number {
  // Already transcribed (cached) or no OpenAI key (mock transcript) → free.
  if (project.transcript || !settings.keysPresent.openai) return 0
  const minutes = Math.ceil((project.source?.durationSec ?? 0) / 60)
  return minutes * WHISPER_USD_PER_MIN
}

export interface StageCost {
  usd: number
  /** True for ffmpeg/local-only stages that never call a paid API. */
  local: boolean
}

export function estimatePipelineCost(
  project: Project,
  settings: AppSettings
): { perStage: Record<StageId, StageCost>; total: number } {
  const perStage: Record<StageId, StageCost> = {
    'cut-detect': { usd: transcriptionCost(project, settings) + aiTaskCost(project, settings, 'retake-detection'), local: false },
    'cut-review': { usd: aiTaskCost(project, settings, 'cut-review'), local: false },
    transitions: { usd: 0, local: true },
    graphics: { usd: aiTaskCost(project, settings, 'graphic-planning'), local: false },
    audio: { usd: 0, local: true },
    preview: { usd: 0, local: true }
  }
  const total = Object.values(perStage).reduce((a, s) => a + s.usd, 0)
  return { perStage, total }
}

/** Compact USD formatting that keeps sub-cent precision. */
export function formatUsd(v: number): string {
  if (v <= 0) return '$0.00'
  if (v < 0.01) return `$${v.toFixed(4)}`
  return `$${v.toFixed(v < 1 ? 3 : 2)}`
}
