/**
 * llm.mjs — minimal client for any OpenAI-compatible chat API.
 *
 * Works with DeepSeek, OpenAI, OpenRouter, Groq, Together, a local Ollama
 * (http://localhost:11434/v1), LM Studio, etc. Configure in .env:
 *   LLM_BASE_URL, LLM_API_KEY, LLM_MODEL (or LLM_RATING_MODEL / LLM_RESUME_MODEL)
 */
import { SETTINGS } from './config.mjs';

export function llmConfigured() {
  // Local servers such as Ollama need no key, so a non-default base URL counts.
  return Boolean(SETTINGS.llm.apiKey || !/deepseek\.com|openai\.com|openrouter\.ai/.test(SETTINGS.llm.baseUrl));
}

/** Pull the first JSON object out of a model reply, tolerating code fences. */
export function parseJsonReply(text) {
  const cleaned = String(text).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(cleaned); } catch { /* fall through */ }
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) return JSON.parse(m[0]);
  throw new Error(`model did not return JSON: ${cleaned.slice(0, 160)}`);
}

/**
 * Ask the model for a JSON object. Returns the parsed object, or throws.
 */
export async function chatJson({ model, system, user, temperature = 0.3, maxTokens = 4000, timeoutMs = 180000 }) {
  const { baseUrl, apiKey, jsonMode } = SETTINGS.llm;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        temperature,
        max_tokens: maxTokens,
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('LLM returned an empty response');
    return parseJsonReply(content);
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`LLM timeout after ${timeoutMs / 1000}s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
