import crypto from 'node:crypto';
import { createNotification, getDb, getHubSettings, logAudit, saveHubSettings } from '../db/database.ts';
import type {
  ApprovalActionType,
  ApprovalRecord,
  ApprovalStatus,
  AutonomyConfig,
  AutonomyLevel,
} from '../../shared/types.ts';

export const AUTONOMY_LEVEL_DESCRIPTIONS: Record<
  AutonomyLevel,
  { name: string; summary: string; permittedScope: string; blockedScope: string }
> = {
  1: {
    name: 'Level 1 — Research Only',
    summary: 'Discover permitted public opportunities, score matches, and summarize briefs.',
    permittedScope: 'Public feed searches, manual imports, job analysis, and risk scoring.',
    blockedScope: 'Automatic proposal drafting, workspace execution, messaging, and submissions.',
  },
  2: {
    name: 'Level 2 — Prepare & Draft',
    summary: 'Discover jobs, analyze feasibility, and prepare proposals and execution plans for review.',
    permittedScope: 'Research + proposal drafting + work planning (all external actions require approval).',
    blockedScope: 'Unapproved project execution, external uploads, messaging, or submissions.',
  },
  3: {
    name: 'Level 3 — Execute Locally',
    summary: 'Execute approved projects inside isolated local workspaces, build deliverables, and run QA.',
    permittedScope: 'Approved workspace production, file generation, QA audits, and ZIP packaging.',
    blockedScope: 'External client messaging, paid bids, contract acceptance, and final submissions without approval.',
  },
  4: {
    name: 'Level 4 — Assisted External Actions',
    summary: 'Prepare verified delivery bundles and official API payloads with explicit per-action approval gates.',
    permittedScope: 'Guided submission prep, delivery manifests, and approved official API actions.',
    blockedScope: 'Any unapproved external submission, financial transaction, or restricted platform automation.',
  },
  5: {
    name: 'Level 5 — Controlled Autonomy',
    summary: 'Streamlined end-to-end orchestration within strict daily caps, platform policies, and approval invariants.',
    permittedScope: 'Full local pipeline + permitted official API workflows within configured caps.',
    blockedScope: 'NEVER overrides platform ToS, CAPTCHA/MFA, paid bid approval, contract acceptance, or security boundaries.',
  },
};

function mapApprovalRow(row: Record<string, unknown>): ApprovalRecord {
  let payload: Record<string, unknown> = {};
  try {
    payload = row.payload_json ? (JSON.parse(String(row.payload_json)) as Record<string, unknown>) : {};
  } catch {
    payload = {};
  }

  return {
    id: String(row.id),
    actionType: String(row.action_type) as ApprovalActionType,
    title: String(row.title),
    description: String(row.description),
    riskLevel: String(row.risk_level || 'medium') as ApprovalRecord['riskLevel'],
    status: String(row.status || 'pending') as ApprovalStatus,
    relatedEntityType: row.related_entity_type ? String(row.related_entity_type) : null,
    relatedEntityId: row.related_entity_id ? String(row.related_entity_id) : null,
    platformKey: row.platform_key ? String(row.platform_key) : null,
    estimatedCostUsd: row.estimated_cost_usd !== null && row.estimated_cost_usd !== undefined ? Number(row.estimated_cost_usd) : null,
    payload,
    requestedBy: String(row.requested_by || 'system'),
    decidedBy: row.decided_by ? String(row.decided_by) : null,
    decisionNote: row.decision_note ? String(row.decision_note) : null,
    createdAt: String(row.created_at),
    decidedAt: row.decided_at ? String(row.decided_at) : null,
  };
}

export function getAutonomyConfig(): AutonomyConfig {
  return getHubSettings().autonomy;
}

export function updateAutonomyConfig(patch: Partial<AutonomyConfig>): AutonomyConfig {
  const settings = getHubSettings();
  const nextLevel = patch.level !== undefined ? (Math.max(1, Math.min(5, Math.round(patch.level))) as AutonomyLevel) : settings.autonomy.level;

  // Hard security invariants: paid bids, contract acceptance, and CAPTCHA/MFA pause can NEVER be silently bypassed
  const next: AutonomyConfig = {
    ...settings.autonomy,
    ...patch,
    level: nextLevel,
    maxDailyApplications: Math.max(0, Math.min(200, Math.round(patch.maxDailyApplications ?? settings.autonomy.maxDailyApplications))),
    maxBidAmountUsd: Math.max(0, Math.min(100000, Number(patch.maxBidAmountUsd ?? settings.autonomy.maxBidAmountUsd))),
    maxDailySpendUsd: Math.max(0, Math.min(10000, Number(patch.maxDailySpendUsd ?? settings.autonomy.maxDailySpendUsd))),
    requireApprovalForPaidBids: true,
    requireApprovalForContractAcceptance: true,
    pauseOnCaptchaOrMfa: true,
    pauseOnPolicyWarning: true,
  };

  saveHubSettings({ ...settings, autonomy: next });
  logAudit('autonomy_config_updated', 'autonomy', 'global', {
    level: next.level,
    maxDailyApplications: next.maxDailyApplications,
    maxBidAmountUsd: next.maxBidAmountUsd,
    requireApprovalForFinalDelivery: next.requireApprovalForFinalDelivery,
  });
  return next;
}

export function listApprovals(statusFilter?: ApprovalStatus | 'all'): ApprovalRecord[] {
  const db = getDb();
  const rows =
    statusFilter && statusFilter !== 'all'
      ? (db
          .prepare('SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC LIMIT 120')
          .all(statusFilter) as Array<Record<string, unknown>>)
      : (db.prepare('SELECT * FROM approvals ORDER BY created_at DESC LIMIT 120').all() as Array<
          Record<string, unknown>
        >);
  return rows.map(mapApprovalRow);
}

export function getApprovalById(id: string): ApprovalRecord | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? mapApprovalRow(row) : null;
}

export function getLatestApprovalForEntity(
  actionType: ApprovalActionType,
  relatedEntityType: string,
  relatedEntityId: string,
): ApprovalRecord | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT * FROM approvals
       WHERE action_type = ? AND related_entity_type = ? AND related_entity_id = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(actionType, relatedEntityType, relatedEntityId) as Record<string, unknown> | undefined;
  return row ? mapApprovalRow(row) : null;
}

export function createApprovalRequest(input: {
  actionType: ApprovalActionType;
  title: string;
  description: string;
  riskLevel?: ApprovalRecord['riskLevel'];
  relatedEntityType?: string | null;
  relatedEntityId?: string | null;
  platformKey?: string | null;
  estimatedCostUsd?: number | null;
  payload?: Record<string, unknown>;
  requestedBy?: string;
}): ApprovalRecord {
  const db = getDb();
  const now = new Date().toISOString();

  // Deduplicate existing pending request for the same entity & action
  if (input.relatedEntityType && input.relatedEntityId) {
    const existingPending = db
      .prepare(
        `SELECT * FROM approvals
         WHERE action_type = ? AND related_entity_type = ? AND related_entity_id = ? AND status = 'pending'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(input.actionType, input.relatedEntityType, input.relatedEntityId) as Record<string, unknown> | undefined;
    if (existingPending) {
      return mapApprovalRow(existingPending);
    }
  }

  const id = `appr_${crypto.randomUUID().slice(0, 10)}`;
  db.prepare(
    `INSERT INTO approvals (
      id, action_type, title, description, risk_level, status,
      related_entity_type, related_entity_id, platform_key, estimated_cost_usd,
      payload_json, requested_by, created_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.actionType,
    input.title.trim().slice(0, 180),
    input.description.trim().slice(0, 1500),
    input.riskLevel || 'high',
    input.relatedEntityType || null,
    input.relatedEntityId || null,
    input.platformKey || null,
    input.estimatedCostUsd ?? null,
    JSON.stringify(input.payload || {}),
    input.requestedBy || 'agent_orchestrator',
    now,
  );

  createNotification(
    'approval_required',
    `Approval Required: ${input.title.slice(0, 90)}`,
    input.description.slice(0, 220),
    'warning',
    input.relatedEntityType || 'approval',
    input.relatedEntityId || id,
  );

  logAudit('approval_requested', 'approval', id, {
    actionType: input.actionType,
    relatedEntityId: input.relatedEntityId || null,
    platformKey: input.platformKey || null,
  });

  return getApprovalById(id)!;
}

export function decideApproval(
  approvalId: string,
  decision: 'approved' | 'rejected' | 'revoked',
  decisionNote?: string,
  decidedBy = 'operator',
): ApprovalRecord {
  const db = getDb();
  const existing = getApprovalById(approvalId);
  if (!existing) throw new Error(`Approval request not found: ${approvalId}`);

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE approvals
     SET status = ?, decided_by = ?, decision_note = ?, decided_at = ?
     WHERE id = ?`,
  ).run(decision, decidedBy, decisionNote?.trim() || null, now, approvalId);

  // Sync delivery_records status if this approval gates a delivery
  if (existing.actionType === 'final_delivery_submission' && existing.relatedEntityId) {
    if (decision === 'approved') {
      db.prepare(
        `UPDATE delivery_records
         SET status = CASE WHEN status = 'awaiting_approval' THEN 'ready_for_delivery' ELSE status END,
             updated_at = ?
         WHERE project_id = ?`,
      ).run(now, existing.relatedEntityId);
    } else if (decision === 'rejected' || decision === 'revoked') {
      db.prepare(
        `UPDATE delivery_records
         SET status = 'needs_manual_action',
             last_error = ?,
             updated_at = ?
         WHERE project_id = ? AND status NOT IN ('submitted', 'delivered')`,
      ).run(`Delivery approval ${decision}: ${decisionNote || 'Operator declined'}`, now, existing.relatedEntityId);
    }
  }

  logAudit(`approval_${decision}`, 'approval', approvalId, {
    actionType: existing.actionType,
    relatedEntityId: existing.relatedEntityId,
    decisionNote: decisionNote || null,
  });

  return getApprovalById(approvalId)!;
}

export function requiresApprovalForAction(actionType: ApprovalActionType, estimatedCostUsd = 0): boolean {
  const cfg = getAutonomyConfig();
  if (actionType === 'paid_bid' || actionType === 'contract_acceptance') return true;
  if (estimatedCostUsd > cfg.maxDailySpendUsd && estimatedCostUsd > 0) return true;
  if (actionType === 'final_delivery_submission') return cfg.requireApprovalForFinalDelivery || cfg.level < 5;
  if (actionType === 'client_message') return cfg.requireApprovalForClientMessages;
  if (actionType === 'external_upload') return cfg.requireApprovalForExternalUploads;
  if (actionType === 'application_submission') return cfg.level < 4;
  return true;
}
