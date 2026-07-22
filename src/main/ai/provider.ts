/**
 * AI routing layer.
 *
 * One AIProvider interface, four cloud implementations (Gemini default,
 * OpenAI, DeepSeek, Anthropic) plus a Mock provider used whenever a key is
 * absent so the whole app runs end-to-end without credentials.
 *
 * Transcription is NOT routed here — it is pinned to OpenAI Whisper
 * (see transcription/whisper.ts).
 */
import Anthropic from '@anthropic-ai/sdk'
import { apiError } from '../net'

export interface AIRequest {
  system: string
  user: string
  /** Ask the model for strict JSON conforming to this description. */
  jsonSchemaHint?: string
  temperature?: number
  maxTokens?: number
}

export interface AIProvider {
  readonly id: string
  readonly label: string
  complete(req: AIRequest, signal?: AbortSignal): Promise<string>
}

// ---------------------------------------------------------------------------

export class GeminiProvider implements AIProvider {
  readonly id = 'gemini'
  readonly label = 'Gemini'
  constructor(
    private apiKey: string,
    // Current GA fast-tier model on generateContent — stronger than 2.5-flash
    // at a lower price. Overridable per-provider in Settings → Routing.
    private model = 'gemini-3.6-flash'
  ) {}

  async complete(req: AIRequest, signal?: AbortSignal): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`
    const res = await fetch(url, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: 'user', parts: [{ text: req.user }] }],
        generationConfig: {
          temperature: req.temperature ?? 0.2,
          maxOutputTokens: req.maxTokens ?? 4096,
          ...(req.jsonSchemaHint ? { responseMimeType: 'application/json' } : {})
        }
      })
    })
    if (!res.ok) throw await apiError('Gemini', res)
    const json: any = await res.json()
    const text = json?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('') ?? ''
    if (!text) throw new Error('Gemini returned an empty response.')
    return text
  }
}

/** OpenAI-compatible chat completions — used for both OpenAI and DeepSeek. */
class OpenAICompatibleProvider implements AIProvider {
  constructor(
    readonly id: string,
    readonly label: string,
    private baseUrl: string,
    private apiKey: string,
    private model: string
  ) {}

  async complete(req: AIRequest, signal?: AbortSignal): Promise<string> {
    // GPT-5-era and o-series reasoning models take max_completion_tokens and
    // reject a custom temperature; classic models still use max_tokens.
    const reasoningEra = /^(gpt-5|o\d)/.test(this.model)
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        ...(reasoningEra
          ? { max_completion_tokens: req.maxTokens ?? 4096 }
          : { temperature: req.temperature ?? 0.2, max_tokens: req.maxTokens ?? 4096 }),
        ...(req.jsonSchemaHint ? { response_format: { type: 'json_object' } } : {}),
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user }
        ]
      })
    })
    if (!res.ok) throw await apiError(this.label, res)
    const json: any = await res.json()
    const text = json?.choices?.[0]?.message?.content ?? ''
    if (!text) throw new Error(`${this.label} returned an empty response.`)
    return text
  }
}

export function makeOpenAIProvider(apiKey: string, model = 'gpt-5.6'): AIProvider {
  return new OpenAICompatibleProvider('openai', 'OpenAI', 'https://api.openai.com/v1', apiKey, model)
}

export function makeDeepSeekProvider(apiKey: string, model = 'deepseek-chat'): AIProvider {
  return new OpenAICompatibleProvider('deepseek', 'DeepSeek', 'https://api.deepseek.com/v1', apiKey, model)
}

/**
 * Anthropic (Claude) via the official SDK. Uses the Messages API — system is a
 * top-level field (not a message), and `temperature` is intentionally NOT sent
 * (Opus 4.8 rejects it). Structured JSON is requested via the prompt and parsed
 * by the robust extractJson layer, matching how the other providers are handled.
 */
export class AnthropicProvider implements AIProvider {
  readonly id = 'anthropic'
  readonly label = 'Anthropic (Claude)'
  private client: Anthropic

  constructor(
    apiKey: string,
    private model = 'claude-opus-4-8'
  ) {
    this.client = new Anthropic({ apiKey })
  }

  async complete(req: AIRequest, signal?: AbortSignal): Promise<string> {
    try {
      const message = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: req.maxTokens ?? 4096,
          system: req.system,
          messages: [{ role: 'user', content: req.user }]
        },
        { signal }
      )
      const text = message.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
      if (!text) throw new Error('Anthropic (Claude) returned an empty response.')
      return text
    } catch (err: any) {
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        throw new Error('Anthropic rejected the API key. Check it in Settings → API Keys.')
      }
      if (err instanceof Anthropic.RateLimitError) {
        throw new Error('Anthropic rate limit hit. Wait a moment and try again.')
      }
      if (err?.name === 'AbortError' || signal?.aborted) throw err
      throw new Error(`Anthropic request failed: ${err?.message ?? err}`)
    }
  }
}
