import path from 'node:path';
import zlib from 'node:zlib';
import * as XLSX from 'xlsx';
import type { SecretScanFinding, SecretScanReport } from '../../shared/types.ts';

export interface SecretScanOptions {
  maxArchiveBytes?: number;
  maxTotalDecompressedBytes?: number;
  maxEntries?: number;
  maxDepth?: number;
  maxCompressionRatio?: number;
  timeoutMs?: number;
}

const DEFAULT_LIMITS: Required<SecretScanOptions> = {
  maxArchiveBytes: 25 * 1024 * 1024, // 25 MB
  maxTotalDecompressedBytes: 50 * 1024 * 1024, // 50 MB
  maxEntries: 500,
  maxDepth: 3,
  maxCompressionRatio: 100,
  timeoutMs: 10_000,
};

const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.csv',
  '.tsv',
  '.html',
  '.htm',
  '.css',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.py',
  '.sh',
  '.bash',
  '.zsh',
  '.ps1',
  '.psm1',
  '.psd1',
  '.yaml',
  '.yml',
  '.xml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.env',
  '.sql',
  '.log',
  '.properties',
]);

interface SecretRule {
  id: string;
  category: string;
  riskLevel: SecretScanFinding['riskLevel'];
  regex: RegExp;
  contextHint: string;
}

const SECRET_RULES: SecretRule[] = [
  {
    id: 'private_key_block',
    category: 'private_key',
    riskLevel: 'critical',
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g,
    contextHint: 'PEM/OpenSSH private key header detected',
  },
  {
    id: 'aws_access_key',
    category: 'cloud_credential',
    riskLevel: 'critical',
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    contextHint: 'AWS access key identifier pattern',
  },
  {
    id: 'google_api_key',
    category: 'api_key',
    riskLevel: 'critical',
    regex: /\bAIza[0-9A-Za-z_-]{30,}\b/g,
    contextHint: 'Google/Gemini API key pattern',
  },
  {
    id: 'openai_or_stripe_key',
    category: 'api_key',
    riskLevel: 'critical',
    regex: /\b(?:sk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}|rk_live_[A-Za-z0-9]{20,})\b/g,
    contextHint: 'OpenAI / Stripe secret API key pattern',
  },
  {
    id: 'github_token',
    category: 'oauth_token',
    riskLevel: 'critical',
    regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
    contextHint: 'GitHub personal access or OAuth token',
  },
  {
    id: 'slack_token',
    category: 'oauth_token',
    riskLevel: 'high',
    regex: /\bxox[baprs]-[0-9A-Za-z-]{16,}\b/g,
    contextHint: 'Slack bot/user API token',
  },
  {
    id: 'database_connection_secret',
    category: 'database_credential',
    riskLevel: 'critical',
    regex: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|mssql):\/\/[^:\s/@"']+:[^@\s/"']{4,}@[^\s/"']+/gi,
    contextHint: 'Database connection URI containing embedded password',
  },
  {
    id: 'jwt_bearer_token',
    category: 'access_token',
    riskLevel: 'high',
    regex: /\beyJ[A-Za-z0-9_-]{12,}\.eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g,
    contextHint: 'Signed JSON Web Token (JWT)',
  },
  {
    id: 'env_secret_assignment',
    category: 'environment_secret',
    riskLevel: 'high',
    regex: /\b(?:HUB_SECRET_ENCRYPTION_KEY|GEMINI_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|FREELLM_API_KEY|DATABASE_URL|DB_PASSWORD|AWS_SECRET_ACCESS_KEY|OAUTH_CLIENT_SECRET|SESSION_SECRET|PRIVATE_TOKEN|ACCESS_TOKEN|API_SECRET|API_KEY|CLIENT_SECRET|PASSWORD)\s*[:=]\s*["']?([A-Za-z0-9_\-./+=@#$%^&*!]{8,})["']?/gi,
    contextHint: 'Secret or password assignment in configuration/code',
  },
  {
    id: 'bearer_auth_header',
    category: 'access_token',
    riskLevel: 'high',
    regex: /\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._-]{18,}\b/gi,
    contextHint: 'Hardcoded Bearer Authorization header',
  },
];

const PLACEHOLDER_VALUE_REGEX =
  /^(?:your[_-]|my[_-]|example|placeholder|changeme|replace[_-]|dummy|test[_-]?only|fake|xxxx+|0000+|\*+|<[^>]+>|\$\{[^}]+\})/i;

function redactSecret(raw: string): string {
  const clean = raw.replace(/\s+/g, ' ').trim();
  if (clean.length <= 10) return '****';
  return `${clean.slice(0, 6)}****${clean.slice(-3)}`;
}

function isLikelyPlaceholder(matchText: string, capturedValue?: string): boolean {
  const candidate = (capturedValue || matchText).trim();
  if (!candidate) return true;
  if (PLACEHOLDER_VALUE_REGEX.test(candidate)) return true;
  if (/MY_GEMINI_API_KEY|MY_APP_URL|YOUR_TOKEN|EXAMPLE_SECRET/i.test(matchText)) return true;
  return false;
}

function decodeXmlEntities(xml: string): string {
  return xml
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(Number(num)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function extractXmlText(xml: string): string {
  // Concatenate text runs without adding spaces inside split Word/Slide runs, while keeping paragraph breaks
  const withBreaks = xml
    .replace(/<\/(?:w:p|a:p|p|row|si|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeXmlEntities(withBreaks);
}

interface ScanState {
  startTime: number;
  limits: Required<SecretScanOptions>;
  timedOut: boolean;
  totalDecompressed: number;
  totalEntries: number;
  filesScanned: Set<string>;
  formatsInspected: Set<string>;
  unsupportedFormats: Array<{ file: string; format: string; reason: string }>;
  scanErrors: Array<{ file: string; error: string }>;
  findings: SecretScanFinding[];
  warnings: string[];
}

function checkTimeout(state: ScanState): boolean {
  if (Date.now() - state.startTime >= state.limits.timeoutMs) {
    if (!state.timedOut) {
      state.timedOut = true;
      state.warnings.push(`Secret scan timed out after ${state.limits.timeoutMs}ms; package requires human review.`);
    }
    return true;
  }
  return false;
}

function scanTextContent(text: string, fileLabel: string, location: string, state: ScanState): void {
  if (!text || checkTimeout(state)) return;

  for (const rule of SECRET_RULES) {
    rule.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    let hitsForRule = 0;
    while ((m = rule.regex.exec(text)) !== null && hitsForRule < 5) {
      hitsForRule++;
      const matched = m[0];
      const captured = m[1];
      if (isLikelyPlaceholder(matched, captured)) {
        state.warnings.push(
          `Possible placeholder credential in ${fileLabel} (${location}): ${rule.id} — verify it is not a real secret.`,
        );
        continue;
      }
      state.findings.push({
        file: fileLabel,
        location,
        category: rule.category,
        rule: rule.id,
        riskLevel: rule.riskLevel,
        redactedMatch: redactSecret(captured || matched),
        contextHint: rule.contextHint,
      });
    }
  }
}

interface ParsedZipEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  externalAttributes: number;
  isSymlink: boolean;
  isDirectory: boolean;
}

function hasArchivePathTraversal(entryName: string): boolean {
  const normalized = entryName.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return true;
  const parts = normalized.split('/');
  return parts.some((p) => p === '..');
}

function parseZipCentralDirectory(buf: Buffer): ParsedZipEntry[] {
  // Locate End of Central Directory record (signature 0x06054b50) within last 65KB
  const minPos = Math.max(0, buf.length - 65557);
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error('Invalid or corrupted ZIP archive (EOCD record not found)');
  }

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  if (cdOffset + cdSize > buf.length) {
    throw new Error('Corrupted ZIP central directory bounds');
  }

  const entries: ParsedZipEntry[] = [];
  let cursor = cdOffset;
  for (let i = 0; i < totalEntries && cursor + 46 <= buf.length; i++) {
    const sig = buf.readUInt32LE(cursor);
    if (sig !== 0x02014b50) break;

    const versionMadeBy = buf.readUInt16LE(cursor + 4);
    const compressionMethod = buf.readUInt16LE(cursor + 10);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const uncompressedSize = buf.readUInt32LE(cursor + 24);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const externalAttributes = buf.readUInt32LE(cursor + 38);
    const localHeaderOffset = buf.readUInt32LE(cursor + 42);

    const name = buf.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');
    const hostOs = versionMadeBy >> 8;
    const unixMode = (externalAttributes >>> 16) & 0o170000;
    const isSymlink = hostOs === 3 && unixMode === 0o120000;
    const isDirectory = name.endsWith('/');

    entries.push({
      name,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      externalAttributes,
      isSymlink,
      isDirectory,
    });

    cursor += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

function extractZipEntrySafe(buf: Buffer, entry: ParsedZipEntry, state: ScanState, archiveLabel: string): Buffer | null {
  if (entry.isDirectory) return null;
  if (entry.localHeaderOffset + 30 > buf.length || buf.readUInt32LE(entry.localHeaderOffset) !== 0x04034b50) {
    state.scanErrors.push({ file: `${archiveLabel}!${entry.name}`, error: 'Invalid ZIP local file header' });
    return null;
  }

  // Zip-bomb ratio check before inflating
  if (entry.compressedSize > 0 && entry.uncompressedSize > 1024) {
    const declaredRatio = entry.uncompressedSize / entry.compressedSize;
    if (declaredRatio > state.limits.maxCompressionRatio) {
      state.findings.push({
        file: archiveLabel,
        location: entry.name,
        category: 'archive_safety',
        rule: 'zip_bomb_ratio_exceeded',
        riskLevel: 'critical',
        redactedMatch: `${Math.round(declaredRatio)}:1 ratio`,
        contextHint: `Archive entry exceeds maximum safe compression ratio (${state.limits.maxCompressionRatio}:1)`,
      });
      return null;
    }
  }

  const remainingBudget = state.limits.maxTotalDecompressedBytes - state.totalDecompressed;
  if (remainingBudget <= 0 || entry.uncompressedSize > remainingBudget) {
    state.findings.push({
      file: archiveLabel,
      location: entry.name,
      category: 'archive_safety',
      rule: 'decompressed_size_limit_exceeded',
      riskLevel: 'critical',
      redactedMatch: `${entry.uncompressedSize} bytes`,
      contextHint: `Archive decompressed payload exceeds limit (${state.limits.maxTotalDecompressedBytes} bytes)`,
    });
    return null;
  }

  const nameLen = buf.readUInt16LE(entry.localHeaderOffset + 26);
  const extraLen = buf.readUInt16LE(entry.localHeaderOffset + 28);
  const dataStart = entry.localHeaderOffset + 30 + nameLen + extraLen;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buf.length) {
    state.scanErrors.push({ file: `${archiveLabel}!${entry.name}`, error: 'Truncated ZIP entry payload' });
    return null;
  }

  const compressedSlice = buf.subarray(dataStart, dataEnd);
  let out: Buffer;
  if (entry.compressionMethod === 0) {
    out = compressedSlice;
  } else if (entry.compressionMethod === 8) {
    try {
      out = zlib.inflateRawSync(compressedSlice, { maxOutputLength: remainingBudget });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Deflate error';
      if (/maxOutputLength|Cannot create a Buffer larger/i.test(msg)) {
        state.findings.push({
          file: archiveLabel,
          location: entry.name,
          category: 'archive_safety',
          rule: 'zip_bomb_inflated_overflow',
          riskLevel: 'critical',
          redactedMatch: 'inflate overflow',
          contextHint: 'Decompressed stream exceeded safe memory/size limit (possible zip bomb)',
        });
      } else {
        state.scanErrors.push({ file: `${archiveLabel}!${entry.name}`, error: msg });
      }
      return null;
    }
  } else {
    state.unsupportedFormats.push({
      file: `${archiveLabel}!${entry.name}`,
      format: `zip-method-${entry.compressionMethod}`,
      reason: 'Unsupported ZIP compression method',
    });
    return null;
  }

  // Post-inflation ratio verification (handles forged uncompressedSize headers)
  if (compressedSlice.length > 0 && out.length > 1024) {
    const actualRatio = out.length / compressedSlice.length;
    if (actualRatio > state.limits.maxCompressionRatio) {
      state.findings.push({
        file: archiveLabel,
        location: entry.name,
        category: 'archive_safety',
        rule: 'zip_bomb_actual_ratio_exceeded',
        riskLevel: 'critical',
        redactedMatch: `${Math.round(actualRatio)}:1 actual ratio`,
        contextHint: `Actual decompressed ratio exceeded safe limit (${state.limits.maxCompressionRatio}:1)`,
      });
      return null;
    }
  }

  state.totalDecompressed += out.length;
  return out;
}

function scanOoxmlDocument(
  buf: Buffer,
  fileLabel: string,
  kind: 'docx' | 'xlsx' | 'pptx',
  depth: number,
  state: ScanState,
): void {
  state.formatsInspected.add(kind.toUpperCase());

  let entries: ParsedZipEntry[];
  try {
    entries = parseZipCentralDirectory(buf);
  } catch (err) {
    state.scanErrors.push({
      file: fileLabel,
      error: err instanceof Error ? err.message : `Failed to parse ${kind.toUpperCase()} archive`,
    });
    return;
  }

  for (const entry of entries) {
    if (checkTimeout(state)) return;
    if (entry.isDirectory) continue;

    if (hasArchivePathTraversal(entry.name)) {
      state.findings.push({
        file: fileLabel,
        location: entry.name,
        category: 'archive_safety',
        rule: 'archive_path_traversal',
        riskLevel: 'critical',
        redactedMatch: entry.name.slice(0, 60),
        contextHint: 'Path traversal sequence detected inside OOXML archive',
      });
      continue;
    }

    const data = extractZipEntrySafe(buf, entry, state, fileLabel);
    if (!data) continue;

    const lower = entry.name.toLowerCase();
    if (lower.endsWith('.xml') || lower.endsWith('.rels')) {
      const rawXml = data.toString('utf8');
      const plainText = extractXmlText(rawXml);
      let partLabel = entry.name;
      if (kind === 'docx') {
        if (/^word\/header/i.test(lower)) partLabel = `DOCX header (${entry.name})`;
        else if (/^word\/footer/i.test(lower)) partLabel = `DOCX footer (${entry.name})`;
        else if (/^docprops\//i.test(lower)) partLabel = `DOCX metadata (${entry.name})`;
        else if (/^word\/document\.xml$/i.test(lower)) partLabel = 'DOCX document body';
      } else if (kind === 'pptx') {
        if (/^ppt\/notesslides\//i.test(lower)) partLabel = `PPTX speaker notes (${entry.name})`;
        else if (/^ppt\/slides\//i.test(lower)) {
          const isHidden = /<p:sld[^>]*\bshow=["']0["']/i.test(rawXml);
          partLabel = isHidden ? `PPTX hidden slide (${entry.name})` : `PPTX slide (${entry.name})`;
        } else if (/^docprops\//i.test(lower)) partLabel = `PPTX metadata (${entry.name})`;
      } else if (kind === 'xlsx') {
        if (/^xl\/externallinks\//i.test(lower)) partLabel = `XLSX external links (${entry.name})`;
        else if (/^xl\/comments/i.test(lower)) partLabel = `XLSX comments (${entry.name})`;
        else if (/^docprops\//i.test(lower)) partLabel = `XLSX metadata (${entry.name})`;
      }
      scanTextContent(plainText, fileLabel, partLabel, state);
      // Also scan raw XML attributes (e.g. external links, custom properties, formulas)
      scanTextContent(rawXml, fileLabel, `${partLabel} [xml]`, state);
    } else if (/embeddings\//i.test(lower)) {
      // Recursively scan embedded objects inside DOCX/XLSX/PPTX
      scanBufferInternal(data, `${fileLabel}!${entry.name}`, depth + 1, state);
    }
  }

  // Deep XLSX structured inspection via SheetJS: hidden/very-hidden sheets, formulas, comments, defined names, metadata
  if (kind === 'xlsx' && !checkTimeout(state)) {
    try {
      const wb = XLSX.read(buf, { type: 'buffer', cellFormula: true, cellText: true, bookProps: true });
      const sheetMeta = wb.Workbook?.Sheets || [];
      for (let i = 0; i < wb.SheetNames.length; i++) {
        const sheetName = wb.SheetNames[i];
        const hiddenState = sheetMeta[i]?.Hidden || 0;
        const visibility = hiddenState === 2 ? 'very_hidden_sheet' : hiddenState === 1 ? 'hidden_sheet' : 'sheet';
        const ws = wb.Sheets[sheetName];
        if (!ws) continue;

        for (const [cellRef, cellObj] of Object.entries(ws)) {
          if (cellRef.startsWith('!') || !cellObj || typeof cellObj !== 'object') continue;
          const c = cellObj as XLSX.CellObject;
          const loc = `XLSX ${visibility} "${sheetName}"!${cellRef}`;
          if (c.v !== undefined && c.v !== null) {
            scanTextContent(String(c.v), fileLabel, loc, state);
          }
          if (c.f) {
            scanTextContent(String(c.f), fileLabel, `${loc} [formula]`, state);
          }
          if (Array.isArray(c.c)) {
            for (const comment of c.c) {
              if (comment?.t) scanTextContent(String(comment.t), fileLabel, `${loc} [comment]`, state);
            }
          }
        }
      }

      if (wb.Workbook?.Names) {
        for (const def of wb.Workbook.Names) {
          scanTextContent(`${def.Name || ''}=${def.Ref || ''}`, fileLabel, 'XLSX defined name', state);
        }
      }
      if (wb.Props) {
        scanTextContent(JSON.stringify(wb.Props), fileLabel, 'XLSX workbook properties', state);
      }
    } catch (err) {
      state.warnings.push(
        `Structured XLSX sheet inspection warning for ${fileLabel}: ${err instanceof Error ? err.message : 'parse error'}`,
      );
    }
  }
}

function scanPdfDocument(buf: Buffer, fileLabel: string, state: ScanState): void {
  state.formatsInspected.add('PDF');
  const latin = buf.toString('latin1');

  // 1. Scan raw metadata, XMP XML, and uncompressed literal strings
  scanTextContent(latin, fileLabel, 'PDF metadata/raw objects', state);

  // Detect embedded file attachments
  if (/\/EmbeddedFile\b|\/Filespec\b/i.test(latin)) {
    state.warnings.push(
      `PDF ${fileLabel} contains embedded file/attachment markers (/EmbeddedFile or /Filespec) — manual inspection recommended.`,
    );
  }

  // 2. Safely decompress FlateDecode PDF streams (bounded by maxOutputLength & ratio)
  let searchPos = 0;
  let streamIdx = 0;
  while (searchPos < buf.length && streamIdx < 200 && !checkTimeout(state)) {
    const streamToken = buf.indexOf('stream', searchPos, 'latin1');
    if (streamToken === -1) break;
    const endStreamToken = buf.indexOf('endstream', streamToken + 6, 'latin1');
    if (endStreamToken === -1) break;

    let dataStart = streamToken + 6;
    if (buf[dataStart] === 0x0d && buf[dataStart + 1] === 0x0a) dataStart += 2;
    else if (buf[dataStart] === 0x0a || buf[dataStart] === 0x0d) dataStart += 1;

    const rawStream = buf.subarray(dataStart, endStreamToken);
    searchPos = endStreamToken + 9;
    streamIdx++;

    if (rawStream.length === 0 || rawStream.length > 5 * 1024 * 1024) continue;
    const remainingBudget = state.limits.maxTotalDecompressedBytes - state.totalDecompressed;
    if (remainingBudget <= 0) break;

    let decodedText = '';
    try {
      const inflated = zlib.inflateSync(rawStream, { maxOutputLength: Math.min(remainingBudget, 5 * 1024 * 1024) });
      state.totalDecompressed += inflated.length;
      decodedText = inflated.toString('latin1');
    } catch {
      // Stream may not be zlib-compressed; scan raw ASCII slice
      decodedText = rawStream.toString('latin1');
    }

    if (decodedText) {
      // Extract PDF literal strings (...) and hex strings <...> as well as combined text
      const literalParts: string[] = [];
      const litRegex = /\(((?:\\.|[^()\\])*)\)/g;
      let m: RegExpExecArray | null;
      while ((m = litRegex.exec(decodedText)) !== null) {
        literalParts.push(m[1].replace(/\\([()\\])/g, '$1'));
      }
      const hexParts: string[] = [];
      const hexRegex = /<([0-9a-fA-F]{4,})>/g;
      while ((m = hexRegex.exec(decodedText)) !== null) {
        try {
          hexParts.push(Buffer.from(m[1], 'hex').toString('utf8'));
        } catch {
          // ignore
        }
      }
      const combined = `${decodedText}\n${literalParts.join('')}\n${hexParts.join('')}`;
      scanTextContent(combined, fileLabel, `PDF stream #${streamIdx}`, state);
    }
  }
}

function scanZipArchive(buf: Buffer, fileLabel: string, depth: number, state: ScanState): void {
  state.formatsInspected.add('ZIP');
  if (depth > state.limits.maxDepth) {
    state.warnings.push(
      `Archive ${fileLabel} exceeded maximum nesting depth (${state.limits.maxDepth}); deeper contents were not scanned and require human review.`,
    );
    state.unsupportedFormats.push({
      file: fileLabel,
      format: 'nested-zip',
      reason: `Exceeded max nesting depth (${state.limits.maxDepth})`,
    });
    return;
  }

  let entries: ParsedZipEntry[];
  try {
    entries = parseZipCentralDirectory(buf);
  } catch (err) {
    state.scanErrors.push({
      file: fileLabel,
      error: err instanceof Error ? err.message : 'Failed to parse ZIP archive',
    });
    return;
  }

  if (entries.length > state.limits.maxEntries) {
    state.findings.push({
      file: fileLabel,
      location: 'archive_root',
      category: 'archive_safety',
      rule: 'archive_entry_count_exceeded',
      riskLevel: 'high',
      redactedMatch: `${entries.length} entries`,
      contextHint: `Archive contains more entries than safe scan limit (${state.limits.maxEntries})`,
    });
  }

  for (const entry of entries.slice(0, state.limits.maxEntries)) {
    if (checkTimeout(state)) return;
    state.totalEntries++;
    if (state.totalEntries > state.limits.maxEntries) {
      state.warnings.push(`Reached maximum total archive entries (${state.limits.maxEntries}); remaining entries require manual review.`);
      break;
    }

    if (hasArchivePathTraversal(entry.name)) {
      state.findings.push({
        file: fileLabel,
        location: entry.name,
        category: 'archive_safety',
        rule: 'archive_path_traversal',
        riskLevel: 'critical',
        redactedMatch: entry.name.slice(0, 60),
        contextHint: 'Zip Slip / path traversal entry detected in archive',
      });
      continue;
    }

    if (entry.isSymlink) {
      state.findings.push({
        file: fileLabel,
        location: entry.name,
        category: 'archive_safety',
        rule: 'archive_symlink_blocked',
        riskLevel: 'high',
        redactedMatch: entry.name.slice(0, 60),
        contextHint: 'Symbolic link inside archive is blocked by delivery policy',
      });
      continue;
    }

    if (entry.isDirectory) continue;

    const extracted = extractZipEntrySafe(buf, entry, state, fileLabel);
    if (!extracted) continue;
    scanBufferInternal(extracted, `${fileLabel}!${entry.name}`, depth + 1, state);
  }
}

function scanTarBuffer(tarBuf: Buffer, fileLabel: string, depth: number, state: ScanState): void {
  state.formatsInspected.add('TAR');
  if (depth > state.limits.maxDepth) {
    state.unsupportedFormats.push({
      file: fileLabel,
      format: 'nested-tar',
      reason: `Exceeded max nesting depth (${state.limits.maxDepth})`,
    });
    return;
  }

  let offset = 0;
  let entryCount = 0;
  while (offset + 512 <= tarBuf.length && entryCount < state.limits.maxEntries && !checkTimeout(state)) {
    const header = tarBuf.subarray(offset, offset + 512);
    // Two consecutive zero blocks mark end of TAR archive
    if (header.every((b) => b === 0)) break;

    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const fullName = prefix ? `${prefix}/${rawName}` : rawName;
    const sizeOctal = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    const fileSize = parseInt(sizeOctal || '0', 8);
    const typeFlag = String.fromCharCode(header[156] || 48);

    offset += 512;
    if (!Number.isFinite(fileSize) || fileSize < 0 || offset + fileSize > tarBuf.length) {
      state.scanErrors.push({ file: fileLabel, error: `Corrupted TAR entry bounds for "${fullName}"` });
      break;
    }

    entryCount++;
    state.totalEntries++;

    if (hasArchivePathTraversal(fullName)) {
      state.findings.push({
        file: fileLabel,
        location: fullName,
        category: 'archive_safety',
        rule: 'archive_path_traversal',
        riskLevel: 'critical',
        redactedMatch: fullName.slice(0, 60),
        contextHint: 'Path traversal sequence detected inside TAR archive',
      });
    } else if (typeFlag === '1' || typeFlag === '2') {
      state.findings.push({
        file: fileLabel,
        location: fullName,
        category: 'archive_safety',
        rule: 'archive_symlink_blocked',
        riskLevel: 'high',
        redactedMatch: fullName.slice(0, 60),
        contextHint: 'Hardlink or symlink inside TAR archive is blocked by delivery policy',
      });
    } else if ((typeFlag === '0' || typeFlag === '\0' || typeFlag === ' ') && fileSize > 0) {
      const content = tarBuf.subarray(offset, offset + fileSize);
      scanBufferInternal(content, `${fileLabel}!${fullName}`, depth + 1, state);
    }

    const paddedSize = Math.ceil(fileSize / 512) * 512;
    offset += paddedSize;
  }
}

function scanBufferInternal(buf: Buffer, fileLabel: string, depth: number, state: ScanState): void {
  if (checkTimeout(state)) return;
  state.filesScanned.add(fileLabel);

  const lowerName = fileLabel.toLowerCase();
  const baseName = path.basename(lowerName.split('!').pop() || lowerName);
  const ext = path.extname(baseName);

  // Flag inherently sensitive filenames
  if (/^\.env(\..+)?$|^id_rsa$|^id_ed25519$|credentials\.json$|\.npmrc$|\.pypirc$/i.test(baseName)) {
    state.findings.push({
      file: fileLabel,
      location: 'filename',
      category: 'sensitive_config_file',
      riskLevel: 'critical',
      redactedMatch: baseName,
      contextHint: 'Sensitive credential/environment file should not be packaged for client delivery',
    });
  }

  if (buf.length > state.limits.maxArchiveBytes && ['.zip', '.tar', '.tgz', '.gz', '.docx', '.xlsx', '.pptx', '.pdf'].includes(ext)) {
    state.unsupportedFormats.push({
      file: fileLabel,
      format: ext.replace('.', '').toUpperCase(),
      reason: `File exceeds maximum safe scan size (${state.limits.maxArchiveBytes} bytes)`,
    });
    return;
  }

  if (ext === '.docx') {
    scanOoxmlDocument(buf, fileLabel, 'docx', depth, state);
    return;
  }
  if (ext === '.xlsx') {
    scanOoxmlDocument(buf, fileLabel, 'xlsx', depth, state);
    return;
  }
  if (ext === '.pptx') {
    scanOoxmlDocument(buf, fileLabel, 'pptx', depth, state);
    return;
  }
  if (ext === '.pdf' || buf.subarray(0, 5).toString('ascii') === '%PDF-') {
    scanPdfDocument(buf, fileLabel, state);
    return;
  }
  if (ext === '.zip' || (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50)) {
    scanZipArchive(buf, fileLabel, depth, state);
    return;
  }
  if (lowerName.endsWith('.tar.gz') || ext === '.tgz') {
    state.formatsInspected.add('TAR.GZ');
    try {
      const remainingBudget = state.limits.maxTotalDecompressedBytes - state.totalDecompressed;
      const gunzipped = zlib.gunzipSync(buf, { maxOutputLength: Math.max(1, remainingBudget) });
      if (buf.length > 0 && gunzipped.length > 1024 && gunzipped.length / buf.length > state.limits.maxCompressionRatio) {
        state.findings.push({
          file: fileLabel,
          location: 'gzip_stream',
          category: 'archive_safety',
          rule: 'gzip_bomb_ratio_exceeded',
          riskLevel: 'critical',
          redactedMatch: `${Math.round(gunzipped.length / buf.length)}:1 ratio`,
          contextHint: 'GZIP stream exceeded safe compression ratio',
        });
        return;
      }
      state.totalDecompressed += gunzipped.length;
      scanTarBuffer(gunzipped, fileLabel, depth, state);
    } catch (err) {
      state.scanErrors.push({
        file: fileLabel,
        error: err instanceof Error ? err.message : 'Failed to decompress tar.gz archive',
      });
    }
    return;
  }
  if (ext === '.tar') {
    scanTarBuffer(buf, fileLabel, depth, state);
    return;
  }

  // Plain text / source / config formats
  if (TEXT_EXTENSIONS.has(ext) || baseName.startsWith('.env')) {
    state.formatsInspected.add(ext ? ext.replace('.', '').toUpperCase() : 'TEXT');
    scanTextContent(buf.toString('utf8'), fileLabel, 'text', state);
    return;
  }

  // Heuristic check: if no NUL bytes in first 4KB, treat as inspectable UTF-8 text; otherwise mark unsupported binary!
  const probe = buf.subarray(0, Math.min(4096, buf.length));
  const hasNullByte = probe.includes(0x00);
  if (!hasNullByte && buf.length <= 2 * 1024 * 1024) {
    state.formatsInspected.add(ext ? ext.replace('.', '').toUpperCase() : 'TEXT');
    scanTextContent(buf.toString('utf8'), fileLabel, 'plain_text_fallback', state);
    return;
  }

  // Unsupported binary format: NEVER falsely claim clean pass!
  state.unsupportedFormats.push({
    file: fileLabel,
    format: ext ? ext.replace('.', '').toUpperCase() : 'BINARY',
    reason: 'Unsupported binary format — contents cannot be fully verified by automated secret scanner.',
  });
}

function computeHighestRisk(findings: SecretScanFinding[]): SecretScanReport['riskLevel'] {
  if (findings.some((f) => f.riskLevel === 'critical')) return 'critical';
  if (findings.some((f) => f.riskLevel === 'high')) return 'high';
  if (findings.some((f) => f.riskLevel === 'medium')) return 'medium';
  if (findings.some((f) => f.riskLevel === 'low')) return 'low';
  return 'none';
}

export function scanFilesForSecrets(
  files: Array<{ relativePath: string; buffer: Buffer }>,
  options: SecretScanOptions = {},
): SecretScanReport {
  const limits: Required<SecretScanOptions> = { ...DEFAULT_LIMITS, ...options };
  const state: ScanState = {
    startTime: Date.now(),
    limits,
    timedOut: false,
    totalDecompressed: 0,
    totalEntries: 0,
    filesScanned: new Set<string>(),
    formatsInspected: new Set<string>(),
    unsupportedFormats: [],
    scanErrors: [],
    findings: [],
    warnings: [],
  };

  for (const file of files) {
    if (checkTimeout(state)) break;
    scanBufferInternal(file.buffer, file.relativePath, 0, state);
  }

  // Deduplicate identical findings
  const seen = new Set<string>();
  const uniqueFindings = state.findings.filter((f) => {
    const key = `${f.file}|${f.location}|${f.rule}|${f.redactedMatch}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const riskLevel = computeHighestRisk(uniqueFindings);
  let scanStatus: SecretScanReport['scanStatus'] = 'clean';
  if (uniqueFindings.length > 0) {
    scanStatus = 'findings_detected';
  } else if (state.timedOut || state.scanErrors.length > 0 || state.unsupportedFormats.length > 0) {
    scanStatus = state.scanErrors.length > 0 && state.filesScanned.size === 0 ? 'error' : 'partially_scanned';
  }

  const humanReviewRequired =
    uniqueFindings.length > 0 ||
    state.unsupportedFormats.length > 0 ||
    state.scanErrors.length > 0 ||
    state.timedOut ||
    state.warnings.length > 0;

  return {
    scanStatus,
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - state.startTime,
    timedOut: state.timedOut,
    filesScanned: Array.from(state.filesScanned),
    formatsInspected: Array.from(state.formatsInspected),
    unsupportedFormats: state.unsupportedFormats,
    scanErrors: state.scanErrors,
    findings: uniqueFindings,
    warnings: state.warnings,
    riskLevel,
    humanReviewRequired,
  };
}
