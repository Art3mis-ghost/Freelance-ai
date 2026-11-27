import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createNotification, getDb, getHubSettings, logAudit } from '../db/database.ts';
import { readSafeWorkspaceFile } from '../security.ts';
import {
  listProjectDeliverables,
  listWorkspaceTree,
  packageProjectDeliverablesZip,
  sha256Buffer,
  writeWorkspaceTextFile,
} from './workspaceService.ts';
import { listQaReports } from './qaService.ts';
import {
  createApprovalRequest,
  getApprovalById,
  getLatestApprovalForEntity,
  requiresApprovalForAction,
} from './autonomyService.ts';
import { getPlatformAccount, logPlatformActivity } from './platformAccountsService.ts';
import { scanFilesForSecrets, type SecretScanOptions } from './secretScanner.ts';
import {
  DeliveryTransitionError,
  listDeliveryEvidence,
  listDeliveryTransitions,
  transitionDeliveryState,
} from './deliveryStateMachine.ts';
import type {
  DeliveryManifestFile,
  DeliveryPackageManifest,
  DeliveryRecord,
  DeliveryReport,
  DeliveryStatus,
  SubmissionMethod,
} from '../../shared/types.ts';

export { DeliveryTransitionError };

const MAX_SINGLE_FILE_BYTES = 25 * 1024 * 1024; // 25 MB per deliverable file
const MAX_TOTAL_PACKAGE_BYTES = 100 * 1024 * 1024; // 100 MB total package cap

/**
 * Always excluded from client delivery packages (never silently deleted from workspace;
 * recorded in excludedInternalFiles so operator sees full transparency).
 */
const INTERNAL_OR_SENSITIVE_FILE_PATTERNS = [
  /^plan\.md$/i,
  /^project_plan\.md$/i,
  /^qa_report.*\.md$/i,
  /^agent_logs/i,
  /^internal_/i,
  /^cookies/i,
  /\.log$/i,
  /^\.env(?:\.|$)/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.netrc$/i,
  /^\.git-credentials$/i,
  /\.db(?:-wal|-shm)?$/i,
  /\.sqlite3?(?:-wal|-shm)?$/i,
  /secret/i,
  /\.key$/i,
  /\.pem$/i,
  /\.p12$/i,
  /\.pfx$/i,
];

function isSensitiveOrInternalFile(filename: string, relativePath: string): boolean {
  return INTERNAL_OR_SENSITIVE_FILE_PATTERNS.some((rx) => rx.test(filename) || rx.test(relativePath));
}

/**
 * Documented dotfile policy:
 * - Sensitive dotfiles (.env*, .npmrc, .pypirc, .netrc, .git-credentials) are ALWAYS excluded & blocked.
 * - Benign dotfiles (e.g. .gitignore, .editorconfig, .prettierrc) are NOT silently deleted;
 *   they are scanned for secrets and flagged with a package warning + humanReviewRequired = true.
 */
function isBenignDotfile(filename: string, relativePath: string): boolean {
  return filename.startsWith('.') && !isSensitiveOrInternalFile(filename, relativePath);
}

function inferPlatformKeyFromSource(sourceId: string | null, sourceName: string): string {
  const s = (sourceId || sourceName || '').toLowerCase();
  if (s.includes('upwork')) return 'upwork';
  if (s.includes('fiverr')) return 'fiverr';
  if (s.includes('freelancer')) return 'freelancer';
  if (s.includes('peopleperhour')) return 'peopleperhour';
  if (s.includes('guru')) return 'guru';
  if (s.includes('contra')) return 'contra';
  if (s.includes('workana')) return 'workana';
  if (s.includes('remotive')) return 'remotive_public';
  if (s.includes('remoteok')) return 'remoteok_public';
  if (s.includes('arbeitnow')) return 'arbeitnow_public';
  return sourceId || 'manual';
}

function mapDeliveryRow(row: Record<string, unknown>): DeliveryRecord {
  let manifest: DeliveryPackageManifest | null = null;
  if (row.manifest_json) {
    try {
      manifest = JSON.parse(String(row.manifest_json)) as DeliveryPackageManifest;
    } catch {
      manifest = null;
    }
  }
  const approvalId = row.approval_id ? String(row.approval_id) : null;
  const approval = approvalId ? getApprovalById(approvalId) : null;
  const id = String(row.id);

  const rawSource = String(row.verification_source || 'none');
  const verificationSource: DeliveryRecord['verificationSource'] =
    rawSource === 'platform_verified' || rawSource === 'manual_self_reported' ? rawSource : 'none';

  return {
    id,
    projectId: String(row.project_id),
    jobId: String(row.job_id),
    projectTitle: String(row.project_title || row.title || 'Project'),
    platformKey: String(row.platform_key || 'manual'),
    platformName: String(row.platform_name || 'Manual Import'),
    jobUrl: row.job_url ? String(row.job_url) : null,
    status: String(row.status || 'not_ready') as DeliveryStatus,
    submissionMethod: String(row.submission_method || 'manual_upload') as SubmissionMethod,
    verificationSource,
    approvalId,
    approvalStatus: approval?.status || null,
    packageZipPath: row.package_zip_path ? String(row.package_zip_path) : null,
    manifest,
    deliverySummary: row.delivery_summary ? String(row.delivery_summary) : null,
    submissionMessage: row.submission_message ? String(row.submission_message) : null,
    externalReference: row.external_reference ? String(row.external_reference) : null,
    confirmationNote: row.confirmation_note ? String(row.confirmation_note) : null,
    submittedAt: row.submitted_at ? String(row.submitted_at) : null,
    deliveredAt: row.delivered_at ? String(row.delivered_at) : null,
    acceptedAt: row.accepted_at ? String(row.accepted_at) : null,
    paidAt: row.paid_at ? String(row.paid_at) : null,
    lastError: row.last_error ? String(row.last_error) : null,
    evidence: listDeliveryEvidence(id),
    transitions: listDeliveryTransitions(id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function deriveInitialStatus(projectStatus: string, hasZip: boolean, qaPassed: boolean): DeliveryStatus {
  if (projectStatus === 'paid') return 'paid';
  if (projectStatus === 'submitted') return 'submission_reported';
  if (projectStatus === 'cancelled') return 'cancelled';
  if (projectStatus === 'failed') return 'failed';
  if (projectStatus === 'qa_running' || projectStatus === 'needs_review') return 'qa_pending';
  if (projectStatus === 'ready_for_submission') {
    return hasZip && qaPassed ? 'ready_for_delivery' : 'preparing';
  }
  return 'not_ready';
}

export function ensureDeliveryRecordForProject(projectId: string): DeliveryRecord {
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT d.*, p.title AS project_title, j.job_url
       FROM delivery_records d
       JOIN projects p ON p.id = d.project_id
       JOIN jobs j ON j.id = d.job_id
       WHERE d.project_id = ?`,
    )
    .get(projectId) as Record<string, unknown> | undefined;

  if (existing) {
    return mapDeliveryRow(existing);
  }

  const proj = db
    .prepare(
      `SELECT p.*, j.source_id, j.source_name, j.job_url
       FROM projects p
       JOIN jobs j ON j.id = p.job_id
       WHERE p.id = ?`,
    )
    .get(projectId) as Record<string, unknown> | undefined;

  if (!proj) {
    throw new DeliveryTransitionError('NOT_FOUND', `Project not found: ${projectId}`, 404);
  }

  const deliverables = listProjectDeliverables(projectId);
  const zipItem = deliverables.find((d) => d.fileType.toLowerCase() === 'zip');
  const latestQa = listQaReports(projectId)[0] || null;
  const qaPassed = Boolean(latestQa && latestQa.score >= 70 && latestQa.status === 'ready_for_review');
  const platformKey = inferPlatformKeyFromSource(
    proj.source_id ? String(proj.source_id) : null,
    String(proj.source_name || 'Manual Import'),
  );

  const id = `deliv_${crypto.randomUUID().slice(0, 10)}`;
  const now = new Date().toISOString();
  const initialStatus = deriveInitialStatus(String(proj.status || 'planning'), Boolean(zipItem), qaPassed);

  db.prepare(
    `INSERT INTO delivery_records (
      id, project_id, job_id, platform_key, platform_name, status, submission_method,
      verification_source, package_zip_path, submission_message, submitted_at, delivered_at,
      accepted_at, paid_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'manual_upload', 'none', ?, ?, ?, NULL, NULL, ?, ?, ?)`,
  ).run(
    id,
    projectId,
    String(proj.job_id),
    platformKey,
    String(proj.source_name || 'Manual Import'),
    initialStatus,
    zipItem ? zipItem.relativePath : null,
    proj.submission_message ? String(proj.submission_message) : null,
    proj.submitted_at ? String(proj.submitted_at) : null,
    proj.paid_at ? String(proj.paid_at) : null,
    now,
    now,
  );

  return ensureDeliveryRecordForProject(projectId);
}

export function listDeliveryRecords(search = '', statusFilter?: string): DeliveryRecord[] {
  const db = getDb();
  const settings = getHubSettings();
  const demoClause = settings.demoMode ? '' : 'WHERE p.is_demo = 0';

  const projectRows = db
    .prepare(`SELECT p.id FROM projects p ${demoClause} ORDER BY p.updated_at DESC LIMIT 80`)
    .all() as Array<{ id: string }>;
  for (const pr of projectRows) {
    ensureDeliveryRecordForProject(pr.id);
  }

  const rows = db
    .prepare(
      `SELECT d.*, p.title AS project_title, j.job_url
       FROM delivery_records d
       JOIN projects p ON p.id = d.project_id
       JOIN jobs j ON j.id = d.job_id
       ${settings.demoMode ? '' : 'WHERE p.is_demo = 0'}
       ORDER BY d.updated_at DESC`,
    )
    .all() as Array<Record<string, unknown>>;

  let records = rows.map(mapDeliveryRow);
  if (statusFilter && statusFilter !== 'all') {
    records = records.filter((r) => r.status === statusFilter);
  }
  const q = search.trim().toLowerCase();
  if (q) {
    records = records.filter(
      (r) =>
        r.projectTitle.toLowerCase().includes(q) ||
        r.platformName.toLowerCase().includes(q) ||
        (r.externalReference || '').toLowerCase().includes(q) ||
        r.status.toLowerCase().includes(q),
    );
  }
  return records;
}

export async function prepareDeliveryPackage(
  projectId: string,
  options: {
    submissionMethod?: SubmissionMethod;
    submissionMessage?: string;
    deliverySummary?: string;
    scanOptions?: SecretScanOptions;
  } = {},
): Promise<DeliveryRecord> {
  const db = getDb();
  const record = ensureDeliveryRecordForProject(projectId);
  const now = new Date().toISOString();

  // Gather workspace tree and separate client-facing deliverables from internal files
  const tree = listWorkspaceTree(projectId);
  const deliverables = listProjectDeliverables(projectId);
  const excludedInternalFiles: string[] = [];
  const missingFiles: string[] = [];
  const corruptedFiles: string[] = [];
  const packageWarnings: string[] = [];

  for (const node of tree) {
    const rel = node.relativePath;
    const base = node.filename || path.basename(rel);
    if (isSensitiveOrInternalFile(base, rel) || !rel.startsWith('deliverables/')) {
      excludedInternalFiles.push(rel);
    }
  }

  // Validate every registered deliverable (confinement, no symlinks, existence, SHA-256, size limits, dotfile policy)
  const includedFiles: DeliveryManifestFile[] = [];
  const buffersToScan: Array<{ relativePath: string; buffer: Buffer }> = [];
  let totalBytes = 0;
  let sizeLimitExceeded = false;
  let securityViolationDetected = false;

  for (const d of deliverables) {
    if (d.fileType.toLowerCase() === 'zip' && d.filename.endsWith('_package.zip')) {
      continue;
    }

    const relNorm = d.relativePath.replace(/\\/g, '/');
    const base = path.basename(relNorm);

    // Block path traversal or outside-workspace registered paths immediately
    if (
      relNorm.includes('..') ||
      path.isAbsolute(relNorm) ||
      /^[a-zA-Z]:/.test(relNorm) ||
      !relNorm.startsWith('deliverables/')
    ) {
      securityViolationDetected = true;
      corruptedFiles.push(`${relNorm} (blocked: outside deliverables workspace)`);
      packageWarnings.push(`Blocked deliverable outside workspace boundary: ${relNorm}`);
      continue;
    }

    // Never package sensitive/internal files (never silently delete from disk; exclude & flag)
    if (isSensitiveOrInternalFile(base, relNorm)) {
      excludedInternalFiles.push(relNorm);
      // If a sensitive file (.env, .key, .pem, etc.) was registered directly inside deliverables/, flag it!
      if (/^\.env(?:\.|$)|^\.npmrc$|^\.pypirc$|^\.netrc$|^\.git-credentials$|\.key$|\.pem$|\.p12$|\.pfx$/i.test(base)) {
        packageWarnings.push(`Excluded sensitive file from client package: ${relNorm}`);
        // Also scan it so secret findings are visible to the operator if present in deliverables/
        try {
          const sensitiveRead = readSafeWorkspaceFile(projectId, relNorm);
          buffersToScan.push({ relativePath: relNorm, buffer: sensitiveRead.buffer });
        } catch {
          // ignore read error on excluded sensitive file
        }
      }
      continue;
    }

    // Documented dotfile policy: benign dotfiles are warned, never silently deleted
    if (isBenignDotfile(base, relNorm)) {
      packageWarnings.push(`Benign dotfile included (${relNorm}) — review before sending to client.`);
    }

    // Read file strictly via O_NOFOLLOW + realpath confinement
    let readResult: { buffer: Buffer; sizeBytes: number; absolutePath: string };
    try {
      readResult = readSafeWorkspaceFile(projectId, relNorm);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      const msg = err instanceof Error ? err.message : String(err);
      if (code === 'ENOENT') {
        missingFiles.push(relNorm);
        packageWarnings.push(`Missing deliverable on disk: ${relNorm}`);
      } else {
        securityViolationDetected = true;
        corruptedFiles.push(`${relNorm} (${msg})`);
        packageWarnings.push(`Blocked unsafe deliverable ${relNorm}: ${msg}`);
      }
      continue;
    }

    // Enforce per-file size limit
    if (readResult.sizeBytes > MAX_SINGLE_FILE_BYTES) {
      sizeLimitExceeded = true;
      packageWarnings.push(
        `File exceeds maximum allowed size (${readResult.sizeBytes} bytes > ${MAX_SINGLE_FILE_BYTES} bytes): ${relNorm}`,
      );
      continue;
    }

    // Enforce total package size limit
    if (totalBytes + readResult.sizeBytes > MAX_TOTAL_PACKAGE_BYTES) {
      sizeLimitExceeded = true;
      packageWarnings.push(
        `Total package size exceeds maximum allowed limit (${MAX_TOTAL_PACKAGE_BYTES} bytes).`,
      );
      continue;
    }

    // Verify SHA-256 integrity against stored hash when available
    const actualSha = sha256Buffer(readResult.buffer);
    let hashVerified = d.verified;
    if (d.sha256 && d.sha256.length === 64 && actualSha !== d.sha256) {
      corruptedFiles.push(`${relNorm} (SHA-256 mismatch)`);
      packageWarnings.push(`Deliverable integrity mismatch detected for ${relNorm} (file modified or corrupted after registration).`);
      hashVerified = false;
      continue;
    }

    totalBytes += readResult.sizeBytes;
    buffersToScan.push({ relativePath: relNorm, buffer: readResult.buffer });
    includedFiles.push({
      filename: d.filename,
      relativePath: relNorm,
      fileType: d.fileType,
      sizeBytes: readResult.sizeBytes,
      sha256: actualSha,
      verified: hashVerified,
    });
  }

  // Also inspect deliverables/ directory for any unregistered symlinks or sensitive dotfiles sitting on disk
  try {
    const deliverablesDir = path.join(path.dirname(readSafeWorkspaceFile(projectId, 'requirements/job_brief.md').absolutePath), '..', 'deliverables');
    if (fs.existsSync(deliverablesDir)) {
      for (const entry of fs.readdirSync(deliverablesDir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) {
          securityViolationDetected = true;
          corruptedFiles.push(`deliverables/${entry.name} (blocked symlink)`);
          packageWarnings.push(`Symbolic link detected inside deliverables/: ${entry.name}`);
        }
      }
    }
  } catch {
    // Workspace may not have job_brief.md in minimal unit tests; check via deliverables list instead
  }

  // Also scan submission_message.md if provided or present
  const submissionMsgToScan = options.submissionMessage?.trim() || record.submissionMessage || '';
  if (submissionMsgToScan) {
    buffersToScan.push({
      relativePath: 'submission_message.md',
      buffer: Buffer.from(submissionMsgToScan, 'utf8'),
    });
  }

  // Deep secret scanning across text, code, DOCX, XLSX (incl. hidden sheets), PPTX, PDF, ZIP, TAR/TAR.GZ (BUG 6)
  const secretScanReport = scanFilesForSecrets(buffersToScan, options.scanOptions);
  for (const w of secretScanReport.warnings) {
    packageWarnings.push(w);
  }
  for (const u of secretScanReport.unsupportedFormats) {
    packageWarnings.push(`Unsupported binary format (${u.file}): ${u.reason}`);
  }
  for (const e of secretScanReport.scanErrors) {
    packageWarnings.push(`Secret scanner error (${e.file}): ${e.error}`);
  }

  const secretsScanPassed =
    secretScanReport.scanStatus === 'clean' ||
    (secretScanReport.scanStatus === 'partially_scanned' &&
      secretScanReport.findings.length === 0 &&
      !secretScanReport.timedOut &&
      secretScanReport.scanErrors.length === 0);

  const hasHardValidationFailure =
    secretScanReport.findings.length > 0 ||
    secretScanReport.timedOut ||
    secretScanReport.scanErrors.length > 0 ||
    missingFiles.length > 0 ||
    corruptedFiles.length > 0 ||
    sizeLimitExceeded ||
    securityViolationDetected;

  const humanReviewRequired =
    secretScanReport.humanReviewRequired ||
    packageWarnings.length > 0 ||
    hasHardValidationFailure;

  // Build real ZIP bundle ONLY from validated, clean deliverable files
  let zipPath: string | null = null;
  let zipSha: string | null = null;
  if (includedFiles.length > 0 && !hasHardValidationFailure) {
    if (options.submissionMessage?.trim()) {
      writeWorkspaceTextFile(projectId, 'submission_message.md', options.submissionMessage.trim(), false);
      db.prepare('UPDATE projects SET submission_message = ?, updated_at = ? WHERE id = ?').run(
        options.submissionMessage.trim(),
        now,
        projectId,
      );
    }
    const zipDeliverable = await packageProjectDeliverablesZip(projectId, {
      allowedRelativePaths: includedFiles.map((f) => f.relativePath),
      includeSubmissionMessage: true,
    });
    zipPath = zipDeliverable.relativePath;
    zipSha = zipDeliverable.sha256;
  } else if (options.submissionMessage?.trim()) {
    writeWorkspaceTextFile(projectId, 'submission_message.md', options.submissionMessage.trim(), false);
    db.prepare('UPDATE projects SET submission_message = ?, updated_at = ? WHERE id = ?').run(
      options.submissionMessage.trim(),
      now,
      projectId,
    );
  }

  const latestQa = listQaReports(projectId)[0] || null;
  const qaScore = latestQa ? latestQa.score : null;
  const qaPassed = Boolean(
    latestQa &&
      latestQa.score >= 70 &&
      latestQa.status === 'ready_for_review',
  );

  const manifest: DeliveryPackageManifest = {
    preparedAt: now,
    zipRelativePath: zipPath,
    zipSha256: zipSha,
    totalFiles: includedFiles.length,
    totalBytes,
    includedFiles,
    excludedInternalFiles: Array.from(new Set(excludedInternalFiles)),
    missingFiles,
    corruptedFiles,
    packageWarnings: Array.from(new Set(packageWarnings)),
    secretsScanPassed: secretsScanPassed && !hasHardValidationFailure,
    secretScanReport,
    internalLogsExcluded: true,
    qaScore,
    qaPassed,
    humanReviewRequired,
  };

  const summaryText =
    options.deliverySummary?.trim() ||
    `# Delivery Summary — ${record.projectTitle}\n\n` +
      `- Prepared: ${now}\n` +
      `- Client Deliverables: ${includedFiles.length} verified file(s)\n` +
      `- QA Score: ${qaScore !== null ? `${qaScore}/100 (${latestQa?.status})` : 'Pending QA'}\n` +
      `- Secret Scan Status: ${secretScanReport.scanStatus} (${secretScanReport.findings.length} finding(s), ${secretScanReport.unsupportedFormats.length} unsupported binary file(s))\n` +
      `- Integrity Checks: ${missingFiles.length} missing, ${corruptedFiles.length} corrupted/blocked\n` +
      `- Human Review Required: ${humanReviewRequired ? 'Yes' : 'No'}\n`;

  let nextStatus: DeliveryStatus = 'ready_for_delivery';
  let lastError: string | null = null;
  let approvalId = record.approvalId;

  if (hasHardValidationFailure) {
    nextStatus = 'needs_manual_action';
    if (secretScanReport.findings.length > 0) {
      lastError = `Secret scan detected ${secretScanReport.findings.length} potential secret or archive safety issue(s). Review manifest findings before delivery.`;
    } else if (secretScanReport.timedOut) {
      lastError = 'Secret scan timed out before completing all files. Manual review required.';
    } else if (missingFiles.length > 0) {
      lastError = `Missing deliverable file(s) on disk: ${missingFiles.join(', ')}`;
    } else if (corruptedFiles.length > 0) {
      lastError = `Corrupted or unsafe deliverable file(s): ${corruptedFiles.join(', ')}`;
    } else if (sizeLimitExceeded) {
      lastError = 'Deliverable package exceeded maximum permitted file or total package size limits.';
    } else {
      lastError = 'Package validation encountered errors requiring manual operator inspection.';
    }
  } else if (includedFiles.length === 0) {
    nextStatus = 'not_ready';
    lastError = 'No valid client deliverable files found to package.';
  } else if (!qaPassed) {
    nextStatus = 'qa_pending';
    lastError = latestQa
      ? `QA status is "${latestQa.status}" (${latestQa.score}/100). Resolve QA findings before delivery.`
      : 'Quality Control evaluation has not been completed for this project.';
  } else if (requiresApprovalForAction('final_delivery_submission')) {
    const existingApproval = getLatestApprovalForEntity('final_delivery_submission', 'project', projectId);
    if (existingApproval?.status === 'approved') {
      approvalId = existingApproval.id;
      nextStatus = 'ready_for_delivery';
    } else {
      const approval = createApprovalRequest({
        actionType: 'final_delivery_submission',
        title: `Final Delivery: ${record.projectTitle}`,
        description: `Approve final delivery package (${includedFiles.length} verified client file(s), QA ${qaScore}/100, secret scan: ${secretScanReport.scanStatus}) for ${record.platformName}.`,
        riskLevel: humanReviewRequired ? 'critical' : 'high',
        relatedEntityType: 'project',
        relatedEntityId: projectId,
        platformKey: record.platformKey,
        payload: {
          projectId,
          zipPath,
          totalFiles: includedFiles.length,
          qaScore,
          secretScanStatus: secretScanReport.scanStatus,
          humanReviewRequired,
        },
        requestedBy: 'delivery_agent',
      });
      approvalId = approval.id;
      nextStatus = 'awaiting_approval';
    }
  }

  const nextMethod: SubmissionMethod = options.submissionMethod || record.submissionMethod;

  db.prepare(
    `UPDATE delivery_records
     SET status = ?,
         submission_method = ?,
         approval_id = ?,
         package_zip_path = ?,
         manifest_json = ?,
         delivery_summary = ?,
         submission_message = COALESCE(?, submission_message),
         last_error = ?,
         updated_at = ?
     WHERE project_id = ?`,
  ).run(
    nextStatus,
    nextMethod,
    approvalId,
    zipPath,
    JSON.stringify(manifest),
    summaryText,
    options.submissionMessage?.trim() || null,
    lastError,
    now,
    projectId,
  );

  logAudit(
    'delivery_package_prepared',
    'delivery',
    record.id,
    {
      projectId,
      status: nextStatus,
      totalFiles: includedFiles.length,
      missingFiles: missingFiles.length,
      corruptedFiles: corruptedFiles.length,
      secretsScanPassed: manifest.secretsScanPassed,
      secretScanStatus: secretScanReport.scanStatus,
      findingsCount: secretScanReport.findings.length,
      unsupportedBinaryCount: secretScanReport.unsupportedFormats.length,
      qaScore,
      qaPassed,
      humanReviewRequired,
    },
    hasHardValidationFailure ? 'warning' : 'info',
  );

  return ensureDeliveryRecordForProject(projectId);
}

/**
 * Shared authoritative delivery submission gate used by BOTH:
 * - POST /api/deliveries/:projectId/submit
 * - POST /api/projects/:id/submit (BUG 1 fix — zero bypass!)
 */
export function submitDelivery(
  projectId: string,
  input: {
    submissionMethod?: SubmissionMethod;
    externalReference?: string;
    confirmationNote?: string;
    confirmedManualUpload?: boolean;
    /** Explicitly forbidden as a verification bypass (BUG 4) */
    markDelivered?: boolean;
    /** Provided ONLY by real verified official API upload adapters */
    platformReceipt?: {
      receiptId: string;
      summary: string;
      verifiedByPlatform: true;
      metadata?: Record<string, unknown>;
    };
    actor?: string;
  } = {},
): { ok: boolean; status: DeliveryStatus; message: string; delivery: DeliveryRecord; httpStatus?: number } {
  const db = getDb();
  const record = ensureDeliveryRecordForProject(projectId);
  const now = new Date().toISOString();
  const actor = input.actor?.trim() || 'operator';
  const method = input.submissionMethod || record.submissionMethod;

  // BUG 4: Explicitly reject client attempts to force verified "delivered" status via boolean flag
  if (input.markDelivered === true) {
    throw new DeliveryTransitionError(
      'EVIDENCE_REQUIRED',
      'The "markDelivered" boolean shortcut has been removed. Record manual submission first, then record client receipt separately with explicit evidence via POST /api/deliveries/:projectId/transition.',
      400,
    );
  }

  // Prevent duplicate submission if already submitted, delivered, accepted, paid, or cancelled
  if (['submission_reported', 'submitted', 'delivered', 'accepted', 'paid', 'cancelled'].includes(record.status)) {
    throw new DeliveryTransitionError(
      'DUPLICATE_TRANSITION',
      `Project delivery is already in status "${record.status}". Duplicate submission is rejected.`,
      409,
    );
  }

  // 1. Validate delivery package preparation, files on disk, integrity, and secret scan
  if (!record.manifest || !record.packageZipPath || record.manifest.includedFiles.length === 0) {
    throw new DeliveryTransitionError(
      'PACKAGE_NOT_READY',
      'Delivery package must be prepared with verified deliverable files before submission.',
      400,
    );
  }
  if (
    !record.manifest.secretsScanPassed ||
    (record.manifest.missingFiles && record.manifest.missingFiles.length > 0) ||
    (record.manifest.corruptedFiles && record.manifest.corruptedFiles.length > 0)
  ) {
    return {
      ok: false,
      status: 'needs_manual_action',
      message: 'Blocked: delivery package failed secret scanning or file integrity checks. Inspect and re-prepare before submission.',
      delivery: record,
      httpStatus: 400,
    };
  }
  // Verify packaged ZIP still exists safely inside workspace at submission time
  try {
    readSafeWorkspaceFile(projectId, record.packageZipPath, 32);
  } catch {
    throw new DeliveryTransitionError(
      'PACKAGE_NOT_READY',
      'Packaged delivery ZIP archive is missing or inaccessible on disk. Re-prepare the delivery package.',
      400,
    );
  }

  // 2. Enforce Quality Control pass requirement
  const latestQa = listQaReports(projectId)[0] || null;
  const qaPassed = Boolean(latestQa && latestQa.score >= 70 && latestQa.status === 'ready_for_review');
  if (!qaPassed) {
    throw new DeliveryTransitionError(
      'QA_REQUIRED',
      latestQa
        ? `Blocked: latest QA status is "${latestQa.status}" (${latestQa.score}/100). Project must pass QA before submission.`
        : 'Blocked: project has not passed Quality Control verification.',
      400,
    );
  }

  // 3. Enforce Human Approval Gate before any final submission
  if (requiresApprovalForAction('final_delivery_submission')) {
    const latestApproval =
      (record.approvalId ? getApprovalById(record.approvalId) : null) ||
      getLatestApprovalForEntity('final_delivery_submission', 'project', projectId);

    if (!latestApproval || latestApproval.status !== 'approved') {
      const approval =
        latestApproval && latestApproval.status === 'pending'
          ? latestApproval
          : createApprovalRequest({
              actionType: 'final_delivery_submission',
              title: `Approve Delivery: ${record.projectTitle}`,
              description: `Explicit operator approval is required before finalizing delivery via ${method} on ${record.platformName}.`,
              riskLevel: 'high',
              relatedEntityType: 'project',
              relatedEntityId: projectId,
              platformKey: record.platformKey,
              payload: { projectId, submissionMethod: method },
              requestedBy: 'delivery_agent',
            });

      db.prepare(
        `UPDATE delivery_records SET status = 'awaiting_approval', approval_id = ?, updated_at = ? WHERE project_id = ?`,
      ).run(approval.id, now, projectId);

      logAudit(
        'delivery_submission_blocked_approval',
        'delivery',
        record.id,
        { projectId, approvalId: approval.id, method },
        'warning',
        actor,
      );

      return {
        ok: false,
        status: 'awaiting_approval',
        message: 'Human approval is required in Automation -> Approvals before finalizing delivery.',
        delivery: ensureDeliveryRecordForProject(projectId),
        httpStatus: 403,
      };
    }

    // If approval is now approved while status was awaiting_approval, transition cleanly into ready_for_delivery first
    if (record.status === 'awaiting_approval') {
      transitionDeliveryState({
        projectId,
        targetStatus: 'ready_for_delivery',
        actor,
        reason: `Human approval ${latestApproval.id} granted`,
      });
    }
  } else if (record.status === 'awaiting_approval') {
    transitionDeliveryState({
      projectId,
      targetStatus: 'ready_for_delivery',
      actor,
      reason: 'Approval gate not required under current autonomy policy',
    });
  }

  // 4. Enforce Platform Policy for Official API submission adapters
  const platformAccount = getPlatformAccount(record.platformKey);
  if (method === 'official_api' || method === 'authorized_upload') {
    if (
      !platformAccount ||
      !platformAccount.capabilities.deliverableSubmission ||
      !platformAccount.permittedCapabilities.deliverableSubmission
    ) {
      const msg = `${record.platformName} does not permit automated deliverable uploads via official API. Switched to Guided Manual Upload — download the verified ZIP bundle and upload it directly on ${record.platformName}.`;
      transitionDeliveryState({
        projectId,
        targetStatus: 'needs_manual_action',
        actor,
        reason: msg,
        submissionMethod: 'manual_upload',
        lastError: msg,
      });
      if (platformAccount) {
        logPlatformActivity(platformAccount.id, 'delivery_policy_fallback', 'warning', msg);
      }
      return {
        ok: false,
        status: 'needs_manual_action',
        message: msg,
        delivery: ensureDeliveryRecordForProject(projectId),
        httpStatus: 403,
      };
    }

    // Even if permitted, platform-verified 'submitted' requires real platform API receipt evidence!
    if (!input.platformReceipt || !input.platformReceipt.verifiedByPlatform || !input.platformReceipt.receiptId?.trim()) {
      const msg = `Official API delivery for ${record.platformName} requires a verified platform API upload receipt. No live upload confirmation was returned.`;
      transitionDeliveryState({
        projectId,
        targetStatus: 'needs_manual_action',
        actor,
        reason: msg,
        lastError: msg,
      });
      return {
        ok: false,
        status: 'needs_manual_action',
        message: msg,
        delivery: ensureDeliveryRecordForProject(projectId),
        httpStatus: 400,
      };
    }

    transitionDeliveryState({
      projectId,
      targetStatus: 'submitted',
      actor,
      reason: `Platform-verified upload via ${method}`,
      submissionMethod: method,
      externalReference: input.platformReceipt.receiptId.trim(),
      confirmationNote: input.confirmationNote?.trim() || input.platformReceipt.summary,
      requirePackageReady: true,
      packageReady: true,
      requireQaPassed: true,
      qaPassed: true,
      requireApproval: requiresApprovalForAction('final_delivery_submission'),
      approvalGranted: true,
      evidence: {
        evidenceType: 'official_api_response',
        verifiedByPlatform: true,
        summary: input.platformReceipt.summary,
        externalReference: input.platformReceipt.receiptId.trim(),
        metadata: input.platformReceipt.metadata,
      },
    });

    const updated = ensureDeliveryRecordForProject(projectId);
    if (platformAccount) {
      logPlatformActivity(
        platformAccount.id,
        'delivery_platform_verified',
        'success',
        `Recorded platform-verified submission for "${record.projectTitle}" via ${method}.`,
        { projectId, externalReference: input.platformReceipt.receiptId.trim() },
      );
    }
    createNotification(
      'delivery_submitted',
      `Delivery Verified by Platform: ${record.projectTitle}`,
      `Platform-verified submission recorded via ${method} (Ref: ${input.platformReceipt.receiptId.trim()}).`,
      'success',
      'project',
      projectId,
    );
    return {
      ok: true,
      status: 'submitted',
      message: 'Delivery recorded as platform-verified submitted.',
      delivery: updated,
    };
  }

  // 5. Guided manual upload / manual browser handoff (BUG 3 & BUG 4):
  // NEVER mark platform-verified 'submitted' or 'delivered' from manual operator self-reporting!
  const refTrimmed = input.externalReference?.trim() || '';
  const noteTrimmed = input.confirmationNote?.trim() || '';
  const hasManualConfirmationDetails = Boolean(refTrimmed || noteTrimmed || input.confirmedManualUpload);

  const targetStatus: DeliveryStatus = hasManualConfirmationDetails
    ? 'submission_reported'
    : 'submission_unverified';

  const evidenceSummary =
    noteTrimmed ||
    (refTrimmed
      ? `Operator reported manual upload on ${record.platformName} (self-reported reference: ${refTrimmed}).`
      : `Operator initiated manual delivery recording on ${record.platformName} without platform verification.`);

  transitionDeliveryState({
    projectId,
    targetStatus,
    actor,
    reason:
      targetStatus === 'submission_reported'
        ? `Operator self-reported manual upload via ${method} (unverified by platform)`
        : `Manual delivery initiated without confirmation details via ${method}`,
    submissionMethod: method,
    externalReference: refTrimmed || null,
    confirmationNote: noteTrimmed || null,
    requirePackageReady: true,
    packageReady: true,
    requireQaPassed: true,
    qaPassed: true,
    requireApproval: requiresApprovalForAction('final_delivery_submission'),
    approvalGranted: true,
    evidence: {
      evidenceType: 'manual_self_report',
      verifiedByPlatform: false,
      summary: evidenceSummary,
      externalReference: refTrimmed || null,
      metadata: {
        submissionMethod: method,
        confirmedManualUpload: Boolean(input.confirmedManualUpload),
      },
    },
  });

  const updated = ensureDeliveryRecordForProject(projectId);

  if (platformAccount) {
    logPlatformActivity(
      platformAccount.id,
      'delivery_manual_reported',
      'info',
      `Recorded self-reported ${targetStatus} for "${record.projectTitle}" via ${method} (not platform-verified).`,
      { projectId, externalReference: refTrimmed || null },
    );
  }

  createNotification(
    'delivery_submitted',
    `Manual Submission Reported: ${record.projectTitle}`,
    `Self-reported delivery recorded via ${method}${refTrimmed ? ` (Ref: ${refTrimmed})` : ''}. Platform receipt is not yet verified.`,
    'info',
    'project',
    projectId,
  );

  return {
    ok: true,
    status: targetStatus,
    message:
      targetStatus === 'submission_reported'
        ? 'Manual submission reported (self-reported; not platform-verified). Record client receipt separately once confirmed.'
        : 'Delivery recorded as submission_unverified (add manual confirmation details or record client receipt once verified).',
    delivery: updated,
  };
}

/**
 * Controlled post-submission lifecycle transitions (delivered / accepted / failed / cancelled).
 * Always validates transitions via deliveryStateMachine and records immutable evidence + server timestamps.
 */
export function transitionDeliveryWorkflow(
  projectId: string,
  input: {
    targetStatus: 'delivered' | 'accepted' | 'failed' | 'cancelled';
    evidenceSummary: string;
    externalReference?: string | null;
    reason?: string;
    actor?: string;
  },
): DeliveryRecord {
  ensureDeliveryRecordForProject(projectId);
  const summary = input.evidenceSummary?.trim() || '';
  if (!summary && (input.targetStatus === 'delivered' || input.targetStatus === 'accepted')) {
    throw new DeliveryTransitionError(
      'EVIDENCE_REQUIRED',
      `Transitioning to "${input.targetStatus}" requires a non-empty evidence summary.`,
      400,
    );
  }

  const evidenceType =
    input.targetStatus === 'delivered'
      ? 'client_receipt_confirmation'
      : input.targetStatus === 'accepted'
        ? 'client_acceptance_confirmation'
        : 'system_note';

  transitionDeliveryState({
    projectId,
    targetStatus: input.targetStatus,
    actor: input.actor || 'operator',
    reason: input.reason?.trim() || summary || `Status transitioned to ${input.targetStatus}`,
    externalReference: input.externalReference?.trim() || undefined,
    confirmationNote: summary || undefined,
    evidence: summary
      ? {
          evidenceType,
          verifiedByPlatform: false,
          summary,
          externalReference: input.externalReference?.trim() || null,
        }
      : null,
  });

  return ensureDeliveryRecordForProject(projectId);
}

/**
 * Edits ONLY non-authoritative draft metadata (submissionMessage, submissionMethod, notes/reference).
 * Direct status mutations are strictly blocked (BUG 4 & BUG 8) — callers must use submitDelivery()
 * or transitionDeliveryWorkflow() so state machine & evidence rules can never be bypassed.
 */
export function updateDeliveryRecord(
  projectId: string,
  patch: {
    status?: DeliveryStatus;
    submissionMethod?: SubmissionMethod;
    externalReference?: string | null;
    confirmationNote?: string | null;
    submissionMessage?: string | null;
  },
): DeliveryRecord {
  if (patch.status !== undefined) {
    throw new DeliveryTransitionError(
      'INVALID_TRANSITION',
      'Direct status overwrites via PATCH are prohibited. Use /submit or /transition with required evidence.',
      400,
    );
  }

  const db = getDb();
  const current = ensureDeliveryRecordForProject(projectId);
  const now = new Date().toISOString();

  if (patch.submissionMessage) {
    writeWorkspaceTextFile(projectId, 'submission_message.md', patch.submissionMessage, false);
    db.prepare('UPDATE projects SET submission_message = ?, updated_at = ? WHERE id = ?').run(
      patch.submissionMessage,
      now,
      projectId,
    );
  }

  db.prepare(
    `UPDATE delivery_records
     SET submission_method = ?,
         external_reference = ?,
         confirmation_note = ?,
         submission_message = ?,
         updated_at = ?
     WHERE project_id = ?`,
  ).run(
    patch.submissionMethod || current.submissionMethod,
    patch.externalReference !== undefined ? patch.externalReference : current.externalReference,
    patch.confirmationNote !== undefined ? patch.confirmationNote : current.confirmationNote,
    patch.submissionMessage !== undefined ? patch.submissionMessage : current.submissionMessage,
    now,
    projectId,
  );

  logAudit('delivery_draft_updated', 'delivery', current.id, {
    projectId,
    submissionMethod: patch.submissionMethod || current.submissionMethod,
    hasSubmissionMessage: Boolean(patch.submissionMessage ?? current.submissionMessage),
  });

  return ensureDeliveryRecordForProject(projectId);
}

export function buildDeliveryReport(projectId: string): DeliveryReport {
  const db = getDb();
  const delivery = ensureDeliveryRecordForProject(projectId);
  const row = db
    .prepare(
      `SELECT p.*, j.budget, j.currency, j.client_info_json
       FROM projects p
       JOIN jobs j ON j.id = p.job_id
       WHERE p.id = ?`,
    )
    .get(projectId) as Record<string, unknown> | undefined;
  if (!row) throw new DeliveryTransitionError('NOT_FOUND', `Project not found: ${projectId}`, 404);

  const latestQa = listQaReports(projectId)[0] || null;
  const approval = delivery.approvalId ? getApprovalById(delivery.approvalId) : null;
  const deliverables =
    delivery.manifest?.includedFiles ||
    listProjectDeliverables(projectId)
      .filter((d) => d.fileType.toLowerCase() !== 'zip')
      .map((d) => ({
        filename: d.filename,
        relativePath: d.relativePath,
        fileType: d.fileType,
        sizeBytes: d.sizeBytes,
        sha256: d.sha256,
        verified: d.verified,
      }));

  let clientInfo: Record<string, unknown> | null = null;
  if (row.client_info_json) {
    try {
      clientInfo = JSON.parse(String(row.client_info_json)) as Record<string, unknown>;
    } catch {
      clientInfo = null;
    }
  }

  let verifiedZipPath = delivery.packageZipPath;
  if (verifiedZipPath) {
    try {
      const read = readSafeWorkspaceFile(projectId, verifiedZipPath, 32);
      if (!fs.existsSync(read.absolutePath)) {
        verifiedZipPath = null;
      }
    } catch {
      verifiedZipPath = null;
    }
  }

  return {
    deliveryId: delivery.id,
    projectId: delivery.projectId,
    jobId: delivery.jobId,
    projectTitle: delivery.projectTitle,
    platformName: delivery.platformName,
    clientInfo,
    budget: row.budget !== null && row.budget !== undefined ? Number(row.budget) : null,
    currency: String(row.currency || 'USD'),
    deliveryStatus: delivery.status,
    submissionMethod: delivery.submissionMethod,
    verificationSource: delivery.verificationSource,
    qaScore: latestQa ? latestQa.score : null,
    qaStatus: latestQa ? latestQa.status : null,
    approvalStatus: approval?.status || null,
    approvalDecidedAt: approval?.decidedAt || null,
    packageZipPath: verifiedZipPath,
    deliverables,
    excludedInternalFiles: delivery.manifest?.excludedInternalFiles || [],
    secretsScanPassed: delivery.manifest?.secretsScanPassed ?? false,
    secretScanReport: delivery.manifest?.secretScanReport || null,
    submissionMessage: delivery.submissionMessage,
    externalReference: delivery.externalReference,
    confirmationNote: delivery.confirmationNote,
    submittedAt: delivery.submittedAt,
    deliveredAt: delivery.deliveredAt,
    acceptedAt: delivery.acceptedAt,
    paidAt: delivery.paidAt,
    evidence: delivery.evidence,
    transitions: delivery.transitions,
    generatedAt: new Date().toISOString(),
  };
}

export function formatDeliveryReportMarkdown(report: DeliveryReport): string {
  const lines = [
    `# Delivery Report — ${report.projectTitle}`,
    '',
    `- **Delivery ID**: ${report.deliveryId}`,
    `- **Project ID**: ${report.projectId}`,
    `- **Platform**: ${report.platformName}`,
    `- **Delivery Status**: ${report.deliveryStatus}`,
    `- **Verification Source**: ${report.verificationSource}`,
    `- **Submission Method**: ${report.submissionMethod}`,
    `- **QA Score**: ${report.qaScore !== null ? `${report.qaScore}/100 (${report.qaStatus})` : 'Not run'}`,
    `- **Human Approval**: ${report.approvalStatus || 'Not required / pending'}${report.approvalDecidedAt ? ` (${report.approvalDecidedAt})` : ''}`,
    `- **Secrets & Integrity Check**: ${report.secretsScanPassed ? 'Passed (internal logs excluded)' : 'Flagged / Attention Required'}${report.secretScanReport ? ` [${report.secretScanReport.scanStatus}; ${report.secretScanReport.findings.length} finding(s)]` : ''}`,
    `- **Package Archive**: ${report.packageZipPath || 'Not packaged yet'}`,
    `- **External Reference**: ${report.externalReference || 'None recorded'}`,
    `- **Submitted / Reported At**: ${report.submittedAt || 'Not recorded yet'}`,
    `- **Delivered At**: ${report.deliveredAt || 'Not confirmed delivered'}`,
    `- **Accepted At**: ${report.acceptedAt || 'Not confirmed accepted'}`,
    `- **Paid At**: ${report.paidAt || 'Not recorded paid'}`,
    '',
    '## Included Client Deliverables',
    ...(report.deliverables.length > 0
      ? report.deliverables.map(
          (f) => `- \`${f.relativePath}\` (${f.fileType}, ${f.sizeBytes} bytes, SHA-256: \`${f.sha256.slice(0, 16)}...\`)`,
        )
      : ['- No client deliverable files listed yet.']),
    '',
    '## Excluded Internal Files',
    ...(report.excludedInternalFiles.length > 0
      ? report.excludedInternalFiles.map((f) => `- \`${f}\``)
      : ['- None']),
    '',
    '## Recorded Evidence',
    ...(report.evidence.length > 0
      ? report.evidence.map(
          (ev) =>
            `- [${ev.recordedAt}] \`${ev.evidenceType}\` (platform verified: ${ev.verifiedByPlatform ? 'yes' : 'no'}): ${ev.summary}`,
        )
      : ['- No submission evidence recorded yet.']),
    '',
    '## Submission Message',
    report.submissionMessage ? report.submissionMessage : '_No submission message drafted._',
    '',
    `---`,
    `_Generated at ${report.generatedAt}_`,
  ];
  return lines.join('\n');
}
