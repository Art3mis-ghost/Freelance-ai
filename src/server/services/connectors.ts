import crypto from 'node:crypto';
import { createNotification, getDb, getHubSettings, logAudit } from '../db/database.ts';
import { safeExternalFetch, sanitizeUntrustedText, validateExternalUrl } from '../security.ts';
import { SUPPORTED_CATEGORIES, type JobRecord, type JobSourceRecord } from '../../shared/types.ts';

export interface NormalizedJobInput {
  sourceId: string;
  sourceName: string;
  sourceJobId?: string | null;
  jobUrl?: string | null;
  title: string;
  description: string;
  clientInfo?: Record<string, unknown> | null;
  budget?: number | null;
  currency?: string;
  paymentType?: 'fixed' | 'hourly' | 'unknown';
  postedDate?: string | null;
  deadline?: string | null;
  skills?: string[];
  category?: string;
  isDemo?: boolean;
}

export interface ConnectorSearchResult {
  sourceId: string;
  jobsFound: number;
  jobsImported: number;
  duplicatesSkipped: number;
  importedJobIds: string[];
  error?: string;
}

const sourceRateTracker = new Map<string, number[]>();
const sourceBackoffState = new Map<string, { consecutiveFailures: number; cooldownUntil: number }>();

const CONNECTOR_MAX_BYTES = 3 * 1024 * 1024; // 3 MB max feed response
const PUBLIC_URL_MAX_BYTES = 1 * 1024 * 1024; // 1 MB max public page preview
const CONNECTOR_MAX_RETRIES = 2;

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('REQUEST_ABORTED'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('REQUEST_ABORTED'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function fetchFeedWithBackoff(
  url: string,
  allowedHosts: string[],
  signal?: AbortSignal,
): Promise<{ status: number; bodyText: string }> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= CONNECTOR_MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw new Error('REQUEST_ABORTED');
    try {
      const res = await safeExternalFetch(url, {
        method: 'GET',
        headers: { 'User-Agent': 'FreelanceAIAgentHub/1.0 (Permitted Public API Client)' },
        timeoutMs: 12000,
        maxBytes: CONNECTOR_MAX_BYTES,
        maxRedirects: 3,
        allowedHosts,
        allowLocalOllama: false,
        signal,
      });

      if (res.ok) {
        return { status: res.status, bodyText: res.bodyText };
      }

      // Retry transient 429 / 5xx errors with bounded backoff
      if ((res.status === 429 || res.status >= 500) && attempt < CONNECTOR_MAX_RETRIES) {
        const retryAfterSec = Number(res.headers['retry-after'] || '0');
        const backoffMs =
          Number.isFinite(retryAfterSec) && retryAfterSec > 0
            ? Math.min(10000, retryAfterSec * 1000)
            : Math.min(8000, 600 * Math.pow(2, attempt) + Math.floor(Math.random() * 250));
        await sleepWithAbort(backoffMs, signal);
        continue;
      }

      throw new Error(`Feed API returned HTTP ${res.status}`);
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (lastErr.message === 'REQUEST_ABORTED' || lastErr.message.includes('Blocked') || lastErr.message.includes('allowlist')) {
        throw lastErr;
      }
      if (attempt < CONNECTOR_MAX_RETRIES) {
        const backoffMs = Math.min(8000, 600 * Math.pow(2, attempt) + Math.floor(Math.random() * 250));
        await sleepWithAbort(backoffMs, signal);
      }
    }
  }
  throw lastErr || new Error('Feed request failed after retries');
}

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3),
  );
}

export function jaccardSimilarity(a: string, b: string): number {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function inferCategory(title: string, description: string, rawCategory?: string): string {
  const combined = `${rawCategory || ''} ${title} ${description}`.toLowerCase();
  if (/(logo|graphic design|photoshop|illustrator|flyer|brochure|banner|poster|brand identity|t-shirt design)/.test(combined)) {
    return 'Graphic Design (Excluded)';
  }
  if (/(excel|spreadsheet|google sheets|vba|pivot table)/.test(combined)) return 'Excel';
  if (/(data clean|deduplicat|normaliz|csv clean)/.test(combined)) return 'Data cleaning';
  if (/(data entry|copy paste|crm entry)/.test(combined)) return 'Data entry';
  if (/(data process|etl|pandas|dataset|analytics)/.test(combined)) return 'Data processing';
  if (/(wordpress|elementor|woocommerce)/.test(combined)) return 'WordPress';
  if (/(automat|zapier|make\.com|n8n|scraper|workflow script)/.test(combined)) return 'Automation';
  if (/(react|next\.js|frontend|backend|full-?stack|web app|html|css|shopify|website)/.test(combined)) return 'Web development';
  if (/(python|typescript|javascript|node\.js|api|software|developer|engineer|script|coding)/.test(combined)) return 'Programming';
  if (/(qa|quality assurance|test plan|unit test|playwright|selenium)/.test(combined)) return 'Testing';
  if (/(technical doc|api doc|user manual|readme|sop)/.test(combined)) return 'Technical documentation';
  if (/(seo|keyword research|backlink|search engine)/.test(combined)) return 'SEO';
  if (/(proofread|copyedit|editing)/.test(combined)) return 'Proofreading';
  if (/(content writ|blog post|article|copywrit|ghostwrit)/.test(combined)) return 'Content writing';
  if (/(powerpoint|pptx|pitch deck|slide deck)/.test(combined)) return 'PowerPoint';
  if (/(word doc|docx|report formatting)/.test(combined)) return 'Word documents';
  if (/(lead gen|prospect list|b2b leads|contact list)/.test(combined)) return 'Lead generation';
  if (/(market research|competitor analysis|business research)/.test(combined)) return 'Business research';
  if (/(internet research|web research|online research)/.test(combined)) return 'Internet research';
  if (/(product listing|amazon|ebay|etsy|ecommerce)/.test(combined)) return 'Product listing';
  if (/(transcrib|transcription|audio to text)/.test(combined)) return 'Transcription';
  if (/(translat|localization)/.test(combined)) return 'Translation';
  if (/(customer support|zendesk|ticket|helpdesk)/.test(combined)) return 'Customer support';
  if (/(email support|inbox management)/.test(combined)) return 'Email support';
  if (/(virtual assistant|admin|calendar|scheduling)/.test(combined)) return 'Virtual assistance';
  if (/(marketing|campaign|email marketing)/.test(combined)) return 'Marketing';
  if (rawCategory) {
    const match = SUPPORTED_CATEGORIES.find((c) => c.toLowerCase() === rawCategory.toLowerCase());
    if (match) return match;
  }
  return 'Other feasible work';
}

export function extractBudgetFromText(text: string): {
  budget: number | null;
  currency: string;
  paymentType: 'fixed' | 'hourly' | 'unknown';
} {
  const hourlyMatch = text.match(/(?:\$|USD\s*|€|EUR\s*|£|GBP\s*)(\d+(?:,\d{3})*(?:\.\d+)?)\s*(?:\/hr|per hour|hourly)/i);
  if (hourlyMatch) {
    const amount = Number(hourlyMatch[1].replace(/,/g, ''));
    const currency = text.includes('€') || /EUR/i.test(text) ? 'EUR' : text.includes('£') || /GBP/i.test(text) ? 'GBP' : 'USD';
    return { budget: Number.isFinite(amount) ? amount : null, currency, paymentType: 'hourly' };
  }
  const fixedMatch = text.match(/(?:\$|USD\s*|€|EUR\s*|£|GBP\s*)(\d+(?:,\d{3})*(?:\.\d+)?)/i);
  if (fixedMatch) {
    const amount = Number(fixedMatch[1].replace(/,/g, ''));
    const currency = text.includes('€') || /EUR/i.test(text) ? 'EUR' : text.includes('£') || /GBP/i.test(text) ? 'GBP' : 'USD';
    return { budget: Number.isFinite(amount) ? amount : null, currency, paymentType: 'fixed' };
  }
  return { budget: null, currency: 'USD', paymentType: 'unknown' };
}

export function listSources(): JobSourceRecord[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM sources ORDER BY implementation_status ASC, name ASC').all() as Array<
    Record<string, unknown>
  >;
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    connectorType: r.connector_type as JobSourceRecord['connectorType'],
    implementationStatus: r.implementation_status as JobSourceRecord['implementationStatus'],
    enabled: Boolean(r.enabled),
    automationAllowed: Boolean(r.automation_allowed),
    browserAutomationAllowed: Boolean(r.browser_automation_allowed),
    connectionStatus: r.connection_status as JobSourceRecord['connectionStatus'],
    capabilities: JSON.parse(String(r.capabilities_json || '[]')),
    rateLimitPerHour: Number(r.rate_limit_per_hour || 10),
    searchFrequencyMinutes: Number(r.search_frequency_minutes || 60),
    lastSuccessfulSearch: r.last_successful_search ? String(r.last_successful_search) : null,
    lastError: r.last_error ? String(r.last_error) : null,
    jobsDiscovered: Number(r.jobs_discovered || 0),
    jobsImported: Number(r.jobs_imported || 0),
    policyNote: String(r.policy_note || ''),
    endpointUrl: r.endpoint_url ? String(r.endpoint_url) : null,
  }));
}

export function updateSourceConfig(
  sourceId: string,
  patch: Partial<{
    enabled: boolean;
    rateLimitPerHour: number;
    searchFrequencyMinutes: number;
    browserAutomationAllowed: boolean;
  }>,
): JobSourceRecord {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM sources WHERE id = ?').get(sourceId) as
    | Record<string, unknown>
    | undefined;
  if (!existing) throw new Error(`Job source not found: ${sourceId}`);

  // Enforce platform ToS policy: scaffold connectors cannot enable scraping/browser automation
  const isScaffold = existing.implementation_status === 'scaffold_manual_only';
  const nextEnabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : Number(existing.enabled);
  const nextBrowser = isScaffold
    ? 0
    : patch.browserAutomationAllowed !== undefined
      ? patch.browserAutomationAllowed
        ? 1
        : 0
      : Number(existing.browser_automation_allowed);
  const nextRate = patch.rateLimitPerHour !== undefined ? Math.max(1, Math.min(1000, patch.rateLimitPerHour)) : Number(existing.rate_limit_per_hour);
  const nextFreq = patch.searchFrequencyMinutes !== undefined ? Math.max(5, Math.min(1440, patch.searchFrequencyMinutes)) : Number(existing.search_frequency_minutes);

  const nextStatus = isScaffold
    ? 'manual_only'
    : nextEnabled
      ? 'ready'
      : 'disabled';

  db.prepare(
    `UPDATE sources
     SET enabled = ?, browser_automation_allowed = ?, rate_limit_per_hour = ?, search_frequency_minutes = ?, connection_status = ?, updated_at = ?
     WHERE id = ?`,
  ).run(nextEnabled, nextBrowser, nextRate, nextFreq, nextStatus, new Date().toISOString(), sourceId);

  logAudit('source_updated', 'source', sourceId, { enabled: Boolean(nextEnabled), rateLimitPerHour: nextRate });
  return listSources().find((s) => s.id === sourceId)!;
}

export function detectDuplicateJob(input: NormalizedJobInput): { isDuplicate: boolean; existingId?: string; reason?: string } {
  const db = getDb();
  if (input.sourceJobId) {
    const bySourceId = db
      .prepare('SELECT id FROM jobs WHERE source_id = ? AND source_job_id = ?')
      .get(input.sourceId, input.sourceJobId) as { id: string } | undefined;
    if (bySourceId) {
      return { isDuplicate: true, existingId: bySourceId.id, reason: 'Matched source_id + source_job_id' };
    }
  }

  if (input.jobUrl) {
    const byUrl = db.prepare('SELECT id FROM jobs WHERE job_url = ?').get(input.jobUrl) as
      | { id: string }
      | undefined;
    if (byUrl) {
      return { isDuplicate: true, existingId: byUrl.id, reason: 'Matched job URL' };
    }
  }

  const normTitle = normalizeTitle(input.title);
  const candidates = db
    .prepare('SELECT id, description FROM jobs WHERE normalized_title = ? LIMIT 15')
    .all(normTitle) as Array<{ id: string; description: string }>;

  for (const c of candidates) {
    const sim = jaccardSimilarity(input.description, c.description);
    if (sim >= 0.72 || input.description.trim() === c.description.trim()) {
      return { isDuplicate: true, existingId: c.id, reason: `Matched normalized title & description similarity (${Math.round(sim * 100)}%)` };
    }
  }

  return { isDuplicate: false };
}

export function importNormalizedJob(input: NormalizedJobInput): {
  imported: boolean;
  duplicate: boolean;
  jobId: string;
  reason?: string;
} {
  const db = getDb();
  const safeTitle = sanitizeUntrustedText(input.title).sanitized.slice(0, 260);
  const safeDesc = sanitizeUntrustedText(input.description).sanitized;

  if (!safeTitle || !safeDesc) {
    throw new Error('Job title and description are required');
  }

  if (input.jobUrl) {
    validateExternalUrl(input.jobUrl, { allowLocalOllama: false });
  }

  const dup = detectDuplicateJob({ ...input, title: safeTitle, description: safeDesc });
  if (dup.isDuplicate && dup.existingId) {
    // Never overwrite user-edited jobs
    return { imported: false, duplicate: true, jobId: dup.existingId, reason: dup.reason };
  }

  const now = new Date().toISOString();
  const id = `job_${crypto.randomUUID().slice(0, 12)}`;
  const extracted =
    input.budget === undefined || input.budget === null
      ? extractBudgetFromText(`${safeTitle} ${safeDesc}`)
      : {
          budget: input.budget,
          currency: input.currency || 'USD',
          paymentType: input.paymentType || 'fixed',
        };

  const category = input.category || inferCategory(safeTitle, safeDesc);

  db.prepare(`
    INSERT INTO jobs (
      id, source_id, source_name, source_job_id, job_url, title, normalized_title,
      description, client_info_json, budget, currency, payment_type, posted_date,
      deadline, skills_json, category, status, is_demo, date_discovered, date_imported, date_updated
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?)
  `).run(
    id,
    input.sourceId,
    input.sourceName,
    input.sourceJobId || null,
    input.jobUrl || null,
    safeTitle,
    normalizeTitle(safeTitle),
    safeDesc,
    input.clientInfo ? JSON.stringify(input.clientInfo) : null,
    extracted.budget,
    input.currency || extracted.currency || 'USD',
    input.paymentType || extracted.paymentType || 'unknown',
    input.postedDate || now,
    input.deadline || null,
    JSON.stringify(input.skills || []),
    category,
    input.isDemo ? 1 : 0,
    now,
    now,
    now,
  );

  db.prepare(
    'UPDATE sources SET jobs_discovered = jobs_discovered + 1, jobs_imported = jobs_imported + 1, updated_at = ? WHERE id = ?',
  ).run(now, input.sourceId);

  return { imported: true, duplicate: false, jobId: id };
}

function checkRateLimit(source: JobSourceRecord): void {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const timestamps = (sourceRateTracker.get(source.id) || []).filter((t) => now - t < windowMs);
  if (timestamps.length >= source.rateLimitPerHour) {
    throw new Error(`Rate limit reached for ${source.name} (${source.rateLimitPerHour}/hour)`);
  }
  timestamps.push(now);
  sourceRateTracker.set(source.id, timestamps);
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function runSourceSearch(
  sourceId: string,
  query = '',
  limit?: number,
  options: { signal?: AbortSignal; ignoreCooldown?: boolean } = {},
): Promise<ConnectorSearchResult> {
  const db = getDb();
  const settings = getHubSettings();
  const maxItems = limit || settings.scheduler.maxJobsPerSearch || 20;
  const source = listSources().find((s) => s.id === sourceId);
  if (!source) {
    throw new Error(`Source not found: ${sourceId}`);
  }

  const startedAt = new Date().toISOString();

  if (source.implementationStatus === 'scaffold_manual_only') {
    const msg = `${source.name} does not permit automated scraping. Use Manual Import (URL / Text / CSV / JSON).`;
    db.prepare(
      'INSERT INTO search_history (id, source_id, query, jobs_found, jobs_imported, duplicates_skipped, status, error_message, started_at, completed_at) VALUES (?, ?, ?, 0, 0, 0, ?, ?, ?, ?)',
    ).run(crypto.randomUUID(), sourceId, query, 'blocked_by_policy', msg, startedAt, new Date().toISOString());
    return {
      sourceId,
      jobsFound: 0,
      jobsImported: 0,
      duplicatesSkipped: 0,
      importedJobIds: [],
      error: msg,
    };
  }

  if (!source.enabled) {
    throw new Error(`Source ${source.name} is disabled. Enable it in Job Sources first.`);
  }

  const backoff = sourceBackoffState.get(sourceId);
  if (!options.ignoreCooldown && backoff && backoff.cooldownUntil > Date.now()) {
    const waitSec = Math.ceil((backoff.cooldownUntil - Date.now()) / 1000);
    return {
      sourceId,
      jobsFound: 0,
      jobsImported: 0,
      duplicatesSkipped: 0,
      importedJobIds: [],
      error: `${source.name} is temporarily cooling down after ${backoff.consecutiveFailures} consecutive failures (retry in ${waitSec}s).`,
    };
  }

  try {
    checkRateLimit(source);
    let rawItems: NormalizedJobInput[] = [];

    if (sourceId === 'remotive_public') {
      const url = new URL('https://remotive.com/api/remote-jobs');
      if (query.trim()) url.searchParams.set('search', query.trim());
      url.searchParams.set('limit', String(Math.min(maxItems, 40)));

      const res = await fetchFeedWithBackoff(url.toString(), ['remotive.com'], options.signal);
      const payload = JSON.parse(res.bodyText) as {
        jobs?: Array<{
          id: number;
          url: string;
          title: string;
          company_name?: string;
          category?: string;
          tags?: string[];
          publication_date?: string;
          salary?: string;
          description?: string;
          candidate_required_location?: string;
        }>;
      };

      rawItems = (payload.jobs || []).slice(0, maxItems).map((j) => {
        const cleanDesc = stripHtml(j.description || '');
        const salaryParsed = extractBudgetFromText(j.salary || cleanDesc);
        return {
          sourceId: 'remotive_public',
          sourceName: 'Remotive',
          sourceJobId: String(j.id),
          jobUrl: j.url,
          title: j.title,
          description: cleanDesc || j.title,
          clientInfo: {
            company: j.company_name || 'Not listed',
            location: j.candidate_required_location || 'Remote',
            salaryRaw: j.salary || null,
          },
          budget: salaryParsed.budget,
          currency: salaryParsed.currency,
          paymentType: salaryParsed.paymentType,
          postedDate: j.publication_date || null,
          skills: Array.isArray(j.tags) ? j.tags.slice(0, 12) : [],
          category: inferCategory(j.title, cleanDesc, j.category),
        };
      });
    } else if (sourceId === 'arbeitnow_public') {
      const url = 'https://www.arbeitnow.com/api/job-board-api';
      const res = await fetchFeedWithBackoff(url, ['www.arbeitnow.com', 'arbeitnow.com'], options.signal);
      const payload = JSON.parse(res.bodyText) as {
        data?: Array<{
          slug: string;
          url: string;
          title: string;
          company_name?: string;
          description?: string;
          tags?: string[];
          location?: string;
          remote?: boolean;
          created_at?: number;
        }>;
      };

      const q = query.trim().toLowerCase();
      const filtered = (payload.data || []).filter((j) => {
        if (!q) return true;
        return (
          j.title.toLowerCase().includes(q) ||
          (j.description || '').toLowerCase().includes(q) ||
          (j.tags || []).some((t) => t.toLowerCase().includes(q))
        );
      });

      rawItems = filtered.slice(0, maxItems).map((j) => {
        const cleanDesc = stripHtml(j.description || '');
        const salaryParsed = extractBudgetFromText(cleanDesc);
        return {
          sourceId: 'arbeitnow_public',
          sourceName: 'Arbeitnow',
          sourceJobId: j.slug,
          jobUrl: j.url,
          title: j.title,
          description: cleanDesc || j.title,
          clientInfo: {
            company: j.company_name || 'Not listed',
            location: j.location || (j.remote ? 'Remote' : 'Not specified'),
            remote: Boolean(j.remote),
          },
          budget: salaryParsed.budget,
          currency: salaryParsed.currency,
          paymentType: salaryParsed.paymentType,
          postedDate: j.created_at ? new Date(j.created_at * 1000).toISOString() : null,
          skills: Array.isArray(j.tags) ? j.tags.slice(0, 12) : [],
          category: inferCategory(j.title, cleanDesc),
        };
      });
    }

    // Reset failure backoff on success
    sourceBackoffState.delete(sourceId);

    let imported = 0;
    let duplicates = 0;
    const importedJobIds: string[] = [];

    for (const item of rawItems) {
      const result = importNormalizedJob(item);
      if (result.imported) {
        imported++;
        importedJobIds.push(result.jobId);
      } else if (result.duplicate) {
        duplicates++;
      }
    }

    const completedAt = new Date().toISOString();
    db.prepare(
      'UPDATE sources SET connection_status = ?, last_successful_search = ?, last_error = NULL, updated_at = ? WHERE id = ?',
    ).run('connected', completedAt, completedAt, sourceId);

    db.prepare(
      'INSERT INTO search_history (id, source_id, query, jobs_found, jobs_imported, duplicates_skipped, status, error_message, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)',
    ).run(
      crypto.randomUUID(),
      sourceId,
      query,
      rawItems.length,
      imported,
      duplicates,
      'completed',
      startedAt,
      completedAt,
    );

    logAudit('source_search_completed', 'source', sourceId, {
      query,
      jobsFound: rawItems.length,
      jobsImported: imported,
      duplicatesSkipped: duplicates,
    });

    return {
      sourceId,
      jobsFound: rawItems.length,
      jobsImported: imported,
      duplicatesSkipped: duplicates,
      importedJobIds,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Connector search failed';
    if (errMsg !== 'REQUEST_ABORTED') {
      const prev = sourceBackoffState.get(sourceId) || { consecutiveFailures: 0, cooldownUntil: 0 };
      const failures = prev.consecutiveFailures + 1;
      const cooldownMs = failures >= 3 ? Math.min(15 * 60 * 1000, 60 * 1000 * Math.pow(2, failures - 3)) : 0;
      sourceBackoffState.set(sourceId, {
        consecutiveFailures: failures,
        cooldownUntil: cooldownMs > 0 ? Date.now() + cooldownMs : 0,
      });
    }

    const completedAt = new Date().toISOString();
    db.prepare(
      'UPDATE sources SET connection_status = ?, last_error = ?, updated_at = ? WHERE id = ?',
    ).run('error', errMsg.slice(0, 400), completedAt, sourceId);

    db.prepare(
      'INSERT INTO search_history (id, source_id, query, jobs_found, jobs_imported, duplicates_skipped, status, error_message, started_at, completed_at) VALUES (?, ?, ?, 0, 0, 0, ?, ?, ?, ?)',
    ).run(crypto.randomUUID(), sourceId, query, 'failed', errMsg, startedAt, completedAt);

    createNotification('connector_error', `Connector failed: ${source.name}`, errMsg, 'error', 'source', sourceId);
    return {
      sourceId,
      jobsFound: 0,
      jobsImported: 0,
      duplicatesSkipped: 0,
      importedJobIds: [],
      error: errMsg,
    };
  }
}

export async function importFromPublicUrl(rawUrl: string, platformLabel = 'Manual URL'): Promise<{
  imported: boolean;
  duplicate: boolean;
  jobId: string;
  warning?: string;
}> {
  const parsed = validateExternalUrl(rawUrl, { allowLocalOllama: false });
  let title = `Imported listing from ${parsed.hostname}`;
  let description = `Job URL imported manually: ${parsed.toString()}`;
  let warning: string | undefined;

  try {
    const res = await safeExternalFetch(parsed.toString(), {
      method: 'GET',
      headers: { 'User-Agent': 'FreelanceAIAgentHub/1.0' },
      timeoutMs: 8000,
      maxBytes: PUBLIC_URL_MAX_BYTES,
      maxRedirects: 4,
      allowLocalOllama: false,
    });

    if (res.ok) {
      const html = res.bodyText;
      const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      if (titleMatch?.[1]) {
        title = stripHtml(titleMatch[1]).slice(0, 200);
      }
      const metaDesc = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i);
      const bodyText = stripHtml(html).slice(0, 4000);
      description = metaDesc?.[1] ? `${metaDesc[1]}\n\n${bodyText}` : bodyText || description;
    } else {
      warning = `Page returned HTTP ${res.status} (site may require login). Saved URL record so you can paste the description.`;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('Blocked') || msg.includes('restricted')) {
      throw err;
    }
    warning = 'Could not automatically fetch page contents. Saved URL record so you can paste the full job description.';
  }

  const res = importNormalizedJob({
    sourceId: 'manual',
    sourceName: platformLabel,
    jobUrl: parsed.toString(),
    title,
    description,
  });

  return { ...res, warning };
}

export function parseCsvJobs(csvText: string): NormalizedJobInput[] {
  const lines = csvText
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];

  const parseLine = (line: string): string[] => {
    const out: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        out.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    out.push(current.trim());
    return out;
  };

  const headers = parseLine(lines[0]).map((h) => h.toLowerCase().replace(/[^a-z0-9_]/g, ''));
  const idx = (names: string[]) => headers.findIndex((h) => names.includes(h));

  const titleIdx = idx(['title', 'jobtitle', 'name', 'subject']);
  const descIdx = idx(['description', 'details', 'body', 'summary']);
  const urlIdx = idx(['url', 'joburl', 'link']);
  const budgetIdx = idx(['budget', 'price', 'amount', 'rate']);
  const currencyIdx = idx(['currency']);
  const platformIdx = idx(['source', 'platform', 'sourcename']);
  const skillsIdx = idx(['skills', 'tags']);
  const categoryIdx = idx(['category']);
  const deadlineIdx = idx(['deadline', 'duedate']);

  const jobs: NormalizedJobInput[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseLine(lines[i]);
    const title = titleIdx >= 0 ? cols[titleIdx] : cols[0];
    const description = descIdx >= 0 ? cols[descIdx] : cols[1] || title;
    if (!title) continue;
    const rawBudget = budgetIdx >= 0 ? Number(cols[budgetIdx]?.replace(/[^0-9.]/g, '')) : NaN;
    jobs.push({
      sourceId: 'manual',
      sourceName: (platformIdx >= 0 && cols[platformIdx]) || 'CSV Import',
      jobUrl: urlIdx >= 0 && cols[urlIdx] ? cols[urlIdx] : null,
      title,
      description,
      budget: Number.isFinite(rawBudget) && rawBudget > 0 ? rawBudget : null,
      currency: (currencyIdx >= 0 && cols[currencyIdx]) || 'USD',
      skills: skillsIdx >= 0 && cols[skillsIdx] ? cols[skillsIdx].split(/[;|]/).map((s) => s.trim()).filter(Boolean) : [],
      category: categoryIdx >= 0 && cols[categoryIdx] ? cols[categoryIdx] : undefined,
      deadline: deadlineIdx >= 0 && cols[deadlineIdx] ? cols[deadlineIdx] : null,
    });
  }
  return jobs;
}

export function mapJobRow(row: Record<string, unknown>): JobRecord {
  return {
    id: String(row.id),
    sourceId: String(row.source_id),
    sourceName: String(row.source_name),
    sourceJobId: row.source_job_id ? String(row.source_job_id) : null,
    jobUrl: row.job_url ? String(row.job_url) : null,
    title: String(row.title),
    description: String(row.description),
    clientInfo: row.client_info_json ? JSON.parse(String(row.client_info_json)) : null,
    budget: row.budget !== null && row.budget !== undefined ? Number(row.budget) : null,
    currency: String(row.currency || 'USD'),
    paymentType: (row.payment_type as JobRecord['paymentType']) || 'unknown',
    postedDate: row.posted_date ? String(row.posted_date) : null,
    deadline: row.deadline ? String(row.deadline) : null,
    skills: JSON.parse(String(row.skills_json || '[]')),
    category: String(row.category || 'Other feasible work'),
    estimatedHours: row.estimated_hours !== null && row.estimated_hours !== undefined ? Number(row.estimated_hours) : null,
    jobScore: row.job_score !== null && row.job_score !== undefined ? Number(row.job_score) : null,
    riskScore: row.risk_score !== null && row.risk_score !== undefined ? Number(row.risk_score) : null,
    matchScore: row.match_score !== null && row.match_score !== undefined ? Number(row.match_score) : null,
    scoreBreakdown: row.score_breakdown_json ? JSON.parse(String(row.score_breakdown_json)) : null,
    analysis: row.analysis_json ? JSON.parse(String(row.analysis_json)) : null,
    status: row.status as JobRecord['status'],
    isDemo: Boolean(row.is_demo),
    rejectionReason: row.rejection_reason ? String(row.rejection_reason) : null,
    overrideRejected: Boolean(row.override_rejected),
    userEdited: Boolean(row.user_edited),
    dateDiscovered: String(row.date_discovered),
    dateImported: String(row.date_imported),
    dateAnalyzed: row.date_analyzed ? String(row.date_analyzed) : null,
    dateUpdated: String(row.date_updated),
  };
}
