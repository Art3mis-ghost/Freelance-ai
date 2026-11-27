import crypto from 'node:crypto';
import { createNotification, getDb, logAudit } from '../db/database.ts';
import { safeExternalFetch, validateExternalUrl } from '../security.ts';

export interface BrowserSessionRecord {
  id: string;
  connectorId: string;
  url: string;
  status: 'idle' | 'active' | 'paused_for_verification' | 'completed' | 'blocked';
  requiresHumanVerification: boolean;
  verificationNote: string | null;
  logs: string[];
  createdAt: string;
  updatedAt: string;
}

const CAPTCHA_SIGNATURES = [
  /captcha/i,
  /cf-turnstile/i,
  /g-recaptcha/i,
  /hcaptcha/i,
  /verify you are human/i,
  /just a moment/i,
  /access denied.*bot/i,
];

// Hard 1 MB cap for browser page inspection (compressed and decompressed)
const MAX_INSPECTION_BYTES = 1 * 1024 * 1024;
const MAX_INSPECTION_REDIRECTS = 4;

function mapSession(row: Record<string, unknown>): BrowserSessionRecord {
  return {
    id: String(row.id),
    connectorId: String(row.connector_id),
    url: String(row.url),
    status: row.status as BrowserSessionRecord['status'],
    requiresHumanVerification: Boolean(row.requires_human_verification),
    verificationNote: row.verification_note ? String(row.verification_note) : null,
    logs: JSON.parse(String(row.logs_json || '[]')),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function listBrowserSessions(): BrowserSessionRecord[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM browser_sessions ORDER BY updated_at DESC LIMIT 30')
    .all() as Array<Record<string, unknown>>;
  return rows.map(mapSession);
}

export async function inspectPermittedPage(
  connectorId: string,
  rawUrl: string,
  signal?: AbortSignal,
): Promise<BrowserSessionRecord> {
  const db = getDb();
  const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(connectorId) as
    | Record<string, unknown>
    | undefined;
  if (!source) throw new Error(`Connector not found: ${connectorId}`);

  if (!source.browser_automation_allowed) {
    throw new Error(
      `Browser automation is disabled by policy for "${source.name}". This system never circumvents platform anti-bot restrictions or CAPTCHAs.`,
    );
  }

  const parsed = validateExternalUrl(rawUrl, { allowLocalOllama: false });
  const id = `bsess_${crypto.randomUUID().slice(0, 10)}`;
  const now = new Date().toISOString();
  const logs: string[] = [
    `[${now}] Policy verified: permitted public page inspection for ${parsed.hostname}.`,
    `[${now}] Stealth/fingerprint spoofing: DISABLED. CAPTCHA bypass: DISABLED.`,
    `[${now}] Network guard: DNS-pinned connection, manual redirect revalidation (max ${MAX_INSPECTION_REDIRECTS}), hard ${MAX_INSPECTION_BYTES} byte limit.`,
  ];

  let status: BrowserSessionRecord['status'] = 'completed';
  let requiresVerification = false;
  let verificationNote: string | null = null;
  let finalUrl = parsed.toString();

  try {
    const res = await safeExternalFetch(parsed.toString(), {
      method: 'GET',
      headers: { 'User-Agent': 'FreelanceAIAgentHub/1.0 (Permitted Research Inspection)' },
      timeoutMs: 10000,
      maxBytes: MAX_INSPECTION_BYTES,
      maxRedirects: MAX_INSPECTION_REDIRECTS,
      allowLocalOllama: false,
      signal,
    });

    finalUrl = res.finalUrl;
    const html = res.bodyText;
    const detectedCaptcha = CAPTCHA_SIGNATURES.some((rx) => rx.test(html)) || res.status === 403 || res.status === 429;
    if (detectedCaptcha) {
      status = 'paused_for_verification';
      requiresVerification = true;
      verificationNote =
        'Human verification / CAPTCHA or rate-limit checkpoint detected. Task paused automatically — verify manually in your browser if permitted.';
      logs.push(`[${new Date().toISOString()}] Human verification detected (HTTP ${res.status}). Task paused.`);
      createNotification(
        'captcha_alert',
        'Human verification required',
        `Paused inspection on ${parsed.hostname}. Complete verification manually if permitted.`,
        'warning',
        'browser_session',
        id,
      );
    } else {
      logs.push(
        `[${new Date().toISOString()}] Permitted public page inspected cleanly (HTTP ${res.status}, ${res.decompressedBytes} bytes, ${res.redirectCount} redirect(s)).`,
      );
    }
  } catch (err) {
    status = 'blocked';
    verificationNote = err instanceof Error ? err.message : 'Request failed';
    logs.push(`[${new Date().toISOString()}] Inspection halted: ${verificationNote}`);
  }

  db.prepare(`
    INSERT INTO browser_sessions (
      id, connector_id, url, status, requires_human_verification, verification_note, logs_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    connectorId,
    finalUrl,
    status,
    requiresVerification ? 1 : 0,
    verificationNote,
    JSON.stringify(logs),
    now,
    now,
  );

  logAudit('browser_session_inspected', 'browser_session', id, {
    connectorId,
    host: parsed.hostname,
    status,
    requiresVerification,
  });

  const row = db.prepare('SELECT * FROM browser_sessions WHERE id = ?').get(id) as Record<string, unknown>;
  return mapSession(row);
}

export function resumeBrowserSessionAfterManualVerification(sessionId: string): BrowserSessionRecord {
  const db = getDb();
  const row = db.prepare('SELECT * FROM browser_sessions WHERE id = ?').get(sessionId) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new Error(`Browser session not found: ${sessionId}`);

  const logs: string[] = JSON.parse(String(row.logs_json || '[]'));
  const now = new Date().toISOString();
  logs.push(`[${now}] Operator confirmed manual verification. Session resumed for permitted workflow.`);

  db.prepare(
    `UPDATE browser_sessions SET status = 'completed', requires_human_verification = 0, verification_note = NULL, logs_json = ?, updated_at = ? WHERE id = ?`,
  ).run(JSON.stringify(logs), now, sessionId);

  logAudit('browser_session_resumed', 'browser_session', sessionId, {});
  const updated = db.prepare('SELECT * FROM browser_sessions WHERE id = ?').get(sessionId) as Record<string, unknown>;
  return mapSession(updated);
}
