import crypto from 'node:crypto';
import { getDb, logAudit } from '../db/database.ts';
import type {
  DeliveryEvidenceRecord,
  DeliveryEvidenceType,
  DeliveryStatus,
  DeliveryTransitionRecord,
  SubmissionMethod,
} from '../../shared/types.ts';

export class DeliveryTransitionError extends Error {
  readonly code:
    | 'NOT_FOUND'
    | 'INVALID_TRANSITION'
    | 'DUPLICATE_TRANSITION'
    | 'QA_REQUIRED'
    | 'PACKAGE_NOT_READY'
    | 'APPROVAL_REQUIRED'
    | 'EVIDENCE_REQUIRED'
    | 'POLICY_BLOCKED';
  readonly httpStatus: number;

  constructor(
    code: DeliveryTransitionError['code'],
    message: string,
    httpStatus = 400,
  ) {
    super(message);
    this.name = 'DeliveryTransitionError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/**
 * Authoritative state transition table.
 * Prevents skipping verification gates or forcing arbitrary delivery states.
 */
export const ALLOWED_DELIVERY_TRANSITIONS: Record<DeliveryStatus, readonly DeliveryStatus[]> = {
  not_ready: ['preparing', 'qa_pending', 'needs_manual_action', 'failed', 'cancelled'],
  preparing: ['not_ready', 'qa_pending', 'ready_for_delivery', 'awaiting_approval', 'needs_manual_action', 'failed', 'cancelled'],
  qa_pending: ['preparing', 'ready_for_delivery', 'awaiting_approval', 'needs_manual_action', 'failed', 'cancelled'],
  ready_for_delivery: [
    'preparing',
    'qa_pending',
    'awaiting_approval',
    'delivery_in_progress',
    'submission_unverified',
    'submission_reported',
    'submitted',
    'needs_manual_action',
    'failed',
    'cancelled',
  ],
  awaiting_approval: ['ready_for_delivery', 'preparing', 'needs_manual_action', 'failed', 'cancelled'],
  delivery_in_progress: ['submission_unverified', 'submission_reported', 'submitted', 'needs_manual_action', 'failed', 'cancelled'],
  needs_manual_action: ['preparing', 'qa_pending', 'ready_for_delivery', 'awaiting_approval', 'submission_unverified', 'submission_reported', 'failed', 'cancelled'],
  submission_unverified: ['submission_reported', 'submitted', 'delivered', 'failed', 'cancelled'],
  submission_reported: ['submitted', 'delivered', 'accepted', 'paid', 'failed', 'cancelled'],
  submitted: ['delivered', 'accepted', 'paid', 'failed', 'cancelled'],
  delivered: ['accepted', 'paid', 'failed'],
  accepted: ['paid'],
  paid: [],
  failed: ['preparing', 'needs_manual_action', 'cancelled'],
  cancelled: [],
};

export function isDeliveryTransitionAllowed(from: DeliveryStatus, to: DeliveryStatus): boolean {
  return ALLOWED_DELIVERY_TRANSITIONS[from]?.includes(to) ?? false;
}

export interface TransitionEvidenceInput {
  evidenceType: DeliveryEvidenceType;
  verifiedByPlatform: boolean;
  summary: string;
  externalReference?: string | null;
  metadata?: Record<string, unknown>;
}

export interface DeliveryTransitionRequest {
  projectId: string;
  targetStatus: DeliveryStatus;
  actor?: string;
  reason: string;
  submissionMethod?: SubmissionMethod;
  confirmationNote?: string | null;
  externalReference?: string | null;
  lastError?: string | null;
  evidence?: TransitionEvidenceInput | null;
  /** Optional prerequisite flags validated by caller/service */
  requireQaPassed?: boolean;
  qaPassed?: boolean;
  requirePackageReady?: boolean;
  packageReady?: boolean;
  requireApproval?: boolean;
  approvalGranted?: boolean;
}

function sanitizeMetadata(meta?: Record<string, unknown>): Record<string, unknown> {
  if (!meta) return {};
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (/secret|token|password|cookie|api_?key|authorization/i.test(k)) continue;
    clean[k] = v;
  }
  return clean;
}

function validateEvidenceForTarget(
  targetStatus: DeliveryStatus,
  evidence?: TransitionEvidenceInput | null,
): void {
  if (targetStatus === 'submitted') {
    if (
      !evidence ||
      !evidence.verifiedByPlatform ||
      !['official_api_response', 'verified_upload_receipt'].includes(evidence.evidenceType)
    ) {
      throw new DeliveryTransitionError(
        'EVIDENCE_REQUIRED',
        'Platform-verified "submitted" status requires verified official API response or upload receipt evidence. Manual self-reports must use "submission_reported" or "submission_unverified".',
        400,
      );
    }
  }

  if (targetStatus === 'submission_reported') {
    if (!evidence || evidence.evidenceType !== 'manual_self_report' || !evidence.summary.trim()) {
      throw new DeliveryTransitionError(
        'EVIDENCE_REQUIRED',
        'Recording "submission_reported" requires a manual_self_report evidence summary.',
        400,
      );
    }
  }

  if (targetStatus === 'delivered') {
    if (
      !evidence ||
      evidence.evidenceType !== 'client_receipt_confirmation' ||
      !evidence.summary.trim()
    ) {
      throw new DeliveryTransitionError(
        'EVIDENCE_REQUIRED',
        'Transitioning to "delivered" requires explicit client_receipt_confirmation evidence (cannot be set via a bare boolean).',
        400,
      );
    }
  }

  if (targetStatus === 'accepted') {
    if (
      !evidence ||
      evidence.evidenceType !== 'client_acceptance_confirmation' ||
      !evidence.summary.trim()
    ) {
      throw new DeliveryTransitionError(
        'EVIDENCE_REQUIRED',
        'Transitioning to "accepted" requires explicit client_acceptance_confirmation evidence.',
        400,
      );
    }
  }

  if (targetStatus === 'paid') {
    if (
      !evidence ||
      evidence.evidenceType !== 'payment_confirmation' ||
      !evidence.summary.trim()
    ) {
      throw new DeliveryTransitionError(
        'EVIDENCE_REQUIRED',
        'Transitioning to "paid" requires payment_confirmation evidence recorded through the payment service.',
        400,
      );
    }
  }
}

export function listDeliveryEvidence(deliveryId: string): DeliveryEvidenceRecord[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM delivery_evidence WHERE delivery_id = ? ORDER BY recorded_at ASC')
    .all(deliveryId) as Array<Record<string, unknown>>;
  return rows.map((r) => {
    let metadata: Record<string, unknown> = {};
    try {
      metadata = r.metadata_json ? (JSON.parse(String(r.metadata_json)) as Record<string, unknown>) : {};
    } catch {
      metadata = {};
    }
    return {
      id: String(r.id),
      deliveryId: String(r.delivery_id),
      projectId: String(r.project_id),
      evidenceType: String(r.evidence_type) as DeliveryEvidenceType,
      verifiedByPlatform: Boolean(r.verified_by_platform),
      summary: String(r.summary),
      externalReference: r.external_reference ? String(r.external_reference) : null,
      actor: String(r.actor || 'operator'),
      metadata,
      recordedAt: String(r.recorded_at),
    };
  });
}

export function listDeliveryTransitions(deliveryId: string): DeliveryTransitionRecord[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM delivery_transitions WHERE delivery_id = ? ORDER BY recorded_at ASC')
    .all(deliveryId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    deliveryId: String(r.delivery_id),
    projectId: String(r.project_id),
    fromStatus: String(r.from_status) as DeliveryStatus,
    toStatus: String(r.to_status) as DeliveryStatus,
    actor: String(r.actor || 'operator'),
    reason: String(r.reason),
    evidenceId: r.evidence_id ? String(r.evidence_id) : null,
    recordedAt: String(r.recorded_at),
  }));
}

/**
 * Executes a validated, atomic, server-timestamped delivery state transition.
 * Synchronizes delivery_records, projects, jobs, delivery_evidence, delivery_transitions, and audit_logs.
 */
export function transitionDeliveryState(req: DeliveryTransitionRequest): {
  deliveryId: string;
  fromStatus: DeliveryStatus;
  toStatus: DeliveryStatus;
  recordedAt: string;
  evidenceId: string | null;
} {
  const db = getDb();
  const actor = req.actor?.trim() || 'operator';
  const serverNow = new Date().toISOString();

  const row = db
    .prepare('SELECT * FROM delivery_records WHERE project_id = ?')
    .get(req.projectId) as Record<string, unknown> | undefined;

  if (!row) {
    throw new DeliveryTransitionError('NOT_FOUND', `Delivery record not found for project ${req.projectId}`, 404);
  }

  const deliveryId = String(row.id);
  const jobId = String(row.job_id);
  const fromStatus = String(row.status) as DeliveryStatus;
  const toStatus = req.targetStatus;

  // Duplicate transition guard (for terminal or submission/delivery milestones)
  if (fromStatus === toStatus) {
    throw new DeliveryTransitionError(
      'DUPLICATE_TRANSITION',
      `Delivery is already in state "${toStatus}". Duplicate transitions are rejected.`,
      409,
    );
  }

  // Allowed transition check
  if (!isDeliveryTransitionAllowed(fromStatus, toStatus)) {
    throw new DeliveryTransitionError(
      'INVALID_TRANSITION',
      `Invalid delivery state transition from "${fromStatus}" to "${toStatus}".`,
      409,
    );
  }

  // Prerequisite gates
  if (req.requirePackageReady && !req.packageReady) {
    throw new DeliveryTransitionError(
      'PACKAGE_NOT_READY',
      'Delivery package is not prepared or failed integrity/secret validation.',
      400,
    );
  }
  if (req.requireQaPassed && !req.qaPassed) {
    throw new DeliveryTransitionError(
      'QA_REQUIRED',
      'Project must pass required Quality Control verification before submission.',
      400,
    );
  }
  if (req.requireApproval && !req.approvalGranted) {
    throw new DeliveryTransitionError(
      'APPROVAL_REQUIRED',
      'Explicit human approval in the Approval Queue is required before submission.',
      403,
    );
  }

  // Evidence integrity check
  validateEvidenceForTarget(toStatus, req.evidence);

  // Determine truthful verificationSource
  let nextVerificationSource = String(row.verification_source || 'none');
  if (req.evidence?.verifiedByPlatform && ['official_api_response', 'verified_upload_receipt'].includes(req.evidence.evidenceType)) {
    nextVerificationSource = 'platform_verified';
  } else if (
    nextVerificationSource !== 'platform_verified' &&
    ['submission_reported', 'submission_unverified', 'delivered', 'accepted'].includes(toStatus)
  ) {
    nextVerificationSource = 'manual_self_reported';
  }

  const evidenceId = req.evidence ? `ev_${crypto.randomUUID().slice(0, 12)}` : null;
  const transitionId = `tr_${crypto.randomUUID().slice(0, 12)}`;

  db.exec('BEGIN IMMEDIATE');
  try {
    // Re-check status inside write lock to prevent concurrent double-submit race
    const locked = db
      .prepare('SELECT status FROM delivery_records WHERE id = ?')
      .get(deliveryId) as { status: string } | undefined;
    if (!locked || locked.status !== fromStatus) {
      throw new DeliveryTransitionError(
        'DUPLICATE_TRANSITION',
        `Concurrent modification detected: delivery status changed from "${fromStatus}" to "${locked?.status || 'missing'}".`,
        409,
      );
    }

    if (req.evidence && evidenceId) {
      db.prepare(
        `INSERT INTO delivery_evidence (
          id, delivery_id, project_id, evidence_type, verified_by_platform,
          summary, external_reference, actor, metadata_json, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        evidenceId,
        deliveryId,
        req.projectId,
        req.evidence.evidenceType,
        req.evidence.verifiedByPlatform ? 1 : 0,
        req.evidence.summary.trim().slice(0, 2000),
        req.evidence.externalReference?.trim() || req.externalReference?.trim() || null,
        actor,
        JSON.stringify(sanitizeMetadata(req.evidence.metadata)),
        serverNow,
      );
    }

    const isSubmissionEvent = ['submission_unverified', 'submission_reported', 'submitted'].includes(toStatus);
    const isDeliveredEvent = toStatus === 'delivered';
    const isAcceptedEvent = toStatus === 'accepted';
    const isPaidEvent = toStatus === 'paid';

    db.prepare(
      `UPDATE delivery_records
       SET status = ?,
           submission_method = COALESCE(?, submission_method),
           verification_source = ?,
           external_reference = COALESCE(?, external_reference),
           confirmation_note = COALESCE(?, confirmation_note),
           submitted_at = CASE WHEN ? = 1 THEN COALESCE(submitted_at, ?) ELSE submitted_at END,
           delivered_at = CASE WHEN ? = 1 THEN COALESCE(delivered_at, ?) ELSE delivered_at END,
           accepted_at = CASE WHEN ? = 1 THEN COALESCE(accepted_at, ?) ELSE accepted_at END,
           paid_at = CASE WHEN ? = 1 THEN COALESCE(paid_at, ?) ELSE paid_at END,
           last_error = ?,
           updated_at = ?
       WHERE id = ?`,
    ).run(
      toStatus,
      req.submissionMethod || null,
      nextVerificationSource,
      req.externalReference?.trim() || null,
      req.confirmationNote?.trim() || null,
      isSubmissionEvent ? 1 : 0,
      serverNow,
      isDeliveredEvent ? 1 : 0,
      serverNow,
      isAcceptedEvent ? 1 : 0,
      serverNow,
      isPaidEvent ? 1 : 0,
      serverNow,
      req.lastError !== undefined ? req.lastError : toStatus === 'failed' ? req.reason : null,
      serverNow,
      deliveryId,
    );

    db.prepare(
      `INSERT INTO delivery_transitions (
        id, delivery_id, project_id, from_status, to_status, actor, reason, evidence_id, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      transitionId,
      deliveryId,
      req.projectId,
      fromStatus,
      toStatus,
      actor,
      req.reason.trim().slice(0, 600),
      evidenceId,
      serverNow,
    );

    // Synchronize projects and jobs statuses consistently inside the SAME transaction
    if (toStatus === 'paid') {
      db.prepare(`UPDATE projects SET status = 'paid', paid_at = COALESCE(paid_at, ?), updated_at = ? WHERE id = ?`).run(
        serverNow,
        serverNow,
        req.projectId,
      );
      db.prepare(`UPDATE jobs SET status = 'paid', date_updated = ? WHERE id = ?`).run(serverNow, jobId);
    } else if (['submission_reported', 'submitted', 'delivered', 'accepted'].includes(toStatus)) {
      db.prepare(
        `UPDATE projects
         SET status = CASE WHEN status = 'paid' THEN 'paid' ELSE 'submitted' END,
             submitted_at = COALESCE(submitted_at, ?),
             updated_at = ?
         WHERE id = ?`,
      ).run(serverNow, serverNow, req.projectId);
      db.prepare(
        `UPDATE jobs SET status = CASE WHEN status = 'paid' THEN 'paid' ELSE 'submitted' END, date_updated = ? WHERE id = ?`,
      ).run(serverNow, jobId);
    } else if (toStatus === 'cancelled') {
      db.prepare(`UPDATE projects SET status = 'cancelled', updated_at = ? WHERE id = ? AND status != 'paid'`).run(
        serverNow,
        req.projectId,
      );
    } else if (toStatus === 'failed') {
      db.prepare(`UPDATE projects SET status = 'needs_review', updated_at = ? WHERE id = ? AND status NOT IN ('submitted', 'paid')`).run(
        serverNow,
        req.projectId,
      );
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  logAudit(
    `delivery_transition_${toStatus}`,
    'delivery',
    deliveryId,
    {
      projectId: req.projectId,
      jobId,
      fromStatus,
      toStatus,
      verificationSource: nextVerificationSource,
      evidenceId,
      evidenceType: req.evidence?.evidenceType || null,
      verifiedByPlatform: req.evidence?.verifiedByPlatform ?? false,
      reason: req.reason.slice(0, 240),
    },
    toStatus === 'failed' ? 'error' : 'info',
    actor,
  );

  return {
    deliveryId,
    fromStatus,
    toStatus,
    recordedAt: serverNow,
    evidenceId,
  };
}
