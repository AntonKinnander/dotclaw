import { loadRuntimeConfig } from './runtime-config.js';
import type { NewMessage } from './types.js';
import { extractJson } from './json-helpers.js';

export type PlannerProbeResult = {
  shouldBackground: boolean;
  steps: string[];
  tools: string[];
  latencyMs?: number;
  model?: string;
  error?: string;
};

const PLANNER_SYSTEM_PROMPT = [
  'You are a planning router for DotClaw.',
  'Given a user request, produce a concise plan in JSON.',
  'Return JSON only with keys:',
  '- steps: array of short action steps',
  '- tools: array of tool names you expect to use (if any)',
  'Keep arrays short. Use empty arrays if not needed.'
].join('\n');

function buildPlannerPayload(params: { lastMessage: NewMessage; recentMessages: NewMessage[] }): string {
  const recent = params.recentMessages.slice(-4).map(m => ({
    sender: m.sender_name,
    content: m.content
  }));
  return JSON.stringify({
    last_message: params.lastMessage.content,
    recent_messages: recent
  });
}

export async function probePlanner(params: {
  lastMessage: NewMessage;
  recentMessages: NewMessage[];
}): Promise<PlannerProbeResult> {
  const runtime = loadRuntimeConfig();
  const config = runtime.host.routing.plannerProbe;
  if (!config.enabled) {
    return { shouldBackground: false, steps: [], tools: [] };
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return { shouldBackground: false, steps: [], tools: [], error: 'OPENROUTER_API_KEY is not set' };
  }

  const input = buildPlannerPayload(params);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: PLANNER_SYSTEM_PROMPT },
          { role: 'user', content: input }
        ],
        max_tokens: config.maxOutputTokens,
        temperature: config.temperature
      }),
      signal: controller.signal
    });
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      const text = await response.text();
      return {
        shouldBackground: false,
        steps: [],
        tools: [],
        latencyMs,
        model: config.model,
        error: `OpenRouter HTTP ${response.status}: ${text.slice(0, 300)}`
      };
    }
    const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = json.choices?.[0]?.message?.content ?? '';
    const jsonText = extractJson(text);
    if (!jsonText) {
      return { shouldBackground: false, steps: [], tools: [], latencyMs, model: config.model, error: 'Planner probe returned no JSON' };
    }
    let steps: string[] = [];
    let tools: string[] = [];
    try {
      const parsed = JSON.parse(jsonText) as { steps?: unknown; tools?: unknown };
      steps = Array.isArray(parsed.steps) ? parsed.steps.filter(item => typeof item === 'string') : [];
      tools = Array.isArray(parsed.tools) ? parsed.tools.filter(item => typeof item === 'string') : [];
    } catch {
      return { shouldBackground: false, steps: [], tools: [], latencyMs, model: config.model, error: 'Planner probe JSON parse failed' };
    }
    const shouldBackground = steps.length >= config.minSteps || tools.length >= config.minTools;
    return { shouldBackground, steps, tools, latencyMs, model: config.model };
  } catch (err) {
    return {
      shouldBackground: false,
      steps: [],
      tools: [],
      model: config.model,
      error: err instanceof Error ? err.message : String(err)
    };
  } finally {
    clearTimeout(timeout);
  }
}
