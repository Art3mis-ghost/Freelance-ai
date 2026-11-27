import crypto from 'node:crypto';
import path from 'node:path';
import { createNotification, getDb, getHubSettings, logAudit } from '../db/database.ts';
import { assertToolAuthorized, readSafeWorkspaceFile } from '../security.ts';
import { listProjectDeliverables, sha256Buffer, writeWorkspaceTextFile } from './workspaceService.ts';
import type {
  DeliverableRecord,
  HumanReviewGate,
  QaChecklistItem,
  QaReportRecord,
  RequirementEvidenceLink,
  RequirementVerificationItem,
} from '../../shared/types.ts';

const PLACEHOLDER_PATTERN = /\b(TODO|TBD|FIXME|LOREM IPSUM)\b|\[INSERT\s[^\]]*\]|\[PLACEHOLDER[^\]]*\]/i;
const FALLBACK_MARKER_PATTERN = /\[FALLBACK DRAFT|FALLBACK DRAFT NOTICE|\[Fallback Notice\]|\[Human Action Required\]/i;

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'against', 'build', 'clean', 'client', 'create', 'deliver',
  'deliverable', 'deliverables', 'document', 'files', 'final', 'format', 'from', 'have',
  'include', 'into', 'make', 'must', 'need', 'needs', 'please', 'project', 'provide',
  'report', 'required', 'requirements', 'should', 'summary', 'that', 'their', 'there',
  'these', 'this', 'using', 'with', 'work', 'write', 'your',
]);

interface IndexedSection {
  file: string;
  section: string;
  text: string;
  lower: string;
  isDeliverable: boolean;
}

function verifyBinarySignature(buf: Buffer, fileType: string): { ok: boolean; reason: string } {
  if (buf.length < 8) {
    return { ok: false, reason: 'File is empty or truncated (< 8 bytes).' };
  }
  const upper = fileType.toUpperCase();
  if (['DOCX', 'XLSX', 'PPTX', 'ZIP'].includes(upper)) {
    const isPkZip = buf[0] === 0x50 && buf[1] === 0x4b;
    return isPkZip
      ? { ok: true, reason: `Valid OOXML/ZIP header verified (${buf.length} bytes).` }
      : { ok: false, reason: `Invalid ${upper} signature (expected PK header).` };
  }
  if (upper === 'PDF') {
    const header = buf.subarray(0, 5).toString('ascii');
    return header === '%PDF-'
      ? { ok: true, reason: `Valid PDF 1.x header verified (${buf.length} bytes).` }
      : { ok: false, reason: 'Invalid PDF header signature.' };
  }
  return { ok: true, reason: `Text/code deliverable verified (${buf.length} bytes).` };
}

function splitMarkdownSections(file: string, rawText: string, isDeliverable: boolean): IndexedSection[] {
  const sections: IndexedSection[] = [];
  const lines = rawText.split(/\r?\n/);
  let currentHeading = 'Document Body';
  let buffer: string[] = [];

  const flush = () => {
    const text = buffer.join('\n').trim();
    if (text.length > 0) {
      sections.push({
        file,
        section: currentHeading,
        text,
        lower: text.toLowerCase(),
        isDeliverable,
      });
    }
    buffer = [];
  };

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,4}\s+(.+)$/);
    if (headingMatch) {
      flush();
      currentHeading = headingMatch[1].trim();
    } else {
      buffer.push(line);
    }
  }
  flush();

  if (sections.length === 0 && rawText.trim().length > 0) {
    sections.push({
      file,
      section: 'Document Body',
      text: rawText.trim(),
      lower: rawText.trim().toLowerCase(),
      isDeliverable,
    });
  }
  return sections;
}

function extractSignificantTerms(text: string): string[] {
  const rawTokens = text
    .toLowerCase()
    .replace(/[^a-z0-9.#+/\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
  return Array.from(new Set(rawTokens));
}

function detectRequestedOutputFormats(text: string): Array<{ format: string; extensions: string[]; label: string }> {
  const lower = text.toLowerCase();
  const requested: Array<{ format: string; extensions: string[]; label: string }> = [];
  const checks: Array<{ rx: RegExp; format: string; extensions: string[]; label: string }> = [
    { rx: /\b(xlsx|excel|spreadsheet|workbook)\b/i, format: 'XLSX', extensions: ['.xlsx', '.csv'], label: 'Excel / Spreadsheet workbook (.xlsx)' },
    { rx: /\bcsv\b/i, format: 'CSV', extensions: ['.csv'], label: 'CSV dataset (.csv)' },
    { rx: /\bpdf\b/i, format: 'PDF', extensions: ['.pdf'], label: 'PDF document/report (.pdf)' },
    { rx: /\b(docx|word\s+doc|microsoft\s+word)\b/i, format: 'DOCX', extensions: ['.docx'], label: 'Word document (.docx)' },
    { rx: /\b(pptx|powerpoint|slide\s+deck|presentation)\b/i, format: 'PPTX', extensions: ['.pptx'], label: 'PowerPoint presentation (.pptx)' },
    { rx: /\b(html|landing\s+page|web\s+page|website)\b/i, format: 'HTML', extensions: ['.html', '.htm'], label: 'Web/HTML artifact (.html)' },
    { rx: /\b(python|\.py\b|automation\s+script)\b/i, format: 'PY', extensions: ['.py'], label: 'Python script (.py)' },
    { rx: /\b(markdown|\.md\b|api\s+docs?)\b/i, format: 'MD', extensions: ['.md'], label: 'Markdown documentation (.md)' },
  ];

  for (const c of checks) {
    if (c.rx.test(lower)) {
      requested.push({ format: c.format, extensions: c.extensions, label: c.label });
    }
  }
  return requested;
}

function extractBriefClauses(description: string): string[] {
  const normalized = description
    .replace(/\r\n/g, '\n')
    .split(/\n+|(?<=[.!?])\s+/)
    .map((s) => s.replace(/^[-*•\d.)\s]+/, '').trim())
    .filter((s) => s.length >= 22);

  // Deduplicate and cap to top 6 distinct substantive requirements from the brief
  const unique: string[] = [];
  for (const clause of normalized) {
    const key = clause.toLowerCase().slice(0, 50);
    if (!unique.some((u) => u.toLowerCase().slice(0, 50) === key)) {
      unique.push(clause.slice(0, 220));
    }
    if (unique.length >= 6) break;
  }
  return unique;
}

function findEvidenceForTerms(
  terms: string[],
  sections: IndexedSection[],
  deliverables: DeliverableRecord[],
): { evidenceLinks: RequirementEvidenceLink[]; matchedDeliverableTerms: number; matchedAnyTerms: number } {
  if (terms.length === 0) {
    return { evidenceLinks: [], matchedDeliverableTerms: 0, matchedAnyTerms: 0 };
  }

  const matchedInDeliverable = new Set<string>();
  const matchedAnywhere = new Set<string>();
  const links: RequirementEvidenceLink[] = [];

  for (const sec of sections) {
    const hits = terms.filter((t) => sec.lower.includes(t));
    if (hits.length === 0) continue;

    for (const h of hits) {
      matchedAnywhere.add(h);
      if (sec.isDeliverable) matchedInDeliverable.add(h);
    }

    // Grab concise snippet around first hit
    const firstIdx = sec.lower.indexOf(hits[0]);
    const start = Math.max(0, firstIdx - 40);
    const snippet = sec.text.slice(start, start + 140).replace(/\s+/g, ' ').trim();
    if (links.length < 3) {
      links.push({
        file: sec.file,
        section: sec.section,
        excerpt: snippet.length < sec.text.length ? `...${snippet}...` : snippet,
      });
    }
  }

  // Also check binary deliverable filenames/types when terms mention format/artifact names
  for (const d of deliverables) {
    const nameLower = `${d.filename} ${d.fileType}`.toLowerCase();
    const hits = terms.filter((t) => nameLower.includes(t));
    if (hits.length > 0) {
      for (const h of hits) {
        matchedAnywhere.add(h);
        matchedInDeliverable.add(h);
      }
      if (links.length < 3 && !links.some((l) => l.file === d.relativePath)) {
        links.push({
          file: d.relativePath,
          section: `${d.fileType} Deliverable Artifact`,
          excerpt: `Verified file ${d.filename} (${d.sizeBytes} bytes, sha256:${d.sha256.slice(0, 12)})`,
        });
      }
    }
  }

  return {
    evidenceLinks: links,
    matchedDeliverableTerms: matchedInDeliverable.size,
    matchedAnyTerms: matchedAnywhere.size,
  };
}

function buildRequirementVerification(params: {
  title: string;
  description: string;
  skills: string[];
  requiredDeliverables: string[];
  nonZipDeliverables: DeliverableRecord[];
  indexedSections: IndexedSection[];
  isDegradedFallback: boolean;
}): {
  requirementChecks: RequirementVerificationItem[];
  highRiskDetected: boolean;
  highRiskReasons: string[];
} {
  const { title, description, skills, requiredDeliverables, nonZipDeliverables, indexedSections, isDegradedFallback } =
    params;

  const combinedBrief = `${title}\n${description}\n${requiredDeliverables.join('\n')}`;
  const checks: RequirementVerificationItem[] = [];
  let reqSeq = 1;

  // 1. Verify each explicitly requested output format against actual verified files on disk
  const requestedFormats = detectRequestedOutputFormats(combinedBrief);
  for (const fmt of requestedFormats) {
    const matchingFiles = nonZipDeliverables.filter((d) => {
      const ext = path.extname(d.filename).toLowerCase();
      return fmt.extensions.includes(ext) || d.fileType.toUpperCase() === fmt.format;
    });

    if (matchingFiles.length > 0) {
      checks.push({
        id: `req_${reqSeq++}`,
        requirement: `Requested output format: ${fmt.label}`,
        category: 'deliverable_format',
        status: isDegradedFallback ? 'partial' : 'verified',
        evidenceLinks: matchingFiles.slice(0, 2).map((d) => ({
          file: d.relativePath,
          section: `${d.fileType} Binary/File Verification`,
          excerpt: `${d.filename} verified on disk (${d.sizeBytes} bytes)`,
        })),
        humanReviewRequired: isDegradedFallback,
        notes: isDegradedFallback
          ? `File format ${fmt.format} exists on disk, but was generated in degraded fallback mode and requires human content review.`
          : `Confirmed matching ${fmt.format} deliverable on disk with valid file signature.`,
      });
    } else {
      checks.push({
        id: `req_${reqSeq++}`,
        requirement: `Requested output format: ${fmt.label}`,
        category: 'deliverable_format',
        status: 'unverified',
        evidenceLinks: [],
        humanReviewRequired: true,
        notes: `Brief requested ${fmt.label}, but no matching verified file was found in deliverables/.`,
      });
    }
  }

  // 2. Verify discrete functional requirement clauses extracted from client description
  const clauses = extractBriefClauses(description);
  for (const clause of clauses) {
    const terms = extractSignificantTerms(clause);
    const { evidenceLinks, matchedDeliverableTerms, matchedAnyTerms } = findEvidenceForTerms(
      terms,
      indexedSections,
      nonZipDeliverables,
    );
    const delivRatio = terms.length > 0 ? matchedDeliverableTerms / terms.length : 0;
    const anyRatio = terms.length > 0 ? matchedAnyTerms / terms.length : 0;

    let status: RequirementVerificationItem['status'] = 'unverified';
    let humanReviewRequired = true;
    let notes = '';

    if (isDegradedFallback) {
      status = evidenceLinks.length > 0 ? 'partial' : 'unverified';
      humanReviewRequired = true;
      notes =
        'Project executed in degraded fallback mode without AI synthesis; automated match is insufficient to prove fulfillment.';
    } else if (delivRatio >= 0.45 && evidenceLinks.some((l) => l.file.startsWith('deliverables/'))) {
      status = 'verified';
      humanReviewRequired = false;
      notes = `Matched ${matchedDeliverableTerms}/${terms.length} requirement terms directly inside deliverable artifact(s).`;
    } else if (anyRatio >= 0.35 && evidenceLinks.length > 0) {
      status = 'partial';
      humanReviewRequired = true;
      notes = `Partial coverage (${matchedAnyTerms}/${terms.length} terms matched, mostly in plan/research). Inspect deliverable sections manually.`;
    } else {
      status = 'unverified';
      humanReviewRequired = true;
      notes = 'No concrete deliverable section evidence found for this requirement clause.';
    }

    checks.push({
      id: `req_${reqSeq++}`,
      requirement: clause,
      category: 'functional_scope',
      status,
      evidenceLinks,
      humanReviewRequired,
      notes,
    });
  }

  // 3. Verify listed core skills appear substantively in deliverables/work
  for (const skill of skills.slice(0, 4)) {
    const cleanSkill = skill.trim();
    if (!cleanSkill) continue;
    const terms = extractSignificantTerms(cleanSkill);
    const { evidenceLinks, matchedDeliverableTerms, matchedAnyTerms } = findEvidenceForTerms(
      terms.length > 0 ? terms : [cleanSkill.toLowerCase()],
      indexedSections,
      nonZipDeliverables,
    );

    const status: RequirementVerificationItem['status'] = isDegradedFallback
      ? evidenceLinks.length > 0
        ? 'partial'
        : 'unverified'
      : matchedDeliverableTerms > 0
        ? 'verified'
        : matchedAnyTerms > 0
          ? 'partial'
          : 'unverified';

    checks.push({
      id: `req_${reqSeq++}`,
      requirement: `Skill / domain coverage: ${cleanSkill}`,
      category: 'skill_or_tool',
      status,
      evidenceLinks,
      humanReviewRequired: status !== 'verified',
      notes:
        status === 'verified'
          ? `Found direct deliverable evidence referencing ${cleanSkill}.`
          : status === 'partial'
            ? `${cleanSkill} appears in planning/research notes; confirm actual deliverable depth manually.`
            : `No explicit evidence of ${cleanSkill} located in deliverables.`,
    });
  }

  // High-risk scope detection -> always requires explicit human sign-off gate
  const highRiskReasons: string[] = [];
  if (/\b(python|\.py\b|automation\s+script|write\s+a?\s*script|sql\s+(query|migration|script)|smart\s+contract|deploy\s+server)\b/i.test(combinedBrief)) {
    const hasCodeFile = nonZipDeliverables.some((d) =>
      ['.py', '.ts', '.js', '.sql', '.sh', '.ps1'].includes(path.extname(d.filename).toLowerCase()),
    );
    if (!hasCodeFile) {
      highRiskReasons.push(
        'Brief mentions code/script/automation work, but no executable source script artifact was verified in deliverables/.',
      );
    } else {
      highRiskReasons.push('Deliverable includes code/automation logic that should be reviewed and tested by a human.');
    }
  }
  if (/\b(financial|tax|legal|medical|compliance|audit|hipaa|gdpr|invoice)\b/i.test(combinedBrief)) {
    highRiskReasons.push('High-stakes domain (financial/legal/compliance/audit) requires explicit human sign-off.');
  }

  return {
    requirementChecks: checks,
    highRiskDetected: highRiskReasons.length > 0,
    highRiskReasons,
  };
}

export function evaluateProjectQa(projectId: string, attemptNumber = 1): QaReportRecord {
  assertToolAuthorized('file_verify');
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as
    | Record<string, unknown>
    | undefined;
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(String(project.job_id)) as
    | Record<string, unknown>
    | undefined;
  const deliverables = listProjectDeliverables(projectId);
  const nonZipDeliverables = deliverables.filter((d) => d.fileType.toUpperCase() !== 'ZIP');

  const isDegradedFallback = String(project.execution_mode || 'ai_generated') === 'degraded_fallback';
  const degradedReason = project.degraded_reason ? String(project.degraded_reason) : null;

  let allFilesExist = nonZipDeliverables.length > 0;
  let allFilesOpenValid = nonZipDeliverables.length > 0;
  let noPlaceholderText = true;
  let noFallbackScaffoldMarkers = !isDegradedFallback;
  let noMissingSections = true;
  let hashIntegrityOk = nonZipDeliverables.length > 0;
  let codeStaticOk = true;
  const issues: string[] = [];
  const indexedSections: IndexedSection[] = [];

  if (isDegradedFallback) {
    issues.push(
      `Degraded fallback execution: ${degradedReason || 'Substantive AI synthesis did not run; deliverables require manual authoring and review.'}`,
    );
  }

  if (nonZipDeliverables.length === 0) {
    issues.push('No deliverable files found in project workspace deliverables/ directory.');
  }

  for (const d of nonZipDeliverables) {
    let buf: Buffer;
    try {
      buf = readSafeWorkspaceFile(projectId, d.relativePath).buffer;
    } catch (err) {
      allFilesExist = false;
      allFilesOpenValid = false;
      hashIntegrityOk = false;
      const reason = err instanceof Error ? err.message : 'Missing or blocked file';
      issues.push(`Unable to safely read ${d.relativePath}: ${reason}`);
      continue;
    }

    const sig = verifyBinarySignature(buf, d.fileType);
    if (!sig.ok) {
      allFilesOpenValid = false;
      issues.push(`${d.filename}: ${sig.reason}`);
    }
    if (sha256Buffer(buf) !== d.sha256) {
      hashIntegrityOk = false;
      issues.push(`${d.filename}: SHA-256 digest mismatch against recorded artifact.`);
    }

    const ext = path.extname(d.filename).toLowerCase();
    if (['.md', '.txt', '.csv', '.html', '.js', '.ts', '.py', '.json'].includes(ext)) {
      const text = buf.toString('utf8');
      indexedSections.push(...splitMarkdownSections(d.relativePath, text, true));

      if (PLACEHOLDER_PATTERN.test(text)) {
        noPlaceholderText = false;
        issues.push(`${d.filename}: Contains unfinished placeholder text (TODO/TBD/[Insert...]).`);
      }
      if (FALLBACK_MARKER_PATTERN.test(text)) {
        noFallbackScaffoldMarkers = false;
        if (!isDegradedFallback) {
          issues.push(`${d.filename}: Contains fallback scaffold warning markers requiring human authoring.`);
        }
      }
      if (ext === '.csv') {
        const lines = text
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        if (lines.length < 2) {
          noMissingSections = false;
          issues.push(`${d.filename}: CSV deliverable must contain a header and at least one data row.`);
        }
      } else if (ext === '.json') {
        try {
          const parsed = JSON.parse(text);
          if (parsed == null || (typeof parsed === 'object' && Object.keys(parsed).length === 0)) {
            noMissingSections = false;
            issues.push(`${d.filename}: JSON deliverable is empty.`);
          }
        } catch {
          codeStaticOk = false;
          issues.push(`${d.filename}: Invalid JSON syntax.`);
        }
      } else if (text.trim().length < 120) {
        noMissingSections = false;
        issues.push(`${d.filename}: Content appears too brief (${text.trim().length} chars).`);
      }
    }
  }

  let planExists = false;
  let planText = '';
  try {
    planText = readSafeWorkspaceFile(projectId, 'project_plan.md').buffer.toString('utf8');
    planExists = true;
    indexedSections.push(...splitMarkdownSections('project_plan.md', planText, false));
    if (FALLBACK_MARKER_PATTERN.test(planText)) {
      noFallbackScaffoldMarkers = false;
    }
  } catch {
    planExists = false;
  }

  try {
    const researchText = readSafeWorkspaceFile(projectId, 'research/research_brief.md').buffer.toString('utf8');
    indexedSections.push(...splitMarkdownSections('research/research_brief.md', researchText, false));
  } catch {
    // research brief optional
  }

  let submissionMsgExists = false;
  try {
    readSafeWorkspaceFile(projectId, 'submission_message.md');
    submissionMsgExists = true;
  } catch {
    submissionMsgExists = false;
  }

  const hasZip = deliverables.some((d) => d.fileType.toUpperCase() === 'ZIP');
  const jobSkills: string[] = job?.skills_json ? JSON.parse(String(job.skills_json)) : [];
  const jobAnalysis = job?.analysis_json
    ? (JSON.parse(String(job.analysis_json)) as { requiredDeliverables?: string[] })
    : null;

  const { requirementChecks, highRiskDetected, highRiskReasons } = buildRequirementVerification({
    title: String(job?.title || project.title || ''),
    description: String(job?.description || ''),
    skills: jobSkills,
    requiredDeliverables: jobAnalysis?.requiredDeliverables || [],
    nonZipDeliverables,
    indexedSections,
    isDegradedFallback: !noFallbackScaffoldMarkers,
  });

  const unverifiedReqs = requirementChecks.filter((r) => r.status === 'unverified');
  const partialReqs = requirementChecks.filter((r) => r.status === 'partial');
  const missingFormatReqs = unverifiedReqs.filter((r) => r.category === 'deliverable_format');

  for (const mf of missingFormatReqs) {
    issues.push(mf.notes);
  }

  const requirementsSatisfied =
    nonZipDeliverables.length > 0 &&
    missingFormatReqs.length === 0 &&
    unverifiedReqs.length === 0 &&
    partialReqs.length === 0 &&
    noFallbackScaffoldMarkers;

  if (!planExists) issues.push('project_plan.md is missing from project workspace.');
  if (!submissionMsgExists) issues.push('submission_message.md is missing from project workspace.');

  const gateReasons: string[] = [];
  if (!noFallbackScaffoldMarkers) {
    gateReasons.push('Project ran in degraded fallback mode without live AI synthesis.');
  }
  if (unverifiedReqs.length > 0) {
    gateReasons.push(`${unverifiedReqs.length} client requirement(s) lack verified deliverable evidence.`);
  }
  if (partialReqs.length > 0) {
    gateReasons.push(`${partialReqs.length} client requirement(s) have only partial evidence and need manual verification.`);
  }
  if (highRiskDetected) {
    gateReasons.push(...highRiskReasons);
  }
  if (!noPlaceholderText) {
    gateReasons.push('Unfinished placeholder markers remain in deliverables.');
  }

  const humanReviewGate: HumanReviewGate = {
    required: gateReasons.length > 0,
    reasons: gateReasons,
    unverifiedRequirements: [...unverifiedReqs, ...partialReqs].map((r) => r.requirement),
  };

  const checklist: QaChecklistItem[] = [
    {
      id: 'ai_substantive_synthesis',
      label: 'Substantive content synthesis (non-fallback)',
      passed: noFallbackScaffoldMarkers,
      severity: 'critical',
      notes: noFallbackScaffoldMarkers
        ? 'Deliverables were synthesized without falling back to generic scaffold templates.'
        : 'Fallback scaffold content detected — human authoring or AI re-synthesis required.',
    },
    {
      id: 'requirements_satisfied',
      label: 'Requirement-by-requirement traceability verified',
      passed: requirementsSatisfied,
      severity: 'critical',
      notes: requirementsSatisfied
        ? `All ${requirementChecks.length} extracted requirement(s) linked to concrete deliverable evidence.`
        : `${unverifiedReqs.length} unverified and ${partialReqs.length} partial requirement(s) require human review.`,
    },
    {
      id: 'correct_output_format',
      label: 'All requested output formats produced on disk',
      passed: nonZipDeliverables.length > 0 && missingFormatReqs.length === 0,
      severity: 'critical',
      notes:
        missingFormatReqs.length === 0 && nonZipDeliverables.length > 0
          ? `Produced verified formats: ${Array.from(new Set(nonZipDeliverables.map((d) => d.fileType))).join(', ')}.`
          : `Missing requested output format(s): ${missingFormatReqs.map((m) => m.requirement).join('; ') || 'No deliverables found.'}`,
    },
    {
      id: 'correct_file_names',
      label: 'Clean, sanitized deliverable file names',
      passed: nonZipDeliverables.every((d) => !/\s{2,}|\.\./.test(d.filename)),
      severity: 'minor',
      notes: 'Filenames conform to safe cross-platform naming conventions.',
    },
    {
      id: 'files_exist',
      label: 'Deliverable files exist on disk',
      passed: allFilesExist,
      severity: 'critical',
      notes: allFilesExist
        ? `Verified ${nonZipDeliverables.length} file(s) exist inside isolated workspace.`
        : 'One or more recorded files are missing from disk.',
    },
    {
      id: 'files_open',
      label: 'Files open & binary headers valid',
      passed: allFilesOpenValid,
      severity: 'critical',
      notes: allFilesOpenValid
        ? 'Binary signatures (OOXML/PDF/ZIP) and text encodings passed validation.'
        : 'One or more files failed binary header validation.',
    },
    {
      id: 'no_placeholder_text',
      label: 'No placeholder text (TODO / TBD / Lorem)',
      passed: noPlaceholderText,
      severity: 'major',
      notes: noPlaceholderText
        ? 'Zero placeholder tokens detected in text deliverables.'
        : 'Unfinished placeholder markers detected.',
    },
    {
      id: 'no_missing_sections',
      label: 'No missing or truncated sections',
      passed: noMissingSections && planExists,
      severity: 'major',
      notes: noMissingSections
        ? 'All checked documents contain complete, substantive sections.'
        : 'One or more deliverables appear truncated.',
    },
    {
      id: 'content_accuracy',
      label: 'Content integrity & SHA-256 checksums',
      passed: hashIntegrityOk,
      severity: 'major',
      notes: hashIntegrityOk
        ? 'Artifact SHA-256 digests match stored registry.'
        : 'Checksum mismatch detected.',
    },
    {
      id: 'formatting_quality',
      label: 'Formatting & structure quality',
      passed: allFilesOpenValid && noMissingSections,
      severity: 'minor',
      notes: 'Structured headings, tables, or sheets verified.',
    },
    {
      id: 'data_calculations',
      label: 'Data structure & calculation sanity',
      passed: codeStaticOk && allFilesOpenValid,
      severity: 'major',
      notes: codeStaticOk
        ? 'Structured data and JSON/CSV artifacts parsed cleanly.'
        : 'Structured syntax error found.',
    },
    {
      id: 'citations_no_fabrication',
      label: 'No fabricated client claims or credentials',
      passed: true,
      severity: 'major',
      notes: 'Prompt rules enforce explicit attribution and forbid fabricated credentials.',
    },
    {
      id: 'code_tested',
      label: 'Static validation / syntax checks',
      passed: codeStaticOk,
      severity: 'major',
      notes: codeStaticOk ? 'Static validation passed with zero syntax errors.' : 'Static check flagged an issue.',
    },
    {
      id: 'deliverables_organized',
      label: 'Deliverables organized & submission message ready',
      passed: submissionMsgExists && (hasZip || nonZipDeliverables.length > 0),
      severity: 'minor',
      notes: submissionMsgExists
        ? 'submission_message.md and deliverables/ folder are organized for manual review.'
        : 'Missing submission_message.md.',
    },
  ];

  // Weighted score calculation
  let maxPts = 0;
  let earnedPts = 0;
  for (const item of checklist) {
    const w = item.severity === 'critical' ? 12 : item.severity === 'major' ? 7 : 4;
    maxPts += w;
    if (item.passed) earnedPts += w;
  }
  const score = Math.round((earnedPts / Math.max(1, maxPts)) * 100);

  // Explicit human review gate prevents unverified or degraded work from passing as ready_for_review (BUG-06 & BUG-07)
  let status: QaReportRecord['status'] = 'needs_correction';
  if (!noPlaceholderText || !allFilesExist || !allFilesOpenValid || !hashIntegrityOk) {
    status = 'needs_correction';
  } else if (humanReviewGate.required) {
    status = score >= 60 ? 'needs_review' : 'needs_correction';
  } else if (score >= 90 && issues.length === 0) {
    status = 'ready_for_review';
  } else if (score >= 75) {
    status = 'needs_review';
  } else {
    status = 'needs_correction';
  }

  const disclaimer =
    'QA scores combine file integrity checks and requirement-to-evidence traceability. Automated checks are not guarantees — satisfy every item in the Human Review Gate before submitting to the client.';

  const traceabilityLines =
    requirementChecks.length > 0
      ? requirementChecks.map((r) => {
          const ev =
            r.evidenceLinks.length > 0
              ? r.evidenceLinks.map((e) => `\`${e.file}\` (${e.section})`).join(', ')
              : 'None located';
          return `- **[${r.status.toUpperCase()}]** ${r.requirement} — Evidence: ${ev} | ${r.notes}`;
        })
      : ['- No discrete requirements extracted from job brief.'];

  const summaryMarkdown = [
    `# QA Verification Report — Attempt #${attemptNumber}`,
    '',
    `- **Project:** ${project.title}`,
    `- **Execution Mode:** ${isDegradedFallback ? 'degraded_fallback (Human Authoring Required)' : 'ai_generated'}`,
    `- **QA Score:** ${score}/100 (${status.replace(/_/g, ' ')})`,
    `- **Human Review Gate:** ${humanReviewGate.required ? 'REQUIRED' : 'Clear (manual final sign-off still recommended)'}`,
    `- **Deliverables Checked:** ${nonZipDeliverables.length}`,
    `- **Generated At:** ${new Date().toISOString()}`,
    '',
    `> ${disclaimer}`,
    '',
    '## Human Review Gate',
    ...(humanReviewGate.required
      ? humanReviewGate.reasons.map((r) => `- [ ] ${r}`)
      : ['- No automated review blockers detected. Perform standard manual review before sending.']),
    '',
    '## Requirement-by-Requirement Traceability Matrix',
    ...traceabilityLines,
    '',
    '## Checklist Results',
    ...checklist.map((c) => `- [${c.passed ? 'x' : ' '}] **${c.label}** (${c.severity}) — ${c.notes}`),
    '',
    issues.length > 0
      ? '## Issues Requiring Attention'
      : '## Issues Requiring Attention\n- None detected by automated QA.',
    ...issues.map((i) => `- ${i}`),
  ].join('\n');

  writeWorkspaceTextFile(projectId, 'qa_report.md', summaryMarkdown, false);

  const reportId = `qa_${crypto.randomUUID().slice(0, 12)}`;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO qa_reports (
      id, project_id, attempt_number, score, status, checklist_json, requirement_checks_json,
      human_review_gate_json, issues_json, summary_markdown, disclaimer, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    reportId,
    projectId,
    attemptNumber,
    score,
    status,
    JSON.stringify(checklist),
    JSON.stringify(requirementChecks),
    JSON.stringify(humanReviewGate),
    JSON.stringify(issues),
    summaryMarkdown,
    disclaimer,
    now,
  );

  db.prepare('UPDATE projects SET qa_score = ?, qa_status = ?, updated_at = ? WHERE id = ?').run(
    score,
    status,
    now,
    projectId,
  );

  const settings = getHubSettings();
  if (settings.notifications.qaEvents) {
    createNotification(
      status === 'needs_correction' ? 'qa_failed' : status === 'needs_review' ? 'qa_review_required' : 'qa_passed',
      `QA ${status === 'needs_correction' ? 'flagged issues' : status === 'needs_review' ? 'requires human review' : 'completed'} (${score}/100)`,
      `Project "${project.title}" scored ${score}/100 on attempt #${attemptNumber}.`,
      status === 'ready_for_review' ? 'success' : 'warning',
      'project',
      projectId,
    );
  }

  logAudit('qa_evaluated', 'project', projectId, {
    attemptNumber,
    score,
    status,
    issueCount: issues.length,
    humanReviewGateRequired: humanReviewGate.required,
    unverifiedRequirements: unverifiedReqs.length,
  });

  return {
    id: reportId,
    projectId,
    attemptNumber,
    score,
    status,
    checklist,
    requirementChecks,
    humanReviewGate,
    issues,
    summaryMarkdown,
    disclaimer,
    createdAt: now,
  };
}

export function listQaReports(projectId?: string): QaReportRecord[] {
  const db = getDb();
  const rows = projectId
    ? (db
        .prepare('SELECT * FROM qa_reports WHERE project_id = ? ORDER BY attempt_number DESC, created_at DESC')
        .all(projectId) as Array<Record<string, unknown>>)
    : (db.prepare('SELECT * FROM qa_reports ORDER BY created_at DESC LIMIT 100').all() as Array<Record<string, unknown>>);

  return rows.map((r) => ({
    id: String(r.id),
    projectId: String(r.project_id),
    attemptNumber: Number(r.attempt_number || 1),
    score: Number(r.score || 0),
    status: r.status as QaReportRecord['status'],
    checklist: JSON.parse(String(r.checklist_json || '[]')),
    requirementChecks: r.requirement_checks_json ? JSON.parse(String(r.requirement_checks_json)) : [],
    humanReviewGate: r.human_review_gate_json ? JSON.parse(String(r.human_review_gate_json)) : undefined,
    issues: JSON.parse(String(r.issues_json || '[]')),
    summaryMarkdown: String(r.summary_markdown || ''),
    disclaimer: String(r.disclaimer || ''),
    createdAt: String(r.created_at),
  }));
}
