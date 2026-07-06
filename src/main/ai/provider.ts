/**
 * AI routing layer.
 *
 * One AIProvider interface, three cloud implementations (Gemini default,
 * OpenAI, DeepSeek) plus a Mock provider used whenever a key is absent so the
 * whole app runs end-to-end without credentials.
 *
 * Transcription is NOT routed here — it is pinned to OpenAI Whisper
 * (see transcription/whisper.ts).
 */

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
    private model = 'gemini-2.0-flash'
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
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        temperature: req.temperature ?? 0.2,
        max_tokens: req.maxTokens ?? 4096,
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

export function makeOpenAIProvider(apiKey: string): AIProvider {
  return new OpenAICompatibleProvider('openai', 'OpenAI', 'https://api.openai.com/v1', apiKey, 'gpt-4o-mini')
}

export function makeDeepSeekProvider(apiKey: string): AIProvider {
  return new OpenAICompatibleProvider('deepseek', 'DeepSeek', 'https://api.deepseek.com/v1', apiKey, 'deepseek-chat')
}

async function apiError(label: string, res: Response): Promise<Error> {
  let detail = ''
  try {
    detail = (await res.text()).slice(0, 300)
  } catch {
    /* ignore */
  }
  if (res.status === 401 || res.status === 403) {
    return new Error(`${label} rejected the API key. Check it in Settings → API Keys.`)
  }
  if (res.status === 429) {
    return new Error(`${label} rate limit hit. Wait a moment and try again.`)
  }
  return new Error(`${label} request failed (${res.status}). ${detail}`)
}
