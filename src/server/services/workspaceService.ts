import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Archiver } from 'archiver';
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx';
import PDFDocument from 'pdfkit';
import PptxGenJS from 'pptxgenjs';
import * as XLSX from 'xlsx';

const require = createRequire(import.meta.url);

function createZipArchive(): Archiver {
  const mod: unknown = require('archiver');
  const opts = { zlib: { level: 9 } };
  if (typeof mod === 'function') {
    return (mod as (format: 'zip', options?: { zlib?: { level?: number } }) => Archiver)('zip', opts);
  }
  if (mod && typeof mod === 'object') {
    const obj = mod as Record<string, unknown>;
    if (typeof obj.ZipArchive === 'function') {
      const ZipCtor = obj.ZipArchive as new (options?: { zlib?: { level?: number } }) => Archiver;
      return new ZipCtor(opts);
    }
    if (typeof obj.default === 'function') {
      const fn = obj.default as (format: 'zip', options?: { zlib?: { level?: number } }) => Archiver;
      return fn('zip', opts);
    }
  }
  throw new Error('Unsupported archiver module export format');
}

import { getDb, logAudit } from '../db/database.ts';
import {
  assertToolAuthorized,
  getProjectWorkspaceRoot,
  readSafeWorkspaceFile,
  resolveSafeWorkspacePath,
  sanitizePathSegment,
  writeSafeWorkspaceFile,
} from '../security.ts';
import type { DeliverableRecord } from '../../shared/types.ts';

const WORKSPACE_SUBDIRS = [
  'requirements',
  'research',
  'source_data',
  'working_files',
  'deliverables',
  'tests',
  'reports',
  'logs',
];

export function initProjectWorkspace(projectId: string): string {
  const root = getProjectWorkspaceRoot(projectId);
  fs.mkdirSync(root, { recursive: true });
  for (const sub of WORKSPACE_SUBDIRS) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  return root;
}

export function sha256Buffer(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function registerDeliverable(
  projectId: string,
  relativePath: string,
  fileType: string,
  buf: Buffer,
  verified = true,
): DeliverableRecord {
  const db = getDb();
  const id = `del_${crypto.randomUUID().slice(0, 12)}`;
  const filename = path.basename(relativePath);
  const sha = sha256Buffer(buf);
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO deliverables (id, project_id, filename, relative_path, file_type, size_bytes, verified, sha256, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, relative_path) DO UPDATE SET
      file_type = excluded.file_type,
      size_bytes = excluded.size_bytes,
      verified = excluded.verified,
      sha256 = excluded.sha256,
      created_at = excluded.created_at
  `).run(id, projectId, filename, relativePath, fileType, buf.length, verified ? 1 : 0, sha, now);

  const row = db
    .prepare('SELECT * FROM deliverables WHERE project_id = ? AND relative_path = ?')
    .get(projectId, relativePath) as Record<string, unknown>;

  return mapDeliverableRow(row);
}

export function mapDeliverableRow(row: Record<string, unknown>): DeliverableRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    filename: String(row.filename),
    relativePath: String(row.relative_path),
    fileType: String(row.file_type),
    sizeBytes: Number(row.size_bytes || 0),
    verified: Boolean(row.verified),
    sha256: String(row.sha256),
    createdAt: String(row.created_at),
  };
}

export function writeWorkspaceTextFile(
  projectId: string,
  relativePath: string,
  content: string,
  recordAsDeliverable = false,
): { absolutePath: string; sizeBytes: number; sha256: string; deliverable?: DeliverableRecord } {
  assertToolAuthorized('workspace_write');
  const { absolutePath: abs, buffer: buf } = writeSafeWorkspaceFile(projectId, relativePath, content);

  const ext = path.extname(relativePath).replace('.', '').toUpperCase() || 'TXT';
  const deliverable = recordAsDeliverable
    ? registerDeliverable(projectId, relativePath.replace(/\\/g, '/'), ext, buf, true)
    : undefined;

  return {
    absolutePath: abs,
    sizeBytes: buf.length,
    sha256: sha256Buffer(buf),
    deliverable,
  };
}

export async function generateDocxDeliverable(
  projectId: string,
  filename: string,
  docInput: {
    title: string;
    subtitle: string;
    sections: Array<{ heading: string; paragraphs: string[] }>;
    summaryTable?: Array<[string, string]>;
  },
): Promise<DeliverableRecord> {
  assertToolAuthorized('generate_docx');
  const safeName = sanitizePathSegment(filename.endsWith('.docx') ? filename : `${filename}.docx`);
  const relPath = `deliverables/${safeName}`;
  const absPath = resolveSafeWorkspacePath(projectId, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });

  const children: Array<Paragraph | Table> = [
    new Paragraph({ text: docInput.title, heading: HeadingLevel.TITLE }),
    new Paragraph({
      children: [new TextRun({ text: docInput.subtitle, italics: true, color: '475569' })],
      spacing: { after: 280 },
    }),
  ];

  for (const sec of docInput.sections) {
    children.push(
      new Paragraph({
        text: sec.heading,
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 240, after: 120 },
      }),
    );
    for (const para of sec.paragraphs) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: para })],
          spacing: { after: 120 },
        }),
      );
    }
  }

  if (docInput.summaryTable && docInput.summaryTable.length > 0) {
    children.push(
      new Paragraph({
        text: 'Deliverable Summary Matrix',
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 240, after: 120 },
      }),
    );
    children.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: docInput.summaryTable.map(
          ([k, v]) =>
            new TableRow({
              children: [
                new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: k, bold: true })] })] }),
                new TableCell({ children: [new Paragraph({ text: v })] }),
              ],
            }),
        ),
      }),
    );
  }

  const doc = new Document({
    sections: [{ properties: {}, children }],
  });
  const buf = await Packer.toBuffer(doc);
  writeSafeWorkspaceFile(projectId, relPath, buf);
  return registerDeliverable(projectId, relPath, 'DOCX', buf, true);
}

export function generateXlsxDeliverable(
  projectId: string,
  filename: string,
  sheets: Array<{ name: string; rows: Array<Array<string | number>> }>,
): DeliverableRecord {
  assertToolAuthorized('generate_xlsx');
  const safeName = sanitizePathSegment(filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`);
  const relPath = `deliverables/${safeName}`;

  const wb = XLSX.utils.book_new();
  for (const sheet of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(sheet.rows);
    XLSX.utils.book_append_sheet(wb, ws, sheet.name.slice(0, 31));
  }
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  writeSafeWorkspaceFile(projectId, relPath, buf);
  return registerDeliverable(projectId, relPath, 'XLSX', buf, true);
}

export function generateCsvDeliverable(
  projectId: string,
  filename: string,
  rows: Array<Array<string | number>>,
): DeliverableRecord {
  assertToolAuthorized('generate_csv');
  const safeName = sanitizePathSegment(filename.endsWith('.csv') ? filename : `${filename}.csv`);
  const relPath = `deliverables/${safeName}`;
  const escapeCell = (val: string | number) => {
    const str = String(val ?? '');
    if (/[",\n\r]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };
  const csvContent = rows.map((r) => r.map(escapeCell).join(',')).join('\r\n') + '\r\n';
  const written = writeWorkspaceTextFile(projectId, relPath, csvContent, true);
  return written.deliverable!;
}

export async function generatePdfDeliverable(
  projectId: string,
  filename: string,
  pdfInput: {
    title: string;
    subtitle: string;
    sections: Array<{ heading: string; body: string }>;
  },
): Promise<DeliverableRecord> {
  assertToolAuthorized('generate_pdf');
  const safeName = sanitizePathSegment(filename.endsWith('.pdf') ? filename : `${filename}.pdf`);
  const relPath = `deliverables/${safeName}`;
  const absPath = resolveSafeWorkspacePath(projectId, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });

  const buf = await new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(20).fillColor('#0f172a').text(pdfInput.title);
    doc.moveDown(0.3);
    doc.fontSize(10).fillColor('#475569').text(pdfInput.subtitle);
    doc.moveDown(1);

    for (const sec of pdfInput.sections) {
      doc.fontSize(13).fillColor('#0284c7').text(sec.heading);
      doc.moveDown(0.3);
      doc.fontSize(10.5).fillColor('#1e293b').text(sec.body, { lineGap: 3 });
      doc.moveDown(0.9);
    }

    doc.end();
  });

  writeSafeWorkspaceFile(projectId, relPath, buf);
  return registerDeliverable(projectId, relPath, 'PDF', buf, true);
}

export async function generatePptxDeliverable(
  projectId: string,
  filename: string,
  slides: Array<{ title: string; bullets: string[] }>,
): Promise<DeliverableRecord> {
  assertToolAuthorized('generate_pptx');
  const safeName = sanitizePathSegment(filename.endsWith('.pptx') ? filename : `${filename}.pptx`);
  const relPath = `deliverables/${safeName}`;
  const absPath = resolveSafeWorkspacePath(projectId, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });

  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';

  for (const s of slides) {
    const slide = pptx.addSlide();
    slide.background = { color: '0B1221' };
    slide.addText(s.title, {
      x: 0.6,
      y: 0.5,
      w: 8.8,
      h: 0.8,
      fontSize: 24,
      bold: true,
      color: '22D3EE',
      fontFace: 'Arial',
    });
    slide.addText(
      s.bullets.map((b) => ({ text: b, options: { bullet: true, breakLine: true } })),
      {
        x: 0.7,
        y: 1.5,
        w: 8.6,
        h: 3.6,
        fontSize: 15,
        color: 'E2E8F0',
        fontFace: 'Arial',
        paraSpaceAfter: 10,
      },
    );
  }

  const out = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
  writeSafeWorkspaceFile(projectId, relPath, out);
  return registerDeliverable(projectId, relPath, 'PPTX', out, true);
}

const BLOCKED_CLIENT_PACKAGE_PATTERNS = [
  /^plan\.md$/i,
  /^project_plan\.md$/i,
  /^qa_report.*\.md$/i,
  /^degraded_generation_notice\.md$/i,
  /^qa_remediation_action_items\.md$/i,
  /^agent_logs/i,
  /^internal_/i,
  /\.log$/i,
  /^\.env(\..+)?$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.netrc$/i,
  /^\.git-credentials$/i,
  /\.key$/i,
  /\.pem$/i,
  /\.db$/i,
  /\.sqlite3?$/i,
  /cookies/i,
];

function isBlockedFromClientPackage(relOrName: string): boolean {
  const normalized = relOrName.replace(/\\/g, '/');
  const base = path.posix.basename(normalized);
  return BLOCKED_CLIENT_PACKAGE_PATTERNS.some((rx) => rx.test(base) || rx.test(normalized));
}

export async function packageProjectDeliverablesZip(
  projectId: string,
  validatedRelativePaths?: string[],
): Promise<DeliverableRecord> {
  assertToolAuthorized('create_zip');
  const deliverablesDir = resolveSafeWorkspacePath(projectId, 'deliverables');
  const zipRelPath = `deliverables/${sanitizePathSegment(projectId)}_package.zip`;

  const filesToPack: Array<{ buffer: Buffer; name: string }> = [];
  if (Array.isArray(validatedRelativePaths) && validatedRelativePaths.length > 0) {
    for (const rel of validatedRelativePaths) {
      const normalized = rel.replace(/\\/g, '/').replace(/^\/+/, '');
      if (normalized.endsWith('.zip') || isBlockedFromClientPackage(normalized)) continue;
      const safeRead = readSafeWorkspaceFile(projectId, normalized);
      const archiveName = normalized.startsWith('deliverables/')
        ? normalized.slice('deliverables/'.length)
        : path.posix.basename(normalized);
      filesToPack.push({ buffer: safeRead.buffer, name: archiveName });
    }
  } else if (fs.existsSync(deliverablesDir)) {
    for (const entry of fs.readdirSync(deliverablesDir, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || !entry.isFile()) continue;
      if (entry.name.endsWith('.zip') || isBlockedFromClientPackage(entry.name)) continue;
      const safeRead = readSafeWorkspaceFile(projectId, `deliverables/${entry.name}`);
      filesToPack.push({ buffer: safeRead.buffer, name: entry.name });
    }
  }

  // Include client-facing submission_message.md if present (never include internal qa_report.md or logs)
  try {
    const safeRead = readSafeWorkspaceFile(projectId, 'submission_message.md');
    if (!filesToPack.some((f) => f.name === 'submission_message.md')) {
      filesToPack.push({ buffer: safeRead.buffer, name: 'submission_message.md' });
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      throw err;
    }
  }

  // Build ZIP in memory from already-verified buffers, then atomically write via O_NOFOLLOW safe write
  const zipBuf = await new Promise<Buffer>((resolve, reject) => {
    const archive = createZipArchive();
    const chunks: Buffer[] = [];
    archive.on('data', (chunk: Buffer) => chunks.push(chunk));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);
    for (const f of filesToPack) {
      archive.append(f.buffer, { name: f.name });
    }
    void archive.finalize();
  });

  writeSafeWorkspaceFile(projectId, zipRelPath, zipBuf);
  const record = registerDeliverable(projectId, zipRelPath, 'ZIP', zipBuf, true);
  logAudit('deliverables_zip_packaged', 'project', projectId, {
    fileCount: filesToPack.length,
    zipSizeBytes: zipBuf.length,
  });
  return record;
}

export function listWorkspaceTree(projectId: string): Array<{
  relativePath: string;
  filename: string;
  folder: string;
  sizeBytes: number;
  updatedAt: string;
  previewable: boolean;
}> {
  const root = getProjectWorkspaceRoot(projectId);
  if (!fs.existsSync(root)) return [];

  const results: Array<{
    relativePath: string;
    filename: string;
    folder: string;
    sizeBytes: number;
    updatedAt: string;
    previewable: boolean;
  }> = [];

  const walk = (dir: string, relPrefix: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      // Never traverse or expose symbolic links inside isolated workspaces
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.isFile()) {
        const stat = fs.lstatSync(full);
        if (stat.isSymbolicLink()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        const previewable = ['.md', '.txt', '.csv', '.json', '.html', '.ts', '.js', '.py', '.css', '.log'].includes(ext);
        results.push({
          relativePath: rel,
          filename: entry.name,
          folder: relPrefix || 'root',
          sizeBytes: stat.size,
          updatedAt: stat.mtime.toISOString(),
          previewable,
        });
      }
    }
  };

  walk(root, '');
  return results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export function previewWorkspaceFile(projectId: string, relativePath: string): {
  relativePath: string;
  filename: string;
  sizeBytes: number;
  previewable: boolean;
  content: string;
} {
  assertToolAuthorized('workspace_read');
  const ext = path.extname(relativePath).toLowerCase();
  const textExts = ['.md', '.txt', '.csv', '.json', '.html', '.ts', '.js', '.py', '.css', '.log'];
  const isText = textExts.includes(ext);

  let readRes: { buffer: Buffer; sizeBytes: number; absolutePath: string };
  try {
    readRes = readSafeWorkspaceFile(projectId, relativePath, isText ? 65536 : 32);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new Error(`Workspace file not found: ${relativePath}`);
    }
    throw err;
  }

  if (!isText) {
    const headerHex = readRes.buffer.subarray(0, 16).toString('hex');
    return {
      relativePath,
      filename: path.basename(readRes.absolutePath),
      sizeBytes: readRes.sizeBytes,
      previewable: false,
      content: `Binary deliverable (${ext.replace('.', '').toUpperCase()}, ${readRes.sizeBytes} bytes, header 0x${headerHex}). Download the file or ZIP bundle to open it in its native application.`,
    };
  }
  const content = readRes.buffer.toString('utf8').slice(0, 60000);
  return {
    relativePath,
    filename: path.basename(readRes.absolutePath),
    sizeBytes: readRes.sizeBytes,
    previewable: true,
    content,
  };
}

export function listProjectDeliverables(projectId: string): DeliverableRecord[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM deliverables WHERE project_id = ? ORDER BY created_at DESC')
    .all(projectId) as Array<Record<string, unknown>>;
  return rows.map(mapDeliverableRow);
}
