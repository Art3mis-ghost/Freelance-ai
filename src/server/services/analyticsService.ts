import crypto from 'node:crypto';
import fs from 'node:fs';
import { getDb, getHubSettings, logAudit, saveHubSettings } from '../db/database.ts';
import { getProjectWorkspaceRoot } from '../security.ts';
import { importNormalizedJob } from './connectors.ts';
import { analyzeJobById } from './jobAnalyst.ts';
import { generateProposalForJob } from './proposalService.ts';
import { getResourceSnapshot } from './resourceMonitor.ts';
import { approveJobIntoProject, runProjectExecutionPipeline } from './taskQueue.ts';
import type { DashboardData, PaymentRecord } from '../../shared/types.ts';

export function buildDashboardData(): DashboardData {
  const db = getDb();
  const settings = getHubSettings();
  const demoFilter = settings.demoMode ? '' : 'AND is_demo = 0';
  const demoFilterWhere = settings.demoMode ? 'WHERE 1=1' : 'WHERE is_demo = 0';

  const jobStats = db
    .prepare(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) as new_cnt,
        SUM(CASE WHEN status != 'rejected' AND status != 'expired' AND (job_score IS NULL OR job_score >= 55) THEN 1 ELSE 0 END) as suitable_cnt,
        SUM(CASE WHEN job_score >= 75 AND status != 'rejected' THEN 1 ELSE 0 END) as high_match_cnt,
        SUM(CASE WHEN status IN ('shortlisted', 'proposal_drafted', 'proposal_submitted', 'awaiting_approval') THEN 1 ELSE 0 END) as awaiting_approval_cnt
       FROM jobs ${demoFilterWhere}`,
    )
    .get() as Record<string, number | null>;

  const projStats = db
    .prepare(
      `SELECT
        SUM(CASE WHEN status IN ('planning', 'executing', 'qa_running', 'correcting') THEN 1 ELSE 0 END) as active_cnt,
        SUM(CASE WHEN status IN ('ready_for_submission', 'needs_review') THEN 1 ELSE 0 END) as ready_cnt,
        COALESCE(SUM(CASE WHEN status NOT IN ('cancelled', 'failed') THEN COALESCE(estimated_earnings, 0) ELSE 0 END), 0) as est_earnings
       FROM projects ${demoFilterWhere}`,
    )
    .get() as Record<string, number | null>;

  const taskStats = db
    .prepare(
      `SELECT
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running_cnt,
        SUM(CASE WHEN status IN ('queued', 'pending') THEN 1 ELSE 0 END) as queued_cnt,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_cnt,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_cnt
       FROM agent_tasks`,
    )
    .get() as Record<string, number | null>;

  const payStats = db
    .prepare(
      `SELECT
        COUNT(*) as pay_cnt,
        COALESCE(SUM(amount), 0) as actual_paid,
        COALESCE(SUM(net_amount), 0) as net_paid
       FROM payments ${demoFilterWhere}`,
    )
    .get() as Record<string, number | null>;

  // Charts
  const discoveryRows = db
    .prepare(
      `SELECT substr(date_discovered, 1, 10) as d,
              COUNT(*) as discovered,
              SUM(CASE WHEN status IN ('shortlisted', 'proposal_drafted', 'approved', 'in_progress', 'ready_for_submission', 'submitted', 'paid') THEN 1 ELSE 0 END) as shortlisted
       FROM jobs ${demoFilterWhere}
       GROUP BY d ORDER BY d ASC LIMIT 14`,
    )
    .all() as Array<{ d: string; discovered: number; shortlisted: number }>;

  const platformRows = db
    .prepare(
      `SELECT source_name as platform, COUNT(*) as count
       FROM jobs ${demoFilterWhere}
       GROUP BY source_name ORDER BY count DESC LIMIT 8`,
    )
    .all() as Array<{ platform: string; count: number }>;

  const categoryRows = db
    .prepare(
      `SELECT category, COUNT(*) as count
       FROM jobs ${demoFilterWhere}
       GROUP BY category ORDER BY count DESC LIMIT 8`,
    )
    .all() as Array<{ category: string; count: number }>;

  const scoreBuckets = db
    .prepare(
      `SELECT
        CASE
          WHEN job_score >= 85 THEN '85-100'
          WHEN job_score >= 70 THEN '70-84'
          WHEN job_score >= 55 THEN '55-69'
          WHEN job_score >= 35 THEN '35-54'
          ELSE '0-34'
        END as bucket,
        COUNT(*) as count
       FROM jobs WHERE job_score IS NOT NULL ${demoFilter}
       GROUP BY bucket`,
    )
    .all() as Array<{ bucket: string; count: number }>;

  const projectStatusRows = db
    .prepare(
      `SELECT status, COUNT(*) as count FROM projects ${demoFilterWhere} GROUP BY status`,
    )
    .all() as Array<{ status: string; count: number }>;

  const earningsMonthMap = new Map<string, { month: string; estimated: number; actualPaid: number; netPaid: number }>();
  const projMonthly = db
    .prepare(
      `SELECT substr(created_at, 1, 7) as m, COALESCE(SUM(estimated_earnings), 0) as est
       FROM projects WHERE status NOT IN ('cancelled', 'failed') ${demoFilter}
       GROUP BY m`,
    )
    .all() as Array<{ m: string; est: number }>;
  for (const r of projMonthly) {
    earningsMonthMap.set(r.m, { month: r.m, estimated: Number(r.est || 0), actualPaid: 0, netPaid: 0 });
  }
  const payMonthly = db
    .prepare(
      `SELECT substr(paid_at, 1, 7) as m, COALESCE(SUM(amount), 0) as paid, COALESCE(SUM(net_amount), 0) as net
       FROM payments ${demoFilterWhere}
       GROUP BY m`,
    )
    .all() as Array<{ m: string; paid: number; net: number }>;
  for (const r of payMonthly) {
    const existing = earningsMonthMap.get(r.m) || { month: r.m, estimated: 0, actualPaid: 0, netPaid: 0 };
    existing.actualPaid = Number(r.paid || 0);
    existing.netPaid = Number(r.net || 0);
    earningsMonthMap.set(r.m, existing);
  }
  const earningsHistory = Array.from(earningsMonthMap.values()).sort((a, b) => a.month.localeCompare(b.month));

  const agentPerf = db
    .prepare(
      `SELECT agent_type as agent,
              SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
       FROM agent_tasks
       GROUP BY agent_type ORDER BY completed DESC LIMIT 10`,
    )
    .all() as Array<{ agent: string; completed: number; failed: number }>;

  const activityRows = db
    .prepare(
      `SELECT id, action, resource_type, details_json, severity, created_at
       FROM audit_logs ORDER BY created_at DESC LIMIT 20`,
    )
    .all() as Array<Record<string, unknown>>;

  const activityFeed = activityRows.map((a) => {
    let detail = '';
    try {
      const parsed = JSON.parse(String(a.details_json || '{}')) as Record<string, unknown>;
      detail = Object.entries(parsed)
        .slice(0, 3)
        .map(([k, v]) => `${k}: ${String(v)}`)
        .join(' · ');
    } catch {
      detail = '';
    }
    return {
      id: String(a.id),
      category: String(a.resource_type),
      title: String(a.action).replace(/_/g, ' '),
      detail,
      severity: String(a.severity || 'info'),
      createdAt: String(a.created_at),
    };
  });

  const platformStats = db
    .prepare(
      `SELECT
        COUNT(*) as total_platforms,
        SUM(CASE WHEN enabled = 1 AND status = 'connected' THEN 1 ELSE 0 END) as connected_platforms
       FROM platform_accounts`,
    )
    .get() as Record<string, number | null>;

  const approvalStats = db
    .prepare(`SELECT COUNT(*) as pending_approvals FROM approvals WHERE status = 'pending'`)
    .get() as Record<string, number | null>;

  const deliveryStats = db
    .prepare(
      `SELECT
        SUM(CASE WHEN status IN ('preparing', 'qa_pending', 'ready_for_delivery', 'awaiting_approval', 'delivery_in_progress', 'needs_manual_action') THEN 1 ELSE 0 END) as in_progress,
        SUM(CASE WHEN status IN ('submitted', 'delivered') THEN 1 ELSE 0 END) as submitted
       FROM delivery_records`,
    )
    .get() as Record<string, number | null>;

  const providerStats = db
    .prepare(
      `SELECT
        COUNT(*) as total_providers,
        SUM(CASE WHEN enabled = 1 AND last_status = 'online' THEN 1 ELSE 0 END) as online_providers
       FROM ai_providers`,
    )
    .get() as Record<string, number | null>;

  return {
    demoMode: settings.demoMode,
    kpis: {
      totalJobsDiscovered: Number(jobStats?.total || 0),
      newJobs: Number(jobStats?.new_cnt || 0),
      suitableJobs: Number(jobStats?.suitable_cnt || 0),
      highMatchJobs: Number(jobStats?.high_match_cnt || 0),
      jobsAwaitingApproval: Number(jobStats?.awaiting_approval_cnt || 0),
      activeProjects: Number(projStats?.active_cnt || 0),
      agentsRunning: Number(taskStats?.running_cnt || 0),
      agentsQueued: Number(taskStats?.queued_cnt || 0),
      tasksCompleted: Number(taskStats?.completed_cnt || 0),
      tasksFailed: Number(taskStats?.failed_cnt || 0),
      jobsReadyForSubmission: Number(projStats?.ready_cnt || 0),
      earningsRecordedCount: Number(payStats?.pay_cnt || 0),
      estimatedPotentialEarnings: Number(projStats?.est_earnings || 0),
      actualPaidEarnings: Number(payStats?.actual_paid || 0),
      netPaidEarnings: Number(payStats?.net_paid || 0),
      connectedPlatforms: Number(platformStats?.connected_platforms || 0),
      totalPlatforms: Number(platformStats?.total_platforms || 0),
      pendingApprovals: Number(approvalStats?.pending_approvals || 0),
      deliveriesInProgress: Number(deliveryStats?.in_progress || 0),
      deliveriesSubmitted: Number(deliveryStats?.submitted || 0),
      onlineProviders: Number(providerStats?.online_providers || 0),
      totalProviders: Number(providerStats?.total_providers || 0),
      autonomyLevel: settings.autonomy.level,
    },
    charts: {
      discoveryOverTime: discoveryRows.map((r) => ({
        date: r.d,
        discovered: Number(r.discovered || 0),
        shortlisted: Number(r.shortlisted || 0),
      })),
      jobsByPlatform: platformRows.map((r) => ({ platform: r.platform, count: Number(r.count || 0) })),
      jobsByCategory: categoryRows.map((r) => ({ category: r.category, count: Number(r.count || 0) })),
      matchScoreDistribution: scoreBuckets.map((r) => ({ bucket: r.bucket, count: Number(r.count || 0) })),
      projectStatusBreakdown: projectStatusRows.map((r) => ({ status: r.status, count: Number(r.count || 0) })),
      earningsHistory,
      agentPerformance: agentPerf.map((r) => ({
        agent: r.agent,
        completed: Number(r.completed || 0),
        failed: Number(r.failed || 0),
      })),
    },
    activityFeed,
    resources: getResourceSnapshot(),
  };
}

export function buildAnalyticsReport() {
  const db = getDb();
  const settings = getHubSettings();
  const demoWhere = settings.demoMode ? 'WHERE 1=1' : 'WHERE is_demo = 0';
  const demoAnd = settings.demoMode ? '' : 'AND j.is_demo = 0';

  const funnel = db
    .prepare(
      `SELECT
        COUNT(*) as discovered,
        SUM(CASE WHEN date_analyzed IS NOT NULL THEN 1 ELSE 0 END) as analyzed,
        SUM(CASE WHEN status IN ('shortlisted','proposal_drafted','proposal_submitted','approved','in_progress','qa_review','ready_for_submission','submitted','paid') THEN 1 ELSE 0 END) as shortlisted,
        SUM(CASE WHEN status IN ('approved','in_progress','qa_review','ready_for_submission','submitted','paid') THEN 1 ELSE 0 END) as contracts_awarded,
        SUM(CASE WHEN status IN ('ready_for_submission','submitted','paid') THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status IN ('submitted','paid') THEN 1 ELSE 0 END) as submitted,
        SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) as paid
       FROM jobs ${demoWhere}`,
    )
    .get() as Record<string, number | null>;

  const proposalCounts = db
    .prepare(
      `SELECT
        COUNT(*) as drafted,
        SUM(CASE WHEN p.status IN ('submitted_manually', 'awarded') THEN 1 ELSE 0 END) as submitted_manually
       FROM proposals p JOIN jobs j ON j.id = p.job_id WHERE 1=1 ${demoAnd}`,
    )
    .get() as Record<string, number | null>;

  const paymentSummary = db
    .prepare(
      `SELECT
        COALESCE(SUM(amount), 0) as actual_earnings,
        COALESCE(SUM(platform_fee), 0) as platform_fees,
        COALESCE(SUM(net_amount), 0) as net_earnings
       FROM payments ${demoWhere}`,
    )
    .get() as Record<string, number | null>;

  const estimatedEarnings = (
    db
      .prepare(
        `SELECT COALESCE(SUM(estimated_earnings), 0) as est FROM projects WHERE status NOT IN ('cancelled','failed') ${settings.demoMode ? '' : 'AND is_demo = 0'}`,
      )
      .get() as { est: number }
  ).est;

  const byPlatform = db
    .prepare(
      `SELECT j.source_name as platform,
              COUNT(DISTINCT j.id) as jobs,
              COALESCE(SUM(pay.amount), 0) as actualPaid,
              COALESCE(SUM(pay.net_amount), 0) as netPaid
       FROM jobs j
       LEFT JOIN payments pay ON pay.job_id = j.id
       WHERE 1=1 ${demoAnd}
       GROUP BY j.source_name ORDER BY actualPaid DESC, jobs DESC`,
    )
    .all() as Array<{ platform: string; jobs: number; actualPaid: number; netPaid: number }>;

  const byCategory = db
    .prepare(
      `SELECT j.category as category,
              COUNT(DISTINCT j.id) as jobs,
              COALESCE(SUM(pay.amount), 0) as actualPaid,
              COALESCE(SUM(pay.net_amount), 0) as netPaid
       FROM jobs j
       LEFT JOIN payments pay ON pay.job_id = j.id
       WHERE 1=1 ${demoAnd}
       GROUP BY j.category ORDER BY actualPaid DESC, jobs DESC`,
    )
    .all() as Array<{ category: string; jobs: number; actualPaid: number; netPaid: number }>;

  const payments = db
    .prepare(
      `SELECT pay.*, p.title as project_title, j.source_name, j.category
       FROM payments pay
       JOIN projects p ON p.id = pay.project_id
       JOIN jobs j ON j.id = pay.job_id
       WHERE 1=1 ${settings.demoMode ? '' : 'AND pay.is_demo = 0'}
       ORDER BY pay.paid_at DESC`,
    )
    .all() as Array<Record<string, unknown>>;

  const mappedPayments: PaymentRecord[] = payments.map((r) => ({
    id: String(r.id),
    projectId: String(r.project_id),
    jobId: String(r.job_id),
    projectTitle: String(r.project_title || ''),
    sourceName: String(r.source_name || ''),
    category: String(r.category || ''),
    amount: Number(r.amount || 0),
    currency: String(r.currency || 'USD'),
    platformFee: Number(r.platform_fee || 0),
    netAmount: Number(r.net_amount || 0),
    paidAt: String(r.paid_at),
    notes: r.notes ? String(r.notes) : null,
    isDemo: Boolean(r.is_demo),
    createdAt: String(r.created_at),
  }));

  return {
    demoMode: settings.demoMode,
    funnel: {
      jobsDiscovered: Number(funnel?.discovered || 0),
      jobsAnalyzed: Number(funnel?.analyzed || 0),
      jobsShortlisted: Number(funnel?.shortlisted || 0),
      proposalsDrafted: Number(proposalCounts?.drafted || 0),
      proposalsSubmittedManually: Number(proposalCounts?.submitted_manually || 0),
      contractsAwarded: Number(funnel?.contracts_awarded || 0),
      projectsCompleted: Number(funnel?.completed || 0),
      jobsSubmitted: Number(funnel?.submitted || 0),
      jobsPaid: Number(funnel?.paid || 0),
    },
    financials: {
      estimatedPotentialEarnings: Number(estimatedEarnings || 0),
      actualPaidEarnings: Number(paymentSummary?.actual_earnings || 0),
      platformFees: Number(paymentSummary?.platform_fees || 0),
      netEarnings: Number(paymentSummary?.net_earnings || 0),
    },
    byPlatform,
    byCategory,
    payments: mappedPayments,
  };
}

export function recordProjectPayment(input: {
  projectId: string;
  amount: number;
  currency: string;
  platformFee: number;
  paidAt?: string;
  notes?: string;
}): PaymentRecord {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(input.projectId) as
    | Record<string, unknown>
    | undefined;
  if (!project) throw new Error(`Project not found: ${input.projectId}`);

  const id = `pay_${crypto.randomUUID().slice(0, 12)}`;
  const paidAt = input.paidAt || new Date().toISOString();
  const netAmount = Math.max(0, Number((input.amount - input.platformFee).toFixed(2)));
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO payments (id, project_id, job_id, amount, currency, platform_fee, net_amount, paid_at, notes, is_demo, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.projectId,
    String(project.job_id),
    input.amount,
    input.currency || 'USD',
    input.platformFee || 0,
    netAmount,
    paidAt,
    input.notes || null,
    Number(project.is_demo || 0),
    now,
  );

  db.prepare(`UPDATE projects SET status = 'paid', paid_at = ?, updated_at = ? WHERE id = ?`).run(
    paidAt,
    now,
    input.projectId,
  );
  db.prepare(`UPDATE jobs SET status = 'paid', date_updated = ? WHERE id = ?`).run(now, String(project.job_id));

  logAudit('payment_recorded', 'payment', id, {
    projectId: input.projectId,
    amount: input.amount,
    currency: input.currency,
    netAmount,
  });

  return {
    id,
    projectId: input.projectId,
    jobId: String(project.job_id),
    amount: input.amount,
    currency: input.currency || 'USD',
    platformFee: input.platformFee || 0,
    netAmount,
    paidAt,
    notes: input.notes || null,
    isDemo: Boolean(project.is_demo),
    createdAt: now,
  };
}

export async function toggleDemoMode(enabled: boolean): Promise<{ demoMode: boolean; summary: string }> {
  const db = getDb();
  const settings = getHubSettings();

  if (!enabled) {
    // Cleanly remove all demo workspaces and demo rows so production DB stays 100% pure
    const demoProjects = db.prepare('SELECT id FROM projects WHERE is_demo = 1').all() as Array<{ id: string }>;
    for (const p of demoProjects) {
      try {
        const root = getProjectWorkspaceRoot(p.id);
        if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
      } catch {
        // ignore cleanup error
      }
    }
    db.prepare('DELETE FROM payments WHERE is_demo = 1').run();
    db.prepare('DELETE FROM projects WHERE is_demo = 1').run();
    db.prepare('DELETE FROM jobs WHERE is_demo = 1').run();
    settings.demoMode = false;
    saveHubSettings(settings);
    logAudit('demo_mode_disabled', 'settings', 'demo_mode', {});
    return { demoMode: false, summary: 'Demo Mode disabled and all [DEMO] records removed cleanly.' };
  }

  settings.demoMode = true;
  saveHubSettings(settings);

  const existingDemo = (db.prepare('SELECT COUNT(*) as cnt FROM jobs WHERE is_demo = 1').get() as { cnt: number }).cnt;
  if (existingDemo > 0) {
    return { demoMode: true, summary: 'Demo Mode enabled (existing [DEMO] dataset active).' };
  }

  const demoJobs = [
    {
      sourceId: 'manual',
      sourceName: 'Upwork (Demo)',
      title: '[DEMO] Clean & Normalize 2,500-Row SaaS CRM Excel Workbook + Executive PDF Audit',
      description:
        'We need an Excel and data cleaning specialist to deduplicate a 2,500-row B2B CRM export, standardize phone/country columns, build summary pivot tables in XLSX, export a clean CSV, and write a concise PDF audit report documenting data quality metrics.',
      budget: 420,
      currency: 'USD',
      paymentType: 'fixed' as const,
      skills: ['Excel', 'Data Cleaning', 'Spreadsheet Work', 'Python'],
      category: 'Excel',
      isDemo: true,
    },
    {
      sourceId: 'manual',
      sourceName: 'Freelancer.com (Demo)',
      title: '[DEMO] Technical Documentation & API Onboarding Guide for Node.js Webhook Service',
      description:
        'Write a developer-ready technical documentation package in Markdown and DOCX covering REST webhook authentication, retry semantics, payload schemas, and TypeScript integration examples. Clear structure, zero fluff, ready for external partners.',
      budget: 550,
      currency: 'USD',
      paymentType: 'fixed' as const,
      skills: ['Technical Writing', 'Node.js', 'TypeScript', 'API Documentation'],
      category: 'Technical documentation',
      isDemo: true,
    },
    {
      sourceId: 'manual',
      sourceName: 'Fiverr (Demo)',
      title: '[DEMO] Minimalist Logo Design & Brand Identity Kit in Adobe Illustrator',
      description:
        'Looking for a graphic designer to design a modern minimalist logo, color palette, typography kit, social media banner templates, and business card mockups in Photoshop and Illustrator.',
      budget: 180,
      currency: 'USD',
      paymentType: 'fixed' as const,
      skills: ['Adobe Illustrator', 'Adobe Photoshop', 'Logo Design'],
      category: 'Graphic Design (Excluded)',
      isDemo: true,
    },
    {
      sourceId: 'manual',
      sourceName: 'PeoplePerHour (Demo)',
      title: '[DEMO] B2B SaaS Competitor Research Report & PowerPoint Deck',
      description:
        'Conduct structured internet research comparing 8 mid-market inventory automation tools on pricing tiers, integrations, and onboarding friction. Deliver an Excel comparison matrix, Word report, and 10-slide PowerPoint presentation.',
      budget: 380,
      currency: 'USD',
      paymentType: 'fixed' as const,
      skills: ['Business Research', 'Internet Research', 'Excel', 'PowerPoint'],
      category: 'Business research',
      isDemo: true,
    },
  ];

  const importedIds: string[] = [];
  for (const item of demoJobs) {
    const res = importNormalizedJob(item);
    importedIds.push(res.jobId);
    await analyzeJobById(res.jobId, false);
  }

  // Generate a proposal & execute a real workspace pipeline for the first demo job so Submission Center & QA have real generated files!
  if (importedIds[0]) {
    const prop = await generateProposalForJob(importedIds[0]);
    const { project, task } = approveJobIntoProject(importedIds[0], prop.id);
    await runProjectExecutionPipeline(project.id, task.id);
    const doneAt = new Date().toISOString();
    db.prepare(`UPDATE agent_tasks SET status = 'completed', progress = 100, completed_at = ?, updated_at = ? WHERE id = ?`).run(
      doneAt,
      doneAt,
      task.id,
    );
  }

  logAudit('demo_mode_enabled', 'settings', 'demo_mode', { seededJobs: importedIds.length });
  return {
    demoMode: true,
    summary: `Demo Mode enabled with ${importedIds.length} labeled [DEMO] jobs and 1 executed demo project with real DOCX/XLSX/CSV/PDF/ZIP files.`,
  };
}
