/**
 * Mock provider — returns deterministic, schema-valid JSON for each task so
 * the app runs end-to-end with no API keys. Task is inferred from markers the
 * task prompts embed in the system message.
 */
import type { AIProvider, AIRequest } from './provider'

export class MockProvider implements AIProvider {
  readonly id = 'mock'
  readonly label = 'Mock (no API key)'

  async complete(req: AIRequest): Promise<string> {
    await new Promise((r) => setTimeout(r, 300)) // feel like a network call
    if (req.system.includes('TASK:retake-detection')) {
      // No retakes flagged without a real model.
      return JSON.stringify({ removals: [] })
    }
    if (req.system.includes('TASK:cut-review')) {
      // Approve everything, flag nothing.
      return JSON.stringify({ decisions: [], notes: 'Mock review: all proposed cuts accepted.' })
    }
    if (req.system.includes('TASK:graphic-planning')) {
      return JSON.stringify({
        graphics: [
          {
            at: 2,
            durationSec: 5,
            templateId: 'title-card',
            slots: { title: 'Mock Title Card', subtitle: 'Add API keys in Settings for real planning' },
            rationale: 'Opening title (mock plan).'
          }
        ]
      })
    }
    if (req.system.includes('TASK:graphic-slot-filling')) {
      return JSON.stringify({ slots: { title: 'Mock content', subtitle: 'Filled by mock provider' } })
    }
    if (req.system.includes('TASK:revision-parsing')) {
      return JSON.stringify({
        stage: 'cut-review',
        action: { kind: 'adjust-cut', region: { start: 0, end: 1 }, mode: 'tighten' },
        explanation: 'Mock parse — add an API key in Settings for real revision parsing.'
      })
    }
    return JSON.stringify({ note: 'mock response' })
  }
}
