import {
  EndpointPolicyError,
  PUBLIC_ONLY_NETWORK_POLICY,
  isExplicitLoopbackHost,
  safeExternalFetch,
  validateAndResolveExternalUrl,
  validateExternalUrl,
  type NetworkAccessPolicy,
  type ResolvedExternalTarget,
  type SafeFetchOptions,
  type SafeFetchResponse,
} from '../security.ts';
import type { AiProviderErrorCode, AiProviderType } from '../../shared/types.ts';

/**
 * Centralized AI Provider Endpoint Security Policy.
 *
 * Security invariants:
 * 1. Policy selection is driven EXCLUSIVELY by explicit `providerType` (never by provider name/ID).
 * 2. Local loopback access (`localhost`, `127.0.0.0/8`, `::1`, `::ffff:127.0.0.0/104`) is permitted ONLY
 *    for explicit loopback-capable AI provider types (`ollama`, `freellmapi`, `openai_compatible`).
 * 3. Private LAN ranges (10/8, 172.16/12, 192.168/16), CGNAT (100.64/10), unspecified (0.0.0.0, ::),
 *    IPv6 ULA/link-local (fc00::/7, fe80::/10), and cloud metadata endpoints (169.254.169.254,
 *    metadata.google.internal) remain strictly BLOCKED for ALL providers.
 * 4. DNS resolution checks, address pinning, and redirect boundary isolation remain enforced at every hop.
 * 5. Non-AI integrations (job connectors, browser inspection, webhooks) NEVER use this module and stay
 *    locked to `PUBLIC_ONLY_NETWORK_POLICY`.
 */

const AI_PROVIDER_POLICIES: Readonly<Record<AiProviderType, NetworkAccessPolicy>> = Object.freeze({
  ollama: Object.freeze({
    scope: 'ai_provider_loopback_or_public',
    allowExplicitLoopback: true,
    maxRedirects: 0,
    enforceRedirectBoundary: true,
    policyName: 'ai-provider:ollama',
  }),
  freellmapi: Object.freeze({
    scope: 'ai_provider_loopback_or_public',
    allowExplicitLoopback: true,
    maxRedirects: 2,
    enforceRedirectBoundary: true,
    policyName: 'ai-provider:freellmapi',
  }),
  openai_compatible: Object.freeze({
    scope: 'ai_provider_loopback_or_public',
    allowExplicitLoopback: true,
    maxRedirects: 2,
    enforceRedirectBoundary: true,
    policyName: 'ai-provider:openai_compatible',
  }),
  gemini: Object.freeze({
    scope: 'ai_provider_public_only',
    allowExplicitLoopback: false,
    allowedHosts: ['generativelanguage.googleapis.com'],
    maxRedirects: 0,
    enforceRedirectBoundary: true,
    policyName: 'ai-provider:gemini',
  }),
});

export function getAiProviderEndpointPolicy(providerType: AiProviderType): NetworkAccessPolicy {
  const policy = AI_PROVIDER_POLICIES[providerType];
  if (!policy) {
    // Fail closed for any unrecognized provider type
    return PUBLIC_ONLY_NETWORK_POLICY;
  }
  return policy;
}

export function isPlaceholderAiUrl(rawUrl: string): boolean {
  const trimmed = (rawUrl || '').trim().toLowerCase();
  if (!trimmed) return true;
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    return host === 'example.com' || host.endsWith('.example') || host.endsWith('.example.com');
  } catch {
    return trimmed.includes('.example');
  }
}

export function isLoopbackAiEndpoint(rawUrl: string): boolean {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    return isExplicitLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

export function validateAiProviderEndpoint(rawUrl: string, providerType: AiProviderType): URL {
  const policy = getAiProviderEndpointPolicy(providerType);
  return validateExternalUrl(rawUrl, { policy });
}

export async function validateAndResolveAiProviderEndpoint(
  rawUrl: string,
  providerType: AiProviderType,
  customLookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>,
): Promise<ResolvedExternalTarget> {
  const policy = getAiProviderEndpointPolicy(providerType);
  return validateAndResolveExternalUrl(rawUrl, { policy, customLookup });
}

export interface AiProviderFetchOptions
  extends Omit<SafeFetchOptions, 'policy' | 'allowLocalOllama' | 'allowedHosts'> {}

export async function fetchAiProviderEndpoint(
  rawUrl: string,
  providerType: AiProviderType,
  options: AiProviderFetchOptions = {},
): Promise<SafeFetchResponse> {
  const policy = getAiProviderEndpointPolicy(providerType);
  return safeExternalFetch(rawUrl, {
    ...options,
    policy,
    maxRedirects: options.maxRedirects ?? policy.maxRedirects,
  });
}

export class AiProviderError extends Error {
  public readonly code: AiProviderErrorCode;
  public readonly httpStatus?: number;
  public readonly providerStatus: 'offline' | 'error' | 'unconfigured';

  constructor(
    code: AiProviderErrorCode,
    message: string,
    options: { httpStatus?: number; providerStatus?: 'offline' | 'error' | 'unconfigured' } = {},
  ) {
    super(message);
    this.name = 'AiProviderError';
    this.code = code;
    this.httpStatus = options.httpStatus;
    this.providerStatus =
      options.providerStatus ??
      (code === 'connection_refused' || code === 'timeout' ? 'offline' : 'error');
  }
}

const INVALID_MODEL_PATTERNS = [
  /model\b[^.\n]{0,80}\b(not\s+found|does\s+not\s+exist|unknown|invalid|unsupported|unavailable|not\s+loaded)/i,
  /(unknown|invalid|unsupported|unrecognized|missing)\s+model\b/i,
  /model_not_found/i,
  /no\s+such\s+model/i,
];

const AUTH_ERROR_PATTERNS = [
  /invalid\s+api\s+key/i,
  /incorrect\s+api\s+key/i,
  /missing\s+(api\s+key|authorization|bearer)/i,
  /unauthorized/i,
  /authentication\s+(failed|required|error)/i,
  /encryption\s+key\s+mismatch/i,
  /failed\s+to\s+decrypt/i,
];

export function isInvalidModelResponse(status: number, bodyText: string): boolean {
  if (status !== 400 && status !== 404 && status !== 422) return false;
  return INVALID_MODEL_PATTERNS.some((rx) => rx.test(bodyText));
}

export function classifyHttpProviderError(
  providerName: string,
  status: number,
  bodyText: string,
): AiProviderError {
  const snippet = (bodyText || '').trim().slice(0, 220);

  if (status === 401 || status === 403) {
    return new AiProviderError(
      'auth_failure',
      `Authentication failed for ${providerName} (HTTP ${status})${snippet ? `: ${snippet}` : '. Check your API key.'}`,
      { httpStatus: status, providerStatus: 'error' },
    );
  }

  if (isInvalidModelResponse(status, bodyText)) {
    return new AiProviderError(
      'invalid_model',
      `Invalid or unavailable model on ${providerName} (HTTP ${status})${snippet ? `: ${snippet}` : ''}`,
      { httpStatus: status, providerStatus: 'error' },
    );
  }

  if (status === 404) {
    return new AiProviderError(
      'invalid_endpoint',
      `Endpoint not found on ${providerName} (HTTP 404)${snippet ? `: ${snippet}` : '. Verify the base URL path (e.g. /v1).'}`,
      { httpStatus: status, providerStatus: 'error' },
    );
  }

  if (status >= 500) {
    return new AiProviderError(
      'server_error',
      `${providerName} server error (HTTP ${status})${snippet ? `: ${snippet}` : ''}`,
      { httpStatus: status, providerStatus: 'error' },
    );
  }

  if (AUTH_ERROR_PATTERNS.some((rx) => rx.test(bodyText))) {
    return new AiProviderError(
      'auth_failure',
      `Authentication error from ${providerName} (HTTP ${status})${snippet ? `: ${snippet}` : ''}`,
      { httpStatus: status, providerStatus: 'error' },
    );
  }

  return new AiProviderError(
    'server_error',
    `${providerName} returned HTTP ${status}${snippet ? `: ${snippet}` : ''}`,
    { httpStatus: status, providerStatus: 'error' },
  );
}

export function classifyAiProviderError(err: unknown): AiProviderError {
  if (err instanceof AiProviderError) {
    return err;
  }

  if (err instanceof EndpointPolicyError) {
    if (err.code === 'invalid_endpoint') {
      return new AiProviderError('invalid_endpoint', err.message, { providerStatus: 'error' });
    }
    if (err.code === 'blocked_endpoint') {
      return new AiProviderError('blocked_endpoint', err.message, { providerStatus: 'error' });
    }
    return new AiProviderError('connection_refused', err.message, { providerStatus: 'offline' });
  }

  const message = err instanceof Error ? err.message : String(err || 'Unknown provider error');
  const errnoCode = (err as NodeJS.ErrnoException)?.code || '';

  if (
    errnoCode === 'ETIMEDOUT' ||
    /timed?\s*out/i.test(message) ||
    /timeout/i.test(message)
  ) {
    return new AiProviderError('timeout', `Request timed out: ${message}`, { providerStatus: 'offline' });
  }

  if (
    errnoCode === 'ECONNREFUSED' ||
    errnoCode === 'ECONNRESET' ||
    errnoCode === 'EHOSTUNREACH' ||
    errnoCode === 'ENETUNREACH' ||
    errnoCode === 'ENOTFOUND' ||
    errnoCode === 'EAI_AGAIN' ||
    /ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|DNS resolution failed/i.test(message)
  ) {
    return new AiProviderError(
      'connection_refused',
      `Connection refused or unreachable: ${message}`,
      { providerStatus: 'offline' },
    );
  }

  if (AUTH_ERROR_PATTERNS.some((rx) => rx.test(message))) {
    return new AiProviderError('auth_failure', message, { providerStatus: 'error' });
  }

  if (INVALID_MODEL_PATTERNS.some((rx) => rx.test(message))) {
    return new AiProviderError('invalid_model', message, { providerStatus: 'error' });
  }

  if (/blocked|allowlist|restricted|private network/i.test(message)) {
    return new AiProviderError('blocked_endpoint', message, { providerStatus: 'error' });
  }

  if (/invalid url|only http and https|embedded url credentials/i.test(message)) {
    return new AiProviderError('invalid_endpoint', message, { providerStatus: 'error' });
  }

  return new AiProviderError('server_error', message, { providerStatus: 'error' });
}
