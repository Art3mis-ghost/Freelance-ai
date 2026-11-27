import fs from 'node:fs';
import path from 'node:path';
import express, { type Router } from 'express';
import { z } from 'zod';
import { CONFIG, getEncryptionKeyInfo } from './config.ts';
import { getDb, getHubSettings, logAudit, saveHubSettings } from './db/database.ts';
import {
  TOOL_REGISTRY,
  checkAuthRateLimit,
  createSessionToken,
  extractBearerToken,
  getRecentAuthFailures,
  hashPassword,
  isLocalhostBootstrapRequest,
  readSafeWorkspaceFile,
  recordAuthFailure,
  recordAuthSuccess,
  requireAuth,
  revokeSessionToken,
  sanitizePathSegment,
  verifyEnvPasscode,
  verifyPassword,
  verifySessionToken,
  verifySetupToken,
} from './security.ts';
import {
  checkProviderHealth,
  listAiProviders,
  testProviderCompletion,
  upsertAiProvider,
} from './services/aiRouter.ts';
import {
  buildAnalyticsReport,
  buildDashboardData,
  recordProjectPayment,
  toggleDemoMode,
} from './services/analyticsService.ts';
import {
  inspectPermittedPage,
  listBrowserSessions,
  resumeBrowserSessionAfterManualVerification,
} from './services/browserAutomation.ts';
import {
  importFromPublicUrl,
  importNormalizedJob,
  listSources,
  mapJobRow,
  parseCsvJobs,
  runSourceSearch,
  updateSourceConfig,
} from './services/connectors.ts';
import { analyzeJobById } from './services/jobAnalyst.ts';
import { generateProposalForJob, listProposals, updateProposal } from './services/proposalService.ts';
import { evaluateProjectQa, listQaReports } from './services/qaService.ts';
import { getResourceSnapshot, setSchedulerPaused } from './services/resourceMonitor.ts';
import {
  approveJobIntoProject,
  cancelTask,
  enqueueTask,
  listProjectTasks,
  mapAgentTaskRow,
  mapProjectRow,
  pauseTask,
  resumeTask,
} from './services/taskQueue.ts';
import {
  listProjectDeliverables,
  listWorkspaceTree,
  packageProjectDeliverablesZip,
  previewWorkspaceFile,
  writeWorkspaceTextFile,
} from './services/workspaceService.ts';
import { AGENT_ROSTER, type HubSettings } from '../shared/types.ts';

function isAuthClaimed(): { claimed: boolean; envOverride: boolean } {
  if (CONFIG.adminPasscodeEnv) {
    return { claimed: true, envOverride: true };
  }
  const db = getDb();
  const row = db.prepare('SELECT id FROM auth_credentials WHERE id = 1').get();
  return { claimed: Boolean(row), envOverride: false };
}

export function createApiRouter(): Router {
  const router = express.Router();

  // 1. Minimal Public Health Endpoint (BUG-19: zero internal config or host details leaked)
  router.get('/health', (_req, res) => {
    try {
      const db = getDb();
      db.prepare('SELECT 1 as ok').get();
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'error' });
    }
  });

  // 2. Local Authentication Routes (Localhost-Only First-Run Claim + Rate-Limited Scrypt Login)
  router.get('/auth/status', (req, res) => {
    const state = isAuthClaimed();
    const token = extractBearerToken(req);
    const authenticated = verifySessionToken(token);
    const bootstrapCheck = isLocalhostBootstrapRequest(req);
    res.json({
      claimed: state.claimed,
      envOverride: state.envOverride,
      authenticated,
      requiresSetupToken: Boolean(CONFIG.setupTokenEnv),
      bootstrapAllowed: bootstrapCheck.allowed,
    });
  });

  router.post('/auth/bootstrap', async (req, res) => {
    // BUG-02: Rate-limit & lockout bootstrap attempts
    const limit = checkAuthRateLimit(req, 'bootstrap');
    if (!limit.allowed) {
      if (limit.retryAfterSec) res.setHeader('Retry-After', String(limit.retryAfterSec));
      res.status(429).json({ error: limit.reason || 'Too many setup attempts', retryAfterSec: limit.retryAfterSec });
      return;
    }
    if (limit.delayMs && limit.delayMs > 0) {
      await new Promise((r) => setTimeout(r, limit.delayMs));
    }

    // BUG-01: Prevent remote bootstrap even if server is exposed on 0.0.0.0 or behind a reverse proxy
    const localCheck = isLocalhostBootstrapRequest(req);
    if (!localCheck.allowed) {
      recordAuthFailure(req, 'bootstrap', 'remote_bootstrap_blocked');
      logAudit('auth_bootstrap_blocked_remote', 'auth', 'admin', {}, 'warning', 'remote');
      res.status(403).json({ error: localCheck.reason });
      return;
    }

    const schema = z.object({
      passcode: z.string().min(6, 'Passcode must be at least 6 characters').max(128),
      setupToken: z.string().max(256).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      recordAuthFailure(req, 'bootstrap', 'invalid_payload');
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid passcode' });
      return;
    }

    // BUG-01: Enforce first-run setup token when configured via HUB_SETUP_TOKEN
    if (!verifySetupToken(parsed.data.setupToken)) {
      const fail = recordAuthFailure(req, 'bootstrap', 'invalid_setup_token');
      logAudit('auth_bootstrap_invalid_token', 'auth', 'admin', { failures: fail.consecutiveFailures }, 'warning', 'unknown');
      if (fail.locked && fail.retryAfterSec) {
        res.setHeader('Retry-After', String(fail.retryAfterSec));
        res.status(429).json({
          error: `Invalid setup token. Temporarily locked for ${fail.retryAfterSec}s.`,
          retryAfterSec: fail.retryAfterSec,
        });
        return;
      }
      res.status(403).json({ error: 'Valid first-run setup token is required (see HUB_SETUP_TOKEN in .env).' });
      return;
    }

    const state = isAuthClaimed();
    if (state.claimed) {
      recordAuthFailure(req, 'bootstrap', 'already_claimed');
      res.status(409).json({ error: 'Admin passcode is already configured. Please sign in.' });
      return;
    }

    const db = getDb();
    const { hash, salt } = hashPassword(parsed.data.passcode);
    try {
      db.prepare(
        'INSERT INTO auth_credentials (id, password_hash, password_salt, claimed_at) VALUES (1, ?, ?, ?)',
      ).run(hash, salt, new Date().toISOString());
    } catch {
      res.status(409).json({ error: 'Admin passcode was already claimed.' });
      return;
    }

    recordAuthSuccess(req, 'bootstrap');
    const session = createSessionToken();
    logAudit('admin_passcode_claimed', 'auth', 'admin', {}, 'info', 'operator');
    res.status(201).json({ token: session.token, expiresAt: session.expiresAt });
  });

  router.post('/auth/login', async (req, res) => {
    // BUG-02: Rate-limit, progressive delay, and lockout on login attempts
    const limit = checkAuthRateLimit(req, 'login');
    if (!limit.allowed) {
      if (limit.retryAfterSec) res.setHeader('Retry-After', String(limit.retryAfterSec));
      res.status(429).json({ error: limit.reason || 'Too many login attempts', retryAfterSec: limit.retryAfterSec });
      return;
    }
    if (limit.delayMs && limit.delayMs > 0) {
      await new Promise((r) => setTimeout(r, limit.delayMs));
    }

    const schema = z.object({ passcode: z.string().min(1).max(128) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      recordAuthFailure(req, 'login', 'missing_passcode');
      res.status(400).json({ error: 'Passcode is required' });
      return;
    }

    const state = isAuthClaimed();
    if (!state.claimed) {
      res.status(400).json({ error: 'No admin passcode configured yet. Complete first-run setup.' });
      return;
    }

    let valid = false;
    if (state.envOverride) {
      valid = verifyEnvPasscode(parsed.data.passcode);
    } else {
      const db = getDb();
      const row = db
        .prepare('SELECT password_hash, password_salt FROM auth_credentials WHERE id = 1')
        .get() as { password_hash: string; password_salt: string } | undefined;
      if (row) {
        valid = verifyPassword(parsed.data.passcode, row.password_hash, row.password_salt);
      }
    }

    if (!valid) {
      const fail = recordAuthFailure(req, 'login', 'invalid_passcode');
      logAudit('auth_login_failed', 'auth', 'admin', { consecutiveFailures: fail.consecutiveFailures, locked: fail.locked }, 'warning', 'unknown');
      // Enforce bounded retention on auth failure audit entries
      try {
        getDb()
          .prepare(
            `DELETE FROM audit_logs WHERE action = 'auth_login_failed' AND id NOT IN (
               SELECT id FROM audit_logs WHERE action = 'auth_login_failed' ORDER BY created_at DESC LIMIT 200
             )`,
          )
          .run();
      } catch {
        // non-fatal
      }
      if (fail.locked && fail.retryAfterSec) {
        res.setHeader('Retry-After', String(fail.retryAfterSec));
        res.status(429).json({
          error: `Too many failed login attempts. Temporarily locked for ${fail.retryAfterSec}s.`,
          retryAfterSec: fail.retryAfterSec,
        });
        return;
      }
      res.status(401).json({ error: 'Invalid passcode' });
      return;
    }

    recordAuthSuccess(req, 'login');
    const session = createSessionToken();
    logAudit('auth_login_success', 'auth', 'admin', {}, 'info', 'operator');
    res.json({ token: session.token, expiresAt: session.expiresAt });
  });

  router.post('/auth/logout', (req, res) => {
    revokeSessionToken(extractBearerToken(req));
    res.json({ ok: true });
  });

  // Protect all operational routes below
  router.use(requireAuth);

  // Authenticated System Diagnostics (BUG-19: detailed telemetry moved behind auth)
  router.get('/system/diagnostics', (_req, res) => {
    try {
      const db = getDb();
      db.prepare('SELECT 1 as ok').get();
      const resources = getResourceSnapshot();
      const encryption = getEncryptionKeyInfo();
      res.json({
        status: 'ok',
        service: 'Freelance AI Agent Hub',
        database: 'connected',
        platform: resources.platform,
        nodeVersion: resources.nodeVersion,
        workspaceDir: CONFIG.workspaceDir,
        bindHost: CONFIG.host,
        pid: process.pid,
        encryptionKey: {
          source: encryption.source,
          persistent: encryption.persistent,
          validation: encryption.validationStatus,
        },
        recentAuthFailuresCount: getRecentAuthFailures().length,
        timestamp: new Date().toISOString(),
      });
    } catch {
      res.status(503).json({ status: 'error', error: 'Diagnostics check failed' });
    }
  });

  // 3. Dashboard
  router.get('/dashboard', (_req, res) => {
    res.json(buildDashboardData());
  });

  // 4. Jobs & Import & Search & Analysis
  router.get('/jobs', (req, res) => {
    const db = getDb();
    const settings = getHubSettings();
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    const category = typeof req.query.category === 'string' ? req.query.category : '';
    const search = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const includeRejected = req.query.includeRejected !== 'false';

    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (!settings.demoMode) {
      clauses.push('is_demo = 0');
    }
    if (status && status !== 'all') {
      clauses.push('status = ?');
      params.push(status);
    }
    if (!includeRejected && status !== 'rejected') {
      clauses.push("status != 'rejected'");
    }
    if (category && category !== 'all') {
      clauses.push('category = ?');
      params.push(category);
    }
    if (search) {
      clauses.push('(title LIKE ? OR description LIKE ? OR source_name LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db
      .prepare(`SELECT * FROM jobs ${where} ORDER BY COALESCE(job_score, -1) DESC, date_imported DESC LIMIT 250`)
      .all(...params) as Array<Record<string, unknown>>;

    res.json({ jobs: rows.map(mapJobRow) });
  });

  router.get('/jobs/:id', (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id) as
      | Record<string, unknown>
      | undefined;
    if (!row) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    const proposals = listProposals(req.params.id);
    const projRow = db.prepare('SELECT * FROM projects WHERE job_id = ?').get(req.params.id) as
      | Record<string, unknown>
      | undefined;
    res.json({
      job: mapJobRow(row),
      proposals,
      project: projRow ? mapProjectRow(projRow) : null,
    });
  });

  router.patch('/jobs/:id', (req, res) => {
    const schema = z.object({
      title: z.string().min(2).max(260).optional(),
      description: z.string().min(5).max(30000).optional(),
      budget: z.number().nullable().optional(),
      currency: z.string().min(2).max(8).optional(),
      deadline: z.string().nullable().optional(),
      skills: z.array(z.string()).optional(),
      status: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid job update payload' });
      return;
    }
    const db = getDb();
    const existing = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id) as
      | Record<string, unknown>
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    const now = new Date().toISOString();
    db.prepare(`
      UPDATE jobs SET
        title = ?, description = ?, budget = ?, currency = ?, deadline = ?,
        skills_json = ?, status = ?, user_edited = 1, date_updated = ?
      WHERE id = ?
    `).run(
      String(parsed.data.title ?? existing.title),
      String(parsed.data.description ?? existing.description),
      parsed.data.budget !== undefined ? parsed.data.budget : (existing.budget as number | null),
      String(parsed.data.currency ?? existing.currency),
      parsed.data.deadline !== undefined ? parsed.data.deadline : (existing.deadline as string | null),
      parsed.data.skills ? JSON.stringify(parsed.data.skills) : String(existing.skills_json ?? '[]'),
      String(parsed.data.status ?? existing.status),
      now,
      req.params.id,
    );

    const updated = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id) as Record<string, unknown>;
    res.json({ job: mapJobRow(updated) });
  });

  router.post('/jobs/import/manual', async (req, res) => {
    const schema = z.object({
      title: z.string().min(3).max(260),
      description: z.string().min(10).max(30000),
      sourceName: z.string().min(1).max(80).default('Manual Entry'),
      jobUrl: z.string().url().optional().or(z.literal('')),
      budget: z.number().nonnegative().nullable().optional(),
      currency: z.string().max(8).default('USD'),
      paymentType: z.enum(['fixed', 'hourly', 'unknown']).default('fixed'),
      deadline: z.string().nullable().optional(),
      skills: z.array(z.string()).default([]),
      category: z.string().optional(),
      autoAnalyze: z.boolean().default(true),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid manual job input' });
      return;
    }

    try {
      const imp = importNormalizedJob({
        sourceId: 'manual',
        sourceName: parsed.data.sourceName,
        jobUrl: parsed.data.jobUrl || null,
        title: parsed.data.title,
        description: parsed.data.description,
        budget: parsed.data.budget ?? null,
        currency: parsed.data.currency,
        paymentType: parsed.data.paymentType,
        deadline: parsed.data.deadline || null,
        skills: parsed.data.skills,
        category: parsed.data.category,
      });

      const job =
        imp.imported && parsed.data.autoAnalyze
          ? await analyzeJobById(imp.jobId, false)
          : mapJobRow(getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(imp.jobId) as Record<string, unknown>);

      res.status(imp.imported ? 201 : 200).json({ ...imp, job });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Manual import failed' });
    }
  });

  router.post('/jobs/import/url', async (req, res) => {
    const schema = z.object({
      url: z.string().url(),
      platformLabel: z.string().max(80).default('Manual URL'),
      autoAnalyze: z.boolean().default(true),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Provide a valid http/https job URL' });
      return;
    }
    try {
      const imp = await importFromPublicUrl(parsed.data.url, parsed.data.platformLabel);
      const job =
        imp.imported && parsed.data.autoAnalyze
          ? await analyzeJobById(imp.jobId, false)
          : mapJobRow(getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(imp.jobId) as Record<string, unknown>);
      res.status(imp.imported ? 201 : 200).json({ ...imp, job });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'URL import failed' });
    }
  });

  router.post('/jobs/import/csv', async (req, res) => {
    const schema = z.object({ csv: z.string().min(5).max(500000), autoAnalyze: z.boolean().default(true) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Valid CSV text is required' });
      return;
    }
    const items = parseCsvJobs(parsed.data.csv);
    let imported = 0;
    let duplicates = 0;
    const importedIds: string[] = [];
    for (const item of items) {
      try {
        const r = importNormalizedJob(item);
        if (r.imported) {
          imported++;
          importedIds.push(r.jobId);
          if (parsed.data.autoAnalyze) await analyzeJobById(r.jobId, false);
        } else {
          duplicates++;
        }
      } catch {
        // skip malformed row
      }
    }
    res.json({ totalParsed: items.length, imported, duplicates, importedIds });
  });

  router.post('/jobs/import/json', async (req, res) => {
    const schema = z.object({
      jobs: z.array(
        z.object({
          title: z.string().min(2),
          description: z.string().min(5),
          sourceName: z.string().optional(),
          jobUrl: z.string().optional().nullable(),
          budget: z.number().optional().nullable(),
          currency: z.string().optional(),
          paymentType: z.enum(['fixed', 'hourly', 'unknown']).optional(),
          skills: z.array(z.string()).optional(),
          category: z.string().optional(),
          deadline: z.string().optional().nullable(),
        }),
      ),
      autoAnalyze: z.boolean().default(true),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Provide a valid JSON array under "jobs"' });
      return;
    }
    let imported = 0;
    let duplicates = 0;
    const importedIds: string[] = [];
    for (const item of parsed.data.jobs) {
      const r = importNormalizedJob({
        sourceId: 'manual',
        sourceName: item.sourceName || 'JSON Import',
        jobUrl: item.jobUrl || null,
        title: item.title,
        description: item.description,
        budget: item.budget ?? null,
        currency: item.currency || 'USD',
        paymentType: item.paymentType || 'unknown',
        skills: item.skills || [],
        category: item.category,
        deadline: item.deadline || null,
      });
      if (r.imported) {
        imported++;
        importedIds.push(r.jobId);
        if (parsed.data.autoAnalyze) await analyzeJobById(r.jobId, false);
      } else {
        duplicates++;
      }
    }
    res.json({ totalParsed: parsed.data.jobs.length, imported, duplicates, importedIds });
  });

  router.post('/jobs/:id/analyze', async (req, res) => {
    try {
      const useAi = req.body?.useAi !== false;
      const job = await analyzeJobById(req.params.id, useAi);
      res.json({ job });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Analysis failed' });
    }
  });

  router.post('/jobs/:id/override-rejection', async (req, res) => {
    const db = getDb();
    const existing = db.prepare('SELECT id FROM jobs WHERE id = ?').get(req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    db.prepare('UPDATE jobs SET override_rejected = 1, rejection_reason = NULL, date_updated = ? WHERE id = ?').run(
      new Date().toISOString(),
      req.params.id,
    );
    logAudit('job_rejection_overridden', 'job', req.params.id, {});
    const reanalyzed = await analyzeJobById(req.params.id, false);
    res.json({ job: reanalyzed });
  });

  router.post('/jobs/search', async (req, res) => {
    const schema = z.object({
      sourceId: z.string().optional(),
      query: z.string().max(120).default(''),
      limit: z.number().int().min(1).max(40).optional(),
    });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid search parameters' });
      return;
    }

    const targets = parsed.data.sourceId
      ? [parsed.data.sourceId]
      : listSources()
          .filter((s) => s.enabled && s.implementationStatus === 'functional' && s.connectorType === 'public_api')
          .map((s) => s.id);

    const results = [];
    const settings = getHubSettings();
    for (const sid of targets) {
      const r = await runSourceSearch(sid, parsed.data.query, parsed.data.limit);
      if (settings.scheduler.autoAnalyzeImported) {
        for (const jid of r.importedJobIds) {
          await analyzeJobById(jid, false);
        }
      }
      results.push(r);
    }

    res.json({ results });
  });

  // 5. Sources & Connectors
  router.get('/sources', (_req, res) => {
    const db = getDb();
    const history = db
      .prepare('SELECT * FROM search_history ORDER BY started_at DESC LIMIT 30')
      .all();
    res.json({ sources: listSources(), searchHistory: history });
  });

  router.patch('/sources/:id', (req, res) => {
    const schema = z.object({
      enabled: z.boolean().optional(),
      rateLimitPerHour: z.number().int().min(1).max(1000).optional(),
      searchFrequencyMinutes: z.number().int().min(5).max(1440).optional(),
      browserAutomationAllowed: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid source update' });
      return;
    }
    try {
      const updated = updateSourceConfig(req.params.id, parsed.data);
      res.json({ source: updated });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : 'Source update failed' });
    }
  });

  router.post('/sources/:id/search', async (req, res) => {
    const query = typeof req.body?.query === 'string' ? req.body.query : '';
    const limit = typeof req.body?.limit === 'number' ? req.body.limit : undefined;
    try {
      const result = await runSourceSearch(req.params.id, query, limit);
      const settings = getHubSettings();
      if (settings.scheduler.autoAnalyzeImported) {
        for (const jid of result.importedJobIds) {
          await analyzeJobById(jid, false);
        }
      }
      res.json({ result });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Search failed' });
    }
  });

  // 6. Proposals
  router.get('/proposals', (req, res) => {
    const jobId = typeof req.query.jobId === 'string' ? req.query.jobId : undefined;
    res.json({ proposals: listProposals(jobId) });
  });

  router.post('/proposals/generate', async (req, res) => {
    const schema = z.object({
      jobId: z.string().min(1),
      customNotes: z.string().max(2000).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'jobId is required' });
      return;
    }
    try {
      const proposal = await generateProposalForJob(parsed.data.jobId, parsed.data.customNotes || '');
      res.status(201).json({ proposal });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Proposal generation failed' });
    }
  });

  router.patch('/proposals/:id', (req, res) => {
    const schema = z.object({
      introduction: z.string().optional(),
      fullProposal: z.string().optional(),
      approach: z.string().optional(),
      timeline: z.string().optional(),
      questions: z.array(z.string()).optional(),
      suggestedBid: z.number().nonnegative().optional(),
      pricingExplanation: z.string().optional(),
      status: z.enum(['draft', 'reviewed', 'submitted_manually', 'awarded', 'archived']).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid proposal update' });
      return;
    }
    try {
      const proposal = updateProposal(req.params.id, parsed.data);
      res.json({ proposal });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : 'Proposal not found' });
    }
  });

  // 7. Agents, Tools & Task Queue
  router.get('/agents', (_req, res) => {
    const db = getDb();
    const counts = db
      .prepare(
        `SELECT agent_type,
                SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running,
                SUM(CASE WHEN status IN ('queued','pending') THEN 1 ELSE 0 END) as queued,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
         FROM agent_tasks GROUP BY agent_type`,
      )
      .all() as Array<Record<string, unknown>>;

    const map = new Map(counts.map((c) => [String(c.agent_type), c]));
    const agents = AGENT_ROSTER.map((a) => {
      const st = map.get(a.id);
      return {
        ...a,
        running: Number(st?.running || 0),
        queued: Number(st?.queued || 0),
        completed: Number(st?.completed || 0),
        failed: Number(st?.failed || 0),
        status: Number(st?.running || 0) > 0 ? 'running' : Number(st?.queued || 0) > 0 ? 'queued' : 'idle',
      };
    });

    res.json({
      agents,
      tools: Object.values(TOOL_REGISTRY),
      resources: getResourceSnapshot(),
    });
  });

  router.get('/tasks', (req, res) => {
    const db = getDb();
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    const rows =
      status && status !== 'all'
        ? (db.prepare('SELECT * FROM agent_tasks WHERE status = ? ORDER BY created_at DESC LIMIT 150').all(status) as Array<Record<string, unknown>>)
        : (db.prepare('SELECT * FROM agent_tasks ORDER BY created_at DESC LIMIT 150').all() as Array<Record<string, unknown>>);
    res.json({ tasks: rows.map(mapAgentTaskRow) });
  });

  router.get('/tasks/:id/logs', (req, res) => {
    const db = getDb();
    const logs = db
      .prepare('SELECT * FROM task_logs WHERE task_id = ? ORDER BY created_at ASC')
      .all(req.params.id);
    res.json({ logs });
  });

  router.post('/tasks/:id/cancel', (req, res) => {
    try {
      res.json({ task: cancelTask(req.params.id) });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : 'Cancel failed' });
    }
  });

  router.post('/tasks/:id/pause', (req, res) => {
    try {
      res.json({ task: pauseTask(req.params.id) });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : 'Pause failed' });
    }
  });

  router.post('/tasks/:id/resume', (req, res) => {
    try {
      res.json({ task: resumeTask(req.params.id) });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : 'Resume failed' });
    }
  });

  // 8. Projects, Workspaces, Deliverables, QA & Submission Center
  router.get('/projects', (_req, res) => {
    const db = getDb();
    const settings = getHubSettings();
    const where = settings.demoMode ? '' : 'WHERE p.is_demo = 0';
    const rows = db
      .prepare(
        `SELECT p.*, j.source_name, j.job_url, j.budget, j.currency, j.client_info_json
         FROM projects p
         JOIN jobs j ON j.id = p.job_id
         ${where}
         ORDER BY p.updated_at DESC`,
      )
      .all() as Array<Record<string, unknown>>;
    res.json({ projects: rows.map(mapProjectRow) });
  });

  router.post('/projects/approve', (req, res) => {
    const schema = z.object({
      jobId: z.string().min(1),
      proposalId: z.string().nullable().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'jobId is required to approve a project' });
      return;
    }
    try {
      const result = approveJobIntoProject(parsed.data.jobId, parsed.data.proposalId);
      res.status(result.alreadyExists ? 200 : 201).json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Approval failed' });
    }
  });

  router.get('/projects/:id', (req, res) => {
    const db = getDb();
    const row = db
      .prepare(
        `SELECT p.*, j.source_name, j.job_url, j.budget, j.currency, j.client_info_json
         FROM projects p JOIN jobs j ON j.id = p.job_id WHERE p.id = ?`,
      )
      .get(req.params.id) as Record<string, unknown> | undefined;
    if (!row) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    const jobRow = db.prepare('SELECT * FROM jobs WHERE id = ?').get(String(row.job_id)) as Record<string, unknown>;
    const agentTasks = db
      .prepare('SELECT * FROM agent_tasks WHERE project_id = ? ORDER BY created_at DESC LIMIT 20')
      .all(req.params.id) as Array<Record<string, unknown>>;

    res.json({
      project: mapProjectRow(row),
      job: mapJobRow(jobRow),
      subtasks: listProjectTasks(req.params.id),
      agentTasks: agentTasks.map(mapAgentTaskRow),
      deliverables: listProjectDeliverables(req.params.id),
      files: listWorkspaceTree(req.params.id),
      qaReports: listQaReports(req.params.id),
    });
  });

  router.post('/projects/:id/re-execute', (req, res) => {
    const db = getDb();
    const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as
      | Record<string, unknown>
      | undefined;
    if (!proj) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    const enq = enqueueTask({
      taskType: 'execute_project',
      agentType: 'execution_agent',
      projectId: req.params.id,
      jobId: String(proj.job_id),
      dedupeKey: `project_exec:${req.params.id}`,
      priority: 2,
    });
    res.json(enq);
  });

  router.get('/projects/:id/preview', (req, res) => {
    const rel = typeof req.query.path === 'string' ? req.query.path : '';
    if (!rel) {
      res.status(400).json({ error: 'path query parameter is required' });
      return;
    }
    try {
      res.json(previewWorkspaceFile(req.params.id, rel));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Preview failed' });
    }
  });

  router.get('/projects/:id/download', (req, res) => {
    const rel = typeof req.query.path === 'string' ? req.query.path : '';
    if (!rel) {
      res.status(400).json({ error: 'path query parameter is required' });
      return;
    }
    try {
      // BUG-03: Race-safe O_NOFOLLOW + realpath symlink-free read
      const fileData = readSafeWorkspaceFile(req.params.id, rel);
      const safeDownloadName = sanitizePathSegment(path.basename(fileData.absolutePath));
      res.setHeader('Content-Disposition', `attachment; filename="${safeDownloadName}"`);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(fileData.buffer);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') {
        res.status(404).json({ error: 'File not found in workspace' });
        return;
      }
      res.status(400).json({ error: err instanceof Error ? err.message : 'Download blocked' });
    }
  });

  router.post('/projects/:id/package-zip', async (req, res) => {
    try {
      const zip = await packageProjectDeliverablesZip(req.params.id);
      res.json({ deliverable: zip });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'ZIP packaging failed' });
    }
  });

  router.post('/projects/:id/qa', (req, res) => {
    try {
      const existingReports = listQaReports(req.params.id);
      const report = evaluateProjectQa(req.params.id, existingReports.length + 1);
      res.json({ report });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'QA evaluation failed' });
    }
  });

  router.patch('/projects/:id/submission-message', (req, res) => {
    const schema = z.object({ submissionMessage: z.string().min(5).max(12000) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Valid submission message is required' });
      return;
    }
    const db = getDb();
    const existing = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
    if (!existing) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    writeWorkspaceTextFile(req.params.id, 'submission_message.md', parsed.data.submissionMessage, false);
    db.prepare('UPDATE projects SET submission_message = ?, updated_at = ? WHERE id = ?').run(
      parsed.data.submissionMessage,
      new Date().toISOString(),
      req.params.id,
    );
    res.json({ ok: true });
  });

  router.post('/projects/:id/submit', (req, res) => {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as
      | Record<string, unknown>
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    const submittedAt = typeof req.body?.submittedAt === 'string' ? req.body.submittedAt : new Date().toISOString();
    const now = new Date().toISOString();
    db.prepare(`UPDATE projects SET status = 'submitted', submitted_at = ?, updated_at = ? WHERE id = ?`).run(
      submittedAt,
      now,
      req.params.id,
    );
    db.prepare(`UPDATE jobs SET status = 'submitted', date_updated = ? WHERE id = ?`).run(now, String(existing.job_id));
    logAudit('project_marked_submitted_manually', 'project', req.params.id, { submittedAt });
    res.json({ ok: true, submittedAt });
  });

  router.post('/projects/:id/payment', (req, res) => {
    const schema = z.object({
      amount: z.number().positive(),
      currency: z.string().min(2).max(8).default('USD'),
      platformFee: z.number().nonnegative().default(0),
      paidAt: z.string().optional(),
      notes: z.string().max(1000).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid payment payload' });
      return;
    }
    try {
      const payment = recordProjectPayment({
        projectId: req.params.id,
        ...parsed.data,
      });
      res.status(201).json({ payment });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Payment recording failed' });
    }
  });

  // 9. QA Reports & Submission Center aggregate endpoints
  router.get('/qa', (_req, res) => {
    res.json({ reports: listQaReports() });
  });

  router.get('/submissions', (_req, res) => {
    const db = getDb();
    const settings = getHubSettings();
    const demoClause = settings.demoMode ? '' : 'AND p.is_demo = 0';
    const rows = db
      .prepare(
        `SELECT p.*, j.source_name, j.job_url, j.budget, j.currency, j.client_info_json
         FROM projects p
         JOIN jobs j ON j.id = p.job_id
         WHERE p.status IN ('ready_for_submission', 'needs_review', 'submitted', 'paid') ${demoClause}
         ORDER BY p.updated_at DESC`,
      )
      .all() as Array<Record<string, unknown>>;

    const submissions = rows.map((r) => {
      const proj = mapProjectRow(r);
      return {
        ...proj,
        deliverables: listProjectDeliverables(proj.id),
        latestQa: listQaReports(proj.id)[0] || null,
      };
    });
    res.json({ submissions });
  });

  // 10. Earnings & Analytics
  router.get('/analytics', (_req, res) => {
    res.json(buildAnalyticsReport());
  });

  // 11. Notifications
  router.get('/notifications', (_req, res) => {
    const db = getDb();
    const rows = db
      .prepare('SELECT * FROM notifications ORDER BY created_at DESC LIMIT 60')
      .all() as Array<Record<string, unknown>>;
    res.json({
      notifications: rows.map((r) => ({
        id: String(r.id),
        type: String(r.type),
        title: String(r.title),
        message: String(r.message),
        severity: r.severity,
        read: Boolean(r.read),
        relatedEntityType: r.related_entity_type ? String(r.related_entity_type) : null,
        relatedEntityId: r.related_entity_id ? String(r.related_entity_id) : null,
        createdAt: String(r.created_at),
      })),
    });
  });

  router.post('/notifications/read-all', (_req, res) => {
    getDb().prepare('UPDATE notifications SET read = 1 WHERE read = 0').run();
    res.json({ ok: true });
  });

  router.post('/notifications/:id/read', (req, res) => {
    getDb().prepare('UPDATE notifications SET read = 1 WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  // 12. AI Providers & Model Routing
  router.get('/ai-providers', (_req, res) => {
    res.json({ providers: listAiProviders() });
  });

  router.put('/ai-providers/:id', (req, res) => {
    const schema = z.object({
      name: z.string().min(1).max(120),
      providerType: z.enum(['ollama', 'openai_compatible', 'freellmapi', 'gemini']),
      apiUrl: z.string().url(),
      apiKey: z.string().max(400).optional(),
      model: z.string().min(1).max(120),
      contextLimit: z.number().int().min(1024).max(2000000).default(8192),
      timeoutMs: z.number().int().min(3000).max(300000).default(60000),
      priority: z.number().int().min(1).max(20).default(1),
      role: z.enum(['primary', 'fallback', 'specialized']).default('fallback'),
      enabled: z.boolean(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid provider configuration' });
      return;
    }
    try {
      const provider = upsertAiProvider({ id: req.params.id, ...parsed.data });
      res.json({ provider });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to update AI provider' });
    }
  });

  router.post('/ai-providers/:id/health', async (req, res) => {
    try {
      const result = await checkProviderHealth(req.params.id);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Health check failed' });
    }
  });

  router.post('/ai-providers/:id/test', async (req, res) => {
    try {
      const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt : undefined;
      const result = await testProviderCompletion(req.params.id, prompt);
      res.json({ ok: true, result });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : 'Model test failed' });
    }
  });

  // 13. Settings, Config Export/Import (NO plaintext secrets!), Demo Mode, Backups
  router.get('/settings', (_req, res) => {
    res.json({ settings: getHubSettings() });
  });

  router.put('/settings', (req, res) => {
    const incoming = req.body?.settings as Partial<HubSettings> | undefined;
    if (!incoming || typeof incoming !== 'object') {
      res.status(400).json({ error: 'settings object is required' });
      return;
    }
    const current = getHubSettings();
    const merged: HubSettings = {
      ...current,
      ...incoming,
      scoreWeights: { ...current.scoreWeights, ...(incoming.scoreWeights || {}) },
      filters: { ...current.filters, ...(incoming.filters || {}) },
      resourceLimits: { ...current.resourceLimits, ...(incoming.resourceLimits || {}) },
      scheduler: { ...current.scheduler, ...(incoming.scheduler || {}) },
      notifications: { ...current.notifications, ...(incoming.notifications || {}) },
      workspaceLocation: CONFIG.workspaceDir, // Workspace location controlled via server env for path safety
      demoMode: current.demoMode,
    };
    saveHubSettings(merged);
    logAudit('settings_updated', 'settings', 'hub_settings', {});
    res.json({ settings: merged });
  });

  router.get('/settings/export', (_req, res) => {
    const sanitizedProviders = listAiProviders().map((p) => ({
      id: p.id,
      name: p.name,
      providerType: p.providerType,
      apiUrl: p.apiUrl,
      model: p.model,
      contextLimit: p.contextLimit,
      timeoutMs: p.timeoutMs,
      priority: p.priority,
      role: p.role,
      enabled: p.enabled,
      // Explicitly omit API keys — never export credentials in plaintext
    }));
    res.json({
      exportedAt: new Date().toISOString(),
      note: 'Credentials and API keys are strictly omitted from exported configuration.',
      settings: getHubSettings(),
      sources: listSources().map((s) => ({
        id: s.id,
        enabled: s.enabled,
        rateLimitPerHour: s.rateLimitPerHour,
        searchFrequencyMinutes: s.searchFrequencyMinutes,
      })),
      aiProviders: sanitizedProviders,
    });
  });

  router.post('/settings/import', (req, res) => {
    const payload = req.body as { settings?: Partial<HubSettings> };
    if (!payload?.settings || typeof payload.settings !== 'object') {
      res.status(400).json({ error: 'Invalid configuration bundle' });
      return;
    }
    const current = getHubSettings();
    const merged: HubSettings = {
      ...current,
      ...payload.settings,
      scoreWeights: { ...current.scoreWeights, ...(payload.settings.scoreWeights || {}) },
      filters: { ...current.filters, ...(payload.settings.filters || {}) },
      resourceLimits: { ...current.resourceLimits, ...(payload.settings.resourceLimits || {}) },
      scheduler: { ...current.scheduler, ...(payload.settings.scheduler || {}) },
      notifications: { ...current.notifications, ...(payload.settings.notifications || {}) },
      workspaceLocation: CONFIG.workspaceDir,
    };
    saveHubSettings(merged);
    logAudit('settings_imported', 'settings', 'hub_settings', {});
    res.json({ settings: merged });
  });

  router.post('/settings/demo-mode', async (req, res) => {
    const enabled = Boolean(req.body?.enabled);
    try {
      const result = await toggleDemoMode(enabled);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Demo mode toggle failed' });
    }
  });

  router.post('/backup/create', (_req, res) => {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const targetDir = path.join(CONFIG.backupsDir, `backup_${stamp}`);
      fs.mkdirSync(targetDir, { recursive: true });
      if (CONFIG.dbPath !== ':memory:' && fs.existsSync(CONFIG.dbPath)) {
        fs.copyFileSync(CONFIG.dbPath, path.join(targetDir, 'hub.db'));
      }
      fs.writeFileSync(
        path.join(targetDir, 'settings_sanitized.json'),
        JSON.stringify({ exportedAt: new Date().toISOString(), settings: getHubSettings() }, null, 2),
      );
      logAudit('backup_created', 'system', targetDir, {});
      res.json({ ok: true, backupPath: targetDir, createdAt: new Date().toISOString() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Backup creation failed' });
    }
  });

  // 14. Resource Monitor & Scheduler Controls
  router.get('/resources', (_req, res) => {
    res.json({ resources: getResourceSnapshot() });
  });

  router.post('/scheduler/pause', (_req, res) => {
    setSchedulerPaused(true);
    logAudit('scheduler_paused', 'scheduler', 'main', {});
    res.json({ resources: getResourceSnapshot() });
  });

  router.post('/scheduler/resume', (_req, res) => {
    setSchedulerPaused(false);
    logAudit('scheduler_resumed', 'scheduler', 'main', {});
    res.json({ resources: getResourceSnapshot() });
  });

  // 15. Browser Automation Sessions (Policy-restricted)
  router.get('/browser-sessions', (_req, res) => {
    res.json({ sessions: listBrowserSessions() });
  });

  router.post('/browser-sessions/inspect', async (req, res) => {
    const schema = z.object({ connectorId: z.string().min(1), url: z.string().url() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Valid connectorId and url are required' });
      return;
    }
    try {
      const session = await inspectPermittedPage(parsed.data.connectorId, parsed.data.url);
      res.json({ session });
    } catch (err) {
      res.status(403).json({ error: err instanceof Error ? err.message : 'Inspection blocked by policy' });
    }
  });

  router.post('/browser-sessions/:id/resume', (req, res) => {
    try {
      res.json({ session: resumeBrowserSessionAfterManualVerification(req.params.id) });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : 'Session not found' });
    }
  });

  // 16. Audit Logs
  router.get('/audit-logs', (_req, res) => {
    const db = getDb();
    const logs = db
      .prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 120')
      .all() as Array<Record<string, unknown>>;
    res.json({
      logs: logs.map((l) => ({
        id: String(l.id),
        action: String(l.action),
        actor: String(l.actor),
        resourceType: String(l.resource_type),
        resourceId: l.resource_id ? String(l.resource_id) : null,
        severity: String(l.severity),
        details: JSON.parse(String(l.details_json || '{}')),
        createdAt: String(l.created_at),
      })),
    });
  });

  return router;
}
