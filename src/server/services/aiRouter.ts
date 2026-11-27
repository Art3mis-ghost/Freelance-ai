import { GoogleGenAI } from '@google/genai';
import { decryptSecretStrict, encryptSecret } from '../config.ts';
import { createNotification, getDb, logAudit } from '../db/database.ts';
import {
  AiProviderError,
  classifyAiProviderError,
  classifyHttpProviderError,
  fetchAiProviderEndpoint,
  isInvalidModelResponse,
  isPlaceholderAiUrl,
  validateAiProviderEndpoint,
} from './aiEndpointPolicy.ts';
import { setActiveModelState } from './resourceMonitor.ts';
import type { AiProviderErrorCode, AiProviderRecord, AiProviderType } from '../../shared/types.ts';

interface ProviderDbRow {
  id: string;
  name: string;
  provider_type: AiProviderType;
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

export interface ProviderHealthCheckResult {
  provider: AiProviderRecord;
  online: boolean;
  latencyMs: number;
  availableModels: string[];
  message: string;
  errorCode: AiProviderErrorCode | null;
}

const MAX_AI_RESPONSE_BYTES = 4 * 1024 * 1024; // 4 MB hard cap for LLM JSON payloads
const BUILTIN_PROVIDER_IDS = new Set(['ollama_local', 'freellmapi', 'openai_compat', 'gemini_fallback']);

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
  if (row.provider_type === 'freellmapi' && row.id === 'freellmapi') {
    return { key: process.env.FREELLM_API_KEY?.trim() || '' };
  }
  if (row.provider_type === 'openai_compatible' && row.id === 'openai_compat') {
    return { key: process.env.OPENAI_COMPAT_API_KEY?.trim() || '' };
  }
  return { key: '' };
}

function mapRow(row: ProviderDbRow, errorCode?: AiProviderErrorCode | null): AiProviderRecord {
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
    lastErrorCode: decryptError ? 'auth_failure' : (errorCode ?? null),
  };
}

export function listAiProviders(): AiProviderRecord[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM ai_providers ORDER BY priority ASC, name ASC')
    .all() as unknown as ProviderDbRow[];
  return rows.map((row) => mapRow(row));
}

export function resolveChatEndpoints(rawUrl: string): {
  baseUrl: string;
  modelsUrl: string | null;
  completionUrl: string;
  isDirectChatEndpoint: boolean;
} {
  const clean = rawUrl.trim().replace(/\/+$/, '');
  const lower = clean.toLowerCase();

  if (lower.endsWith('/chat/completions')) {
    const base = clean.slice(0, -'/chat/completions'.length);
    return {
      baseUrl: base,
      modelsUrl: `${base}/models`,
      completionUrl: clean,
      isDirectChatEndpoint: false,
    };
  }

  if (lower.endsWith('/chat') || lower.endsWith('/completions') || lower.endsWith('/generate')) {
    const base = clean.replace(/\/(chat|completions|generate)$/i, '');
    return {
      baseUrl: base,
      modelsUrl: `${base}/models`,
      completionUrl: clean,
      isDirectChatEndpoint: true,
    };
  }

  return {
    baseUrl: clean,
    modelsUrl: `${clean}/models`,
    completionUrl: `${clean}/chat/completions`,
    isDirectChatEndpoint: false,
  };
}

function extractTextFromProviderJson(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const obj = data as Record<string, unknown>;
  // Standard OpenAI format
  if (Array.isArray(obj.choices) && obj.choices.length > 0) {
    const first = obj.choices[0] as Record<string, unknown>;
    const msg = first?.message as Record<string, unknown> | undefined;
    if (typeof msg?.content === 'string' && msg.content.trim()) return msg.content.trim();
    if (typeof first?.text === 'string' && first.text.trim()) return first.text.trim();
  }
  // Common FreeLLMAPI / simplified JSON chat API formats
  for (const field of ['response', 'reply', 'text', 'output', 'content', 'answer', 'result']) {
    if (typeof obj[field] === 'string' && String(obj[field]).trim()) {
      return String(obj[field]).trim();
    }
  }
  if (obj.message && typeof obj.message === 'object') {
    const msgObj = obj.message as Record<string, unknown>;
    if (typeof msgObj.content === 'string' && msgObj.content.trim()) return msgObj.content.trim();
  }
  if (obj.data && typeof obj.data === 'object') {
    return extractTextFromProviderJson(obj.data);
  }
  return '';
}

function normalizeModelId(model: string, providerType: AiProviderType): string {
  const trimmed = (model || '').trim();
  if (trimmed) return trimmed;
  if (providerType === 'freellmapi' || providerType === 'openai_compatible') return 'auto';
  if (providerType === 'gemini') return 'gemini-4-hydrogen';
  return 'llama3.1:8b';
}

export function upsertAiProvider(input: {
  id: string;
  name: string;
  providerType: AiProviderType;
  apiUrl: string;
  apiKey?: string;
  clearApiKey?: boolean;
  model: string;
  contextLimit: number;
  timeoutMs: number;
  priority: number;
  role: 'primary' | 'fallback' | 'specialized';
  enabled: boolean;
}): AiProviderRecord {
  const db = getDb();
  const normalizedUrl = input.apiUrl.trim();
  const normalizedModel = normalizeModelId(input.model, input.providerType);

  // Enforce centralized, provider-type-scoped URL security policy on every create/update
  try {
    validateAiProviderEndpoint(normalizedUrl, input.providerType);
  } catch (err) {
    throw classifyAiProviderError(err);
  }

  const existing = db.prepare('SELECT * FROM ai_providers WHERE id = ?').get(input.id) as
    | ProviderDbRow
    | undefined;

  // Never allow Gemini API key to be stored via UI; Gemini always uses server process.env.GEMINI_API_KEY
  let encryptedKey = existing?.encrypted_api_key ?? null;
  if (input.providerType === 'gemini') {
    encryptedKey = null;
  } else if (input.clearApiKey) {
    encryptedKey = null;
  } else if (typeof input.apiKey === 'string' && input.apiKey.trim().length > 0) {
    encryptedKey = encryptSecret(input.apiKey.trim());
  }

  let nextStatus: ProviderDbRow['last_status'] = 'unknown';
  if (input.providerType === 'gemini') {
    const envKey = process.env.GEMINI_API_KEY?.trim() || '';
    nextStatus = envKey && envKey !== 'MY_GEMINI_API_KEY' ? 'unknown' : 'unconfigured';
  } else if (input.providerType !== 'ollama' && isPlaceholderAiUrl(normalizedUrl)) {
    nextStatus = 'unconfigured';
  }

  db.prepare(`
    INSERT INTO ai_providers (
      id, name, provider_type, api_url, encrypted_api_key, model, context_limit,
      timeout_ms, priority, role, enabled, last_status, last_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
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
      enabled = excluded.enabled,
      last_status = excluded.last_status,
      last_error = NULL
  `).run(
    input.id,
    input.name.trim(),
    input.providerType,
    normalizedUrl,
    encryptedKey,
    normalizedModel,
    input.contextLimit,
    input.timeoutMs,
    input.priority,
    input.role,
    input.enabled ? 1 : 0,
    nextStatus,
  );

  logAudit('ai_provider_updated', 'ai_provider', input.id, {
    name: input.name.trim(),
    providerType: input.providerType,
    model: normalizedModel,
    enabled: input.enabled,
    priority: input.priority,
  });

  const updated = db.prepare('SELECT * FROM ai_providers WHERE id = ?').get(input.id) as unknown as ProviderDbRow;
  return mapRow(updated);
}

export function deleteAiProvider(providerId: string): { deleted: boolean } {
  if (BUILTIN_PROVIDER_IDS.has(providerId)) {
    throw new AiProviderError('invalid_endpoint', `Built-in provider "${providerId}" cannot be deleted.`);
  }
  const db = getDb();
  const res = db.prepare('DELETE FROM ai_providers WHERE id = ?').run(providerId);
  if (res.changes === 0) {
    throw new AiProviderError('invalid_endpoint', `AI provider not found: ${providerId}`);
  }
  logAudit('ai_provider_deleted', 'ai_provider', providerId, {});
  return { deleted: true };
}

export async function checkProviderHealth(
  providerId: string,
  signal?: AbortSignal,
): Promise<ProviderHealthCheckResult> {
  const db = getDb();
  const row = db.prepare('SELECT * FROM ai_providers WHERE id = ?').get(providerId) as
    | ProviderDbRow
    | undefined;
  if (!row) {
    throw new AiProviderError('invalid_endpoint', `AI provider not found: ${providerId}`);
  }

  const started = Date.now();
  const now = new Date().toISOString();
  let status: AiProviderRecord['lastStatus'] = 'offline';
  let errorMsg: string | null = null;
  let errorCode: AiProviderErrorCode | null = null;
  let availableModels: string[] = [];

  try {
    if (row.provider_type === 'ollama') {
      const base = validateAiProviderEndpoint(row.api_url, 'ollama').toString().replace(/\/+$/, '');
      const res = await fetchAiProviderEndpoint(`${base}/api/tags`, 'ollama', {
        method: 'GET',
        timeoutMs: Math.min(row.timeout_ms, 8000),
        maxBytes: MAX_AI_RESPONSE_BYTES,
        signal,
      });
      if (!res.ok) {
        throw classifyHttpProviderError(row.name, res.status, res.bodyText);
      }
      try {
        const data = JSON.parse(res.bodyText) as { models?: Array<{ name?: string; model?: string }> };
        availableModels = (data.models || []).map((m) => m.name || m.model || '').filter(Boolean);
      } catch {
        throw new AiProviderError('server_error', `${row.name} returned invalid JSON from /api/tags`);
      }
      status = 'online';
    } else if (row.provider_type === 'gemini') {
      const { key } = getEffectiveApiKey(row);
      if (!key) {
        status = 'unconfigured';
        errorCode = 'auth_failure';
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
          errorCode = 'server_error';
          errorMsg = 'Empty response from Gemini API.';
        }
      }
    } else {
      // FreeLLMAPI & generic OpenAI-compatible providers (remote HTTPS or explicit local loopback)
      const { key, decryptError } = getEffectiveApiKey(row);
      if (decryptError) {
        throw new AiProviderError('auth_failure', decryptError, { providerStatus: 'error' });
      }
      if (isPlaceholderAiUrl(row.api_url)) {
        status = 'unconfigured';
        errorCode = 'invalid_endpoint';
        errorMsg = 'Configure a real endpoint URL (and API key if required) in Settings.';
      } else {
        const validated = validateAiProviderEndpoint(row.api_url, row.provider_type).toString();
        const endpoints = resolveChatEndpoints(validated);
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (key) headers.Authorization = `Bearer ${key}`;

        let modelsProbeOk = false;
        let modelsStatus = 0;
        let modelsBody = '';

        if (!endpoints.isDirectChatEndpoint && endpoints.modelsUrl) {
          const res = await fetchAiProviderEndpoint(endpoints.modelsUrl, row.provider_type, {
            method: 'GET',
            headers,
            timeoutMs: Math.min(row.timeout_ms, 10000),
            maxBytes: MAX_AI_RESPONSE_BYTES,
            signal,
          });
          modelsStatus = res.status;
          modelsBody = res.bodyText;

          if (res.ok) {
            try {
              const data = JSON.parse(res.bodyText) as {
                data?: Array<{ id?: string; name?: string }>;
                models?: Array<{ id?: string; name?: string }>;
              };
              if (Array.isArray(data.data)) {
                availableModels = data.data
                  .map((m) => m.id || m.name || '')
                  .filter(Boolean)
                  .slice(0, 50);
              } else if (Array.isArray(data.models)) {
                availableModels = data.models
                  .map((m) => m.id || m.name || '')
                  .filter(Boolean)
                  .slice(0, 50);
              }
            } catch {
              // Endpoint returned 2xx non-JSON or custom format; still reachable
            }
            status = 'online';
            modelsProbeOk = true;
          } else if (res.status === 401 || res.status === 403) {
            throw classifyHttpProviderError(row.name, res.status, res.bodyText);
          } else if (res.status >= 500) {
            throw classifyHttpProviderError(row.name, res.status, res.bodyText);
          }
        }

        // If endpoint is a direct /chat URL OR does not expose GET /models (404/405), verify via lightweight POST probe
        if (!modelsProbeOk && (endpoints.isDirectChatEndpoint || modelsStatus === 404 || modelsStatus === 405 || modelsStatus === 0)) {
          const probeText = await callSingleProvider(
            row,
            'Reply with OK.',
            'Health check ping. Reply with OK.',
            false,
            signal,
          );
          if (probeText) {
            status = 'online';
            if (row.model) availableModels = [row.model];
          } else {
            throw new AiProviderError('server_error', `${row.name} returned an empty health check response.`);
          }
        } else if (!modelsProbeOk) {
          throw classifyHttpProviderError(row.name, modelsStatus, modelsBody);
        }
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message === 'REQUEST_ABORTED') {
      throw err;
    }
    const classified = classifyAiProviderError(err);
    status = classified.providerStatus;
    errorCode = classified.code;
    errorMsg = classified.message;
  }

  db.prepare(
    'UPDATE ai_providers SET last_status = ?, last_checked_at = ?, last_error = ? WHERE id = ?',
  ).run(status, now, errorMsg, providerId);

  const updated = db.prepare('SELECT * FROM ai_providers WHERE id = ?').get(providerId) as unknown as ProviderDbRow;
  const mapped = mapRow(updated, errorCode);
  mapped.availableModels = availableModels;

  return {
    provider: mapped,
    online: status === 'online',
    latencyMs: Date.now() - started,
    availableModels,
    message: status === 'online' ? 'Connected and verified' : errorMsg || 'Provider unreachable',
    errorCode,
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

  try {
    if (row.provider_type === 'ollama') {
      const base = validateAiProviderEndpoint(row.api_url, 'ollama').toString().replace(/\/+$/, '');
      const res = await fetchAiProviderEndpoint(`${base}/api/chat`, 'ollama', {
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
        signal,
      });
      if (!res.ok) {
        throw classifyHttpProviderError(row.name, res.status, res.bodyText);
      }
      let data: { message?: { content?: string } };
      try {
        data = JSON.parse(res.bodyText) as { message?: { content?: string } };
      } catch {
        throw new AiProviderError('server_error', `${row.name} returned malformed JSON response`);
      }
      const text = data.message?.content?.trim();
      if (!text) throw new AiProviderError('server_error', `${row.name} returned an empty response`);
      return text;
    }

    if (row.provider_type === 'gemini') {
      const { key } = getEffectiveApiKey(row);
      if (!key) {
        throw new AiProviderError('auth_failure', 'GEMINI_API_KEY not configured on server', {
          providerStatus: 'unconfigured',
        });
      }
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
      if (!text) throw new AiProviderError('server_error', 'Gemini returned empty response');
      return text;
    }

    // FreeLLMAPI & generic OpenAI-compatible providers (remote HTTPS or explicit local loopback)
    const { key, decryptError } = getEffectiveApiKey(row);
    if (decryptError) {
      throw new AiProviderError('auth_failure', decryptError, { providerStatus: 'error' });
    }
    if (isPlaceholderAiUrl(row.api_url)) {
      throw new AiProviderError(
        'invalid_endpoint',
        `Provider ${row.name} is not configured with a live endpoint URL`,
        { providerStatus: 'unconfigured' },
      );
    }

    const validated = validateAiProviderEndpoint(row.api_url, row.provider_type).toString();
    const endpoints = resolveChatEndpoints(validated);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (key) headers.Authorization = `Bearer ${key}`;

    const effectiveModel = normalizeModelId(row.model, row.provider_type);
    const openAiBody: Record<string, unknown> = {
      model: effectiveModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    };
    if (expectJson) {
      openAiBody.response_format = { type: 'json_object' };
    }

    let res = await fetchAiProviderEndpoint(endpoints.completionUrl, row.provider_type, {
      method: 'POST',
      headers,
      body: JSON.stringify(openAiBody),
      timeoutMs: row.timeout_ms,
      maxBytes: MAX_AI_RESPONSE_BYTES,
      signal,
    });

    // Adapt cleanly for simplified FreeLLMAPI /chat endpoints that expect { message: "..." } instead of OpenAI messages[].
    // Never mask explicit auth_failure or invalid_model responses.
    if (
      !res.ok &&
      (res.status === 400 || res.status === 422) &&
      !isInvalidModelResponse(res.status, res.bodyText) &&
      (endpoints.isDirectChatEndpoint || row.provider_type === 'freellmapi')
    ) {
      const simpleRes = await fetchAiProviderEndpoint(endpoints.completionUrl, row.provider_type, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          message: `${systemPrompt}\n\n${userPrompt}`,
          model: effectiveModel,
        }),
        timeoutMs: row.timeout_ms,
        maxBytes: MAX_AI_RESPONSE_BYTES,
        signal,
      });
      if (simpleRes.ok) {
        res = simpleRes;
      }
    }

    if (!res.ok) {
      throw classifyHttpProviderError(row.name, res.status, res.bodyText);
    }

    let text = '';
    try {
      const data = JSON.parse(res.bodyText) as unknown;
      text = extractTextFromProviderJson(data);
    } catch {
      text = res.bodyText.trim();
    }
    if (!text) {
      throw new AiProviderError('server_error', `${row.name} returned an empty completion`);
    }
    return text;
  } catch (err) {
    if (err instanceof Error && err.message === 'REQUEST_ABORTED') {
      throw err;
    }
    throw classifyAiProviderError(err);
  }
}

function isRetryableProviderError(err: AiProviderError): boolean {
  return err.code === 'timeout' || err.code === 'server_error';
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
        if ((err instanceof Error && err.message === 'REQUEST_ABORTED') || options.signal?.aborted) {
          throw new Error('REQUEST_ABORTED');
        }
        const classified = classifyAiProviderError(err);
        errors.push(`${provider.name} [${classified.code}] (attempt ${attempt}): ${classified.message}`);
        db.prepare(
          'UPDATE ai_providers SET last_status = ?, last_checked_at = ?, last_error = ? WHERE id = ?',
        ).run(classified.providerStatus, new Date().toISOString(), classified.message.slice(0, 300), provider.id);

        if (attempt < maxAttempts && isRetryableProviderError(classified)) {
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
        } else {
          break;
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

/**
 * Tests completion strictly against the specified provider (NO silent fallback to other providers).
 */
export async function testProviderCompletion(
  providerId: string,
  prompt?: string,
  signal?: AbortSignal,
): Promise<AiCompletionResult> {
  const db = getDb();
  const row = db.prepare('SELECT * FROM ai_providers WHERE id = ?').get(providerId) as
    | ProviderDbRow
    | undefined;
  if (!row) {
    throw new AiProviderError('invalid_endpoint', `AI provider not found: ${providerId}`);
  }

  const started = Date.now();
  setActiveModelState(`${row.name} (${row.model})`, 'active');
  try {
    const text = await callSingleProvider(
      row,
      'You are verifying connectivity for Freelance AI Agent Hub. Reply concisely in one sentence.',
      prompt || 'Confirm model readiness and report your capability in one short sentence.',
      false,
      signal,
    );
    db.prepare(
      'UPDATE ai_providers SET last_status = ?, last_checked_at = ?, last_error = NULL WHERE id = ?',
    ).run('online', new Date().toISOString(), row.id);
    return {
      text,
      providerId: row.id,
      providerName: row.name,
      model: row.model,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    if (err instanceof Error && err.message === 'REQUEST_ABORTED') {
      throw err;
    }
    const classified = classifyAiProviderError(err);
    db.prepare(
      'UPDATE ai_providers SET last_status = ?, last_checked_at = ?, last_error = ? WHERE id = ?',
    ).run(classified.providerStatus, new Date().toISOString(), classified.message.slice(0, 300), row.id);
    throw classified;
  } finally {
    setActiveModelState(null, 'idle');
  }
}
