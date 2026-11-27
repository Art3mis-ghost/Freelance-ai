import { GoogleGenAI } from '@google/genai';
import { decryptSecretStrict, encryptSecret } from '../config.ts';
import { createNotification, getDb, logAudit } from '../db/database.ts';
import { safeExternalFetch, validateExternalUrl } from '../security.ts';
import { setActiveModelState } from './resourceMonitor.ts';
import type { AiProviderRecord } from '../../shared/types.ts';

interface ProviderDbRow {
  id: string;
  name: string;
  provider_type: 'ollama' | 'openai_compatible' | 'freellmapi' | 'gemini';
  api_url: string;
  encrypted_api_key: string | null;
  model: string;
  context_limit: number;
  timeout_ms: number;
  priority: number;
  role: 'primary' | 'fallback' | 'specialized';
  enabled: number;
  last_status: 'online' | 'offline' | 'unconfigured' | 'error' | 'unknown';
  last_checked_at: string | null;
  last_error: string | null;
}

export interface AiCompletionResult {
  text: string;
  providerId: string;
  providerName: string;
  model: string;
  latencyMs: number;
}

const MAX_AI_RESPONSE_BYTES = 4 * 1024 * 1024; // 4 MB hard cap for LLM JSON payloads

function getEffectiveApiKey(row: ProviderDbRow): { key: string; decryptError?: string } {
  if (row.provider_type === 'gemini') {
    const envKey = process.env.GEMINI_API_KEY?.trim() || '';
    if (envKey && envKey !== 'MY_GEMINI_API_KEY') return { key: envKey };
    return { key: '' };
  }
  if (row.encrypted_api_key) {
    const dec = decryptSecretStrict(row.encrypted_api_key);
    if (!dec.ok) {
      return { key: '', decryptError: dec.error };
    }
    if (dec.plaintext) return { key: dec.plaintext };
  }
  if (row.provider_type === 'freellmapi') return { key: process.env.FREELLM_API_KEY?.trim() || '' };
  if (row.provider_type === 'openai_compatible') return { key: process.env.OPENAI_COMPAT_API_KEY?.trim() || '' };
  return { key: '' };
}

function mapRow(row: ProviderDbRow): AiProviderRecord {
  const { key, decryptError } = getEffectiveApiKey(row);
  return {
    id: row.id,
    name: row.name,
    providerType: row.provider_type,
    apiUrl: row.api_url,
    hasApiKey: Boolean(key),
    model: row.model,
    contextLimit: row.context_limit,
    timeoutMs: row.timeout_ms,
    priority: row.priority,
    role: row.role,
    enabled: Boolean(row.enabled),
    lastStatus: decryptError ? 'error' : row.last_status,
    lastCheckedAt: row.last_checked_at,
    lastError: decryptError || row.last_error,
  };
}

export function listAiProviders(): AiProviderRecord[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM ai_providers ORDER BY priority ASC, name ASC')
    .all() as unknown as ProviderDbRow[];
  return rows.map(mapRow);
}

export function upsertAiProvider(input: {
  id: string;
  name: string;
  providerType: 'ollama' | 'openai_compatible' | 'freellmapi' | 'gemini';
  apiUrl: string;
  apiKey?: string;
  model: string;
  contextLimit: number;
  timeoutMs: number;
  priority: number;
  role: 'primary' | 'fallback' | 'specialized';
  enabled: boolean;
}): AiProviderRecord {
  const db = getDb();
  // Validate URL (allow localhost ONLY for Ollama local models)
  validateExternalUrl(input.apiUrl, { allowLocalOllama: input.providerType === 'ollama' });

  const existing = db.prepare('SELECT * FROM ai_providers WHERE id = ?').get(input.id) as
    | ProviderDbRow
    | undefined;

  // Never allow Gemini API key to be stored via UI; Gemini always uses server process.env.GEMINI_API_KEY
  let encryptedKey = existing?.encrypted_api_key ?? null;
  if (input.providerType !== 'gemini' && typeof input.apiKey === 'string' && input.apiKey.trim().length > 0) {
    encryptedKey = encryptSecret(input.apiKey.trim());
  }

  db.prepare(`
    INSERT INTO ai_providers (
      id, name, provider_type, api_url, encrypted_api_key, model, context_limit,
      timeout_ms, priority, role, enabled, last_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown')
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      provider_type = excluded.provider_type,
      api_url = excluded.api_url,
      encrypted_api_key = excluded.encrypted_api_key,
      model = excluded.model,
      context_limit = excluded.context_limit,
      timeout_ms = excluded.timeout_ms,
      priority = excluded.priority,
      role = excluded.role,
      enabled = excluded.enabled
  `).run(
    input.id,
    input.name,
    input.providerType,
    input.apiUrl,
    encryptedKey,
    input.model,
    input.contextLimit,
    input.timeoutMs,
    input.priority,
    input.role,
    input.enabled ? 1 : 0,
  );

  logAudit('ai_provider_updated', 'ai_provider', input.id, {
    name: input.name,
    providerType: input.providerType,
    model: input.model,
    enabled: input.enabled,
    priority: input.priority,
  });

  const updated = db.prepare('SELECT * FROM ai_providers WHERE id = ?').get(input.id) as unknown as ProviderDbRow;
  return mapRow(updated);
}

export async function checkProviderHealth(
  providerId: string,
  signal?: AbortSignal,
): Promise<{
  provider: AiProviderRecord;
  online: boolean;
  latencyMs: number;
  availableModels: string[];
  message: string;
}> {
  const db = getDb();
  const row = db.prepare('SELECT * FROM ai_providers WHERE id = ?').get(providerId) as
    | ProviderDbRow
    | undefined;
  if (!row) {
    throw new Error(`AI provider not found: ${providerId}`);
  }

  const started = Date.now();
  const now = new Date().toISOString();
  let status: AiProviderRecord['lastStatus'] = 'offline';
  let errorMsg: string | null = null;
  let availableModels: string[] = [];

  try {
    if (row.provider_type === 'ollama') {
      const base = validateExternalUrl(row.api_url, { allowLocalOllama: true }).toString().replace(/\/+$/, '');
      const res = await safeExternalFetch(`${base}/api/tags`, {
        method: 'GET',
        timeoutMs: Math.min(row.timeout_ms, 8000),
        maxBytes: MAX_AI_RESPONSE_BYTES,
        maxRedirects: 0,
        allowLocalOllama: true,
        signal,
      });
      if (!res.ok) {
        throw new Error(`Ollama responded with HTTP ${res.status}`);
      }
      const data = JSON.parse(res.bodyText) as { models?: Array<{ name: string }> };
      availableModels = (data.models || []).map((m) => m.name);
      status = 'online';
    } else if (row.provider_type === 'gemini') {
      const { key } = getEffectiveApiKey(row);
      if (!key) {
        status = 'unconfigured';
        errorMsg = 'GEMINI_API_KEY is not configured on the server.';
      } else {
        const ai = new GoogleGenAI({
          apiKey: key,
          httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
        });
        const resp = await ai.models.generateContent({
          model: row.model || 'gemini-4-hydrogen',
          contents: 'Reply with OK.',
        });
        if (resp.text) {
          status = 'online';
          availableModels = ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'];
        } else {
          status = 'error';
          errorMsg = 'Empty response from Gemini API.';
        }
      }
    } else {
      // OpenAI-compatible or FreeLLMAPI
      const { key, decryptError } = getEffectiveApiKey(row);
      if (decryptError) {
        status = 'error';
        errorMsg = decryptError;
      } else if (!row.api_url || row.api_url.includes('.example')) {
        status = 'unconfigured';
        errorMsg = 'Configure a real endpoint URL and API key in Settings.';
      } else {
        const base = validateExternalUrl(row.api_url, { allowLocalOllama: false }).toString().replace(/\/+$/, '');
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (key) headers.Authorization = `Bearer ${key}`;
        const res = await safeExternalFetch(`${base}/models`, {
          method: 'GET',
          headers,
          timeoutMs: Math.min(row.timeout_ms, 10000),
          maxBytes: MAX_AI_RESPONSE_BYTES,
          maxRedirects: 2,
          allowLocalOllama: false,
          signal,
        });
        if (res.ok) {
          const data = JSON.parse(res.bodyText) as { data?: Array<{ id: string }> };
          availableModels = (data.data || []).map((m) => m.id).slice(0, 30);
          status = 'online';
        } else {
          status = 'error';
          errorMsg = `Provider endpoint returned HTTP ${res.status}`;
        }
      }
    }
  } catch (err) {
    status = 'offline';
    errorMsg = err instanceof Error ? err.message : 'Connectivity check failed';
  }

  db.prepare(
    'UPDATE ai_providers SET last_status = ?, last_checked_at = ?, last_error = ? WHERE id = ?',
  ).run(status, now, errorMsg, providerId);

  const updated = db.prepare('SELECT * FROM ai_providers WHERE id = ?').get(providerId) as unknown as ProviderDbRow;
  const mapped = mapRow(updated);
  mapped.availableModels = availableModels;

  return {
    provider: mapped,
    online: status === 'online',
    latencyMs: Date.now() - started,
    availableModels,
    message: status === 'online' ? 'Connected and verified' : errorMsg || 'Provider unreachable',
  };
}

function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error('REQUEST_ABORTED'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('REQUEST_ABORTED'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (val) => {
        signal.removeEventListener('abort', onAbort);
        resolve(val);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

async function callSingleProvider(
  row: ProviderDbRow,
  systemPrompt: string,
  userPrompt: string,
  expectJson: boolean,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new Error('REQUEST_ABORTED');

  if (row.provider_type === 'ollama') {
    const base = validateExternalUrl(row.api_url, { allowLocalOllama: true }).toString().replace(/\/+$/, '');
    const res = await safeExternalFetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: row.model,
        stream: false,
        format: expectJson ? 'json' : undefined,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
      timeoutMs: row.timeout_ms,
      maxBytes: MAX_AI_RESPONSE_BYTES,
      maxRedirects: 0,
      allowLocalOllama: true,
      signal,
    });
    if (!res.ok) {
      throw new Error(`Ollama HTTP ${res.status}: ${res.bodyText.slice(0, 200) || 'request failed'}`);
    }
    const data = JSON.parse(res.bodyText) as { message?: { content?: string } };
    const text = data.message?.content?.trim();
    if (!text) throw new Error('Ollama returned an empty response');
    return text;
  }

  if (row.provider_type === 'gemini') {
    const { key } = getEffectiveApiKey(row);
    if (!key) throw new Error('GEMINI_API_KEY not configured on server');
    const ai = new GoogleGenAI({
      apiKey: key,
      httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
    });
    const response = await raceWithAbort(
      ai.models.generateContent({
        model: row.model || 'gemini-4-hydrogen',
        contents: userPrompt,
        config: {
          systemInstruction: systemPrompt,
          responseMimeType: expectJson ? 'application/json' : undefined,
        },
      }),
      signal,
    );
    const text = response.text?.trim();
    if (!text) throw new Error('Gemini returned empty response');
    return text;
  }

  // OpenAI-compatible & FreeLLMAPI
  const { key, decryptError } = getEffectiveApiKey(row);
  if (decryptError) {
    throw new Error(decryptError);
  }
  if (!row.api_url || row.api_url.includes('.example')) {
    throw new Error(`Provider ${row.name} is not configured with a live endpoint URL`);
  }
  const base = validateExternalUrl(row.api_url, { allowLocalOllama: false }).toString().replace(/\/+$/, '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;

  const res = await safeExternalFetch(`${base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: row.model,
      response_format: expectJson ? { type: 'json_object' } : undefined,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
    timeoutMs: row.timeout_ms,
    maxBytes: MAX_AI_RESPONSE_BYTES,
    maxRedirects: 2,
    allowLocalOllama: false,
    signal,
  });
  if (!res.ok) {
    throw new Error(`${row.name} HTTP ${res.status}`);
  }
  const data = JSON.parse(res.bodyText) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error(`${row.name} returned an empty completion`);
  return text;
}

export async function generateWithRouter(options: {
  systemPrompt: string;
  userPrompt: string;
  expectJson?: boolean;
  preferredProviderId?: string;
  signal?: AbortSignal;
}): Promise<AiCompletionResult> {
  if (options.signal?.aborted) {
    throw new Error('REQUEST_ABORTED');
  }

  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM ai_providers WHERE enabled = 1 ORDER BY priority ASC')
    .all() as unknown as ProviderDbRow[];

  const ordered = options.preferredProviderId
    ? [...rows.filter((r) => r.id === options.preferredProviderId), ...rows.filter((r) => r.id !== options.preferredProviderId)]
    : rows;

  if (ordered.length === 0) {
    throw new Error('No AI providers are currently enabled. Start local Ollama or enable a fallback provider in Settings.');
  }

  const errors: string[] = [];

  for (const provider of ordered) {
    if (options.signal?.aborted) throw new Error('REQUEST_ABORTED');
    const maxAttempts = provider.provider_type === 'ollama' ? 1 : 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (options.signal?.aborted) throw new Error('REQUEST_ABORTED');
      const started = Date.now();
      setActiveModelState(`${provider.name} (${provider.model})`, 'loading');
      try {
        setActiveModelState(`${provider.name} (${provider.model})`, 'active');
        const text = await callSingleProvider(
          provider,
          options.systemPrompt,
          options.userPrompt,
          Boolean(options.expectJson),
          options.signal,
        );
        db.prepare(
          'UPDATE ai_providers SET last_status = ?, last_checked_at = ?, last_error = NULL WHERE id = ?',
        ).run('online', new Date().toISOString(), provider.id);
        setActiveModelState(null, 'idle');
        return {
          text,
          providerId: provider.id,
          providerName: provider.name,
          model: provider.model,
          latencyMs: Date.now() - started,
        };
      } catch (err) {
        setActiveModelState(null, 'idle');
        const msg = err instanceof Error ? err.message : 'Unknown provider error';
        if (msg === 'REQUEST_ABORTED' || options.signal?.aborted) {
          throw new Error('REQUEST_ABORTED');
        }
        errors.push(`${provider.name} (attempt ${attempt}): ${msg}`);
        db.prepare(
          'UPDATE ai_providers SET last_status = ?, last_checked_at = ?, last_error = ? WHERE id = ?',
        ).run('offline', new Date().toISOString(), msg.slice(0, 300), provider.id);
        if (attempt < maxAttempts) {
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, 400 * attempt);
            options.signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(t);
                reject(new Error('REQUEST_ABORTED'));
              },
              { once: true },
            );
          });
        }
      }
    }
  }

  createNotification(
    'provider_unavailable',
    'All configured AI providers unavailable',
    `Local Ollama and enabled fallbacks failed: ${errors[0] || 'No connection'}`,
    'warning',
  );

  throw new Error(`All enabled AI providers failed: ${errors.join(' | ')}`);
}

export async function testProviderCompletion(providerId: string, prompt?: string): Promise<AiCompletionResult> {
  return generateWithRouter({
    preferredProviderId: providerId,
    systemPrompt: 'You are verifying connectivity for Freelance AI Agent Hub. Reply concisely in one sentence.',
    userPrompt: prompt || 'Confirm model readiness and report your capability in one short sentence.',
    expectJson: false,
  });
}
