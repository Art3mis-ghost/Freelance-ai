import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import type { Request, Response, NextFunction } from 'express';
import { CONFIG } from './config.ts';

// Tool Permission Registry (Section 16)
export interface ToolDefinition {
  name: string;
  purpose: string;
  permissions: string[];
  inputSchema: string;
  outputSchema: string;
  timeoutMs: number;
  resourceLimitMb: number;
  riskLevel: 'low' | 'medium' | 'high';
  requiresApproval: boolean;
  authorized: boolean;
}

export const TOOL_REGISTRY: Record<string, ToolDefinition> = {
  connector_search: {
    name: 'connector_search',
    purpose: 'Query permitted public job APIs and RSS/JSON feeds within rate limits',
    permissions: ['network:permitted_feeds'],
    inputSchema: '{ sourceId: string, query?: string, limit?: number }',
    outputSchema: '{ jobs: NormalizedJob[] }',
    timeoutMs: 15000,
    resourceLimitMb: 128,
    riskLevel: 'low',
    requiresApproval: false,
    authorized: true,
  },
  feed_fetch: {
    name: 'feed_fetch',
    purpose: 'Fetch DNS-verified public HTTPS job endpoints with strict redirect and byte limits',
    permissions: ['network:https_public'],
    inputSchema: '{ url: string }',
    outputSchema: '{ status: number, body: string }',
    timeoutMs: 12000,
    resourceLimitMb: 64,
    riskLevel: 'low',
    requiresApproval: false,
    authorized: true,
  },
  job_dedupe: {
    name: 'job_dedupe',
    purpose: 'Deduplicate jobs against SQLite records by ID, URL, and text similarity',
    permissions: ['db:read_jobs'],
    inputSchema: '{ candidate: JobInput }',
    outputSchema: '{ isDuplicate: boolean, matchedJobId?: string }',
    timeoutMs: 5000,
    resourceLimitMb: 64,
    riskLevel: 'low',
    requiresApproval: false,
    authorized: true,
  },
  job_scorer: {
    name: 'job_scorer',
    purpose: 'Compute weighted 100-point suitability score with transparent reasoning',
    permissions: ['db:read_settings', 'llm:optional'],
    inputSchema: '{ jobId: string }',
    outputSchema: '{ jobScore: number, breakdown: ScoreBreakdownItem[] }',
    timeoutMs: 30000,
    resourceLimitMb: 256,
    riskLevel: 'low',
    requiresApproval: false,
    authorized: true,
  },
  scam_detector: {
    name: 'scam_detector',
    purpose: 'Identify scam patterns, off-platform traps, and graphic design exclusions',
    permissions: ['compute:local'],
    inputSchema: '{ title: string, description: string, budget?: number }',
    outputSchema: '{ riskScore: number, indicators: string[] }',
    timeoutMs: 5000,
    resourceLimitMb: 64,
    riskLevel: 'low',
    requiresApproval: false,
    authorized: true,
  },
  prompt_sanitizer: {
    name: 'prompt_sanitizer',
    purpose: 'Isolate untrusted external text and detect prompt injection attempts',
    permissions: ['compute:local'],
    inputSchema: '{ rawText: string }',
    outputSchema: '{ sanitized: string, injectionDetected: boolean }',
    timeoutMs: 2000,
    resourceLimitMb: 32,
    riskLevel: 'low',
    requiresApproval: false,
    authorized: true,
  },
  llm_generate: {
    name: 'llm_generate',
    purpose: 'Run text generation via local-first Ollama or configured fallback provider',
    permissions: ['ai:provider_pool'],
    inputSchema: '{ systemPrompt: string, userPrompt: string }',
    outputSchema: '{ text: string, provider: string, model: string }',
    timeoutMs: 90000,
    resourceLimitMb: 512,
    riskLevel: 'low',
    requiresApproval: false,
    authorized: true,
  },
  workspace_read: {
    name: 'workspace_read',
    purpose: 'Read files strictly confined to a single symlink-free project workspace directory',
    permissions: ['fs:project_workspace_read'],
    inputSchema: '{ projectId: string, relativePath: string }',
    outputSchema: '{ content: Buffer }',
    timeoutMs: 5000,
    resourceLimitMb: 128,
    riskLevel: 'low',
    requiresApproval: false,
    authorized: true,
  },
  workspace_write: {
    name: 'workspace_write',
    purpose: 'Write deliverable or working files strictly inside a symlink-free project workspace',
    permissions: ['fs:project_workspace_write'],
    inputSchema: '{ projectId: string, relativePath: string, content: string }',
    outputSchema: '{ sizeBytes: number, sha256: string }',
    timeoutMs: 10000,
    resourceLimitMb: 128,
    riskLevel: 'medium',
    requiresApproval: false,
    authorized: true,
  },
  generate_docx: {
    name: 'generate_docx',
    purpose: 'Build formatted Microsoft Word (.docx) deliverables in project workspace',
    permissions: ['fs:project_workspace_write'],
    inputSchema: '{ projectId: string, filename: string, sections: Section[] }',
    outputSchema: '{ relativePath: string, sizeBytes: number }',
    timeoutMs: 20000,
    resourceLimitMb: 256,
    riskLevel: 'low',
    requiresApproval: false,
    authorized: true,
  },
  generate_xlsx: {
    name: 'generate_xlsx',
    purpose: 'Build structured Excel (.xlsx) workbooks with formulas in project workspace',
    permissions: ['fs:project_workspace_write'],
    inputSchema: '{ projectId: string, filename: string, sheets: Sheet[] }',
    outputSchema: '{ relativePath: string, sizeBytes: number }',
    timeoutMs: 20000,
    resourceLimitMb: 256,
    riskLevel: 'low',
    requiresApproval: false,
    authorized: true,
  },
  generate_pdf: {
    name: 'generate_pdf',
    purpose: 'Render formatted PDF reports inside project workspace',
    permissions: ['fs:project_workspace_write'],
    inputSchema: '{ projectId: string, filename: string, content: PdfDoc }',
    outputSchema: '{ relativePath: string, sizeBytes: number }',
    timeoutMs: 20000,
    resourceLimitMb: 256,
    riskLevel: 'low',
    requiresApproval: false,
    authorized: true,
  },
  generate_pptx: {
    name: 'generate_pptx',
    purpose: 'Create PowerPoint (.pptx) presentation decks inside project workspace',
    permissions: ['fs:project_workspace_write'],
    inputSchema: '{ projectId: string, filename: string, slides: Slide[] }',
    outputSchema: '{ relativePath: string, sizeBytes: number }',
    timeoutMs: 20000,
    resourceLimitMb: 256,
    riskLevel: 'low',
    requiresApproval: false,
    authorized: true,
  },
  generate_csv: {
    name: 'generate_csv',
    purpose: 'Write RFC-4180 compliant CSV datasets inside project workspace',
    permissions: ['fs:project_workspace_write'],
    inputSchema: '{ projectId: string, filename: string, rows: string[][] }',
    outputSchema: '{ relativePath: string, sizeBytes: number }',
    timeoutMs: 10000,
    resourceLimitMb: 128,
    riskLevel: 'low',
    requiresApproval: false,
    authorized: true,
  },
  create_zip: {
    name: 'create_zip',
    purpose: 'Package verified project deliverables into a downloadable ZIP archive',
    permissions: ['fs:project_workspace_read', 'fs:project_workspace_write'],
    inputSchema: '{ projectId: string }',
    outputSchema: '{ zipPath: string, sizeBytes: number }',
    timeoutMs: 30000,
    resourceLimitMb: 256,
    riskLevel: 'low',
    requiresApproval: false,
    authorized: true,
  },
  file_verify: {
    name: 'file_verify',
    purpose: 'Verify binary headers, file non-emptiness, and SHA-256 digests',
    permissions: ['fs:project_workspace_read'],
    inputSchema: '{ projectId: string, relativePath: string }',
    outputSchema: '{ valid: boolean, reason: string }',
    timeoutMs: 10000,
    resourceLimitMb: 64,
    riskLevel: 'low',
    requiresApproval: false,
    authorized: true,
  },
  code_static_check: {
    name: 'code_static_check',
    purpose: 'Perform safe static syntax checks without executing arbitrary untrusted scripts',
    permissions: ['fs:project_workspace_read'],
    inputSchema: '{ projectId: string, relativePath: string }',
    outputSchema: '{ passed: boolean, issues: string[] }',
    timeoutMs: 10000,
    resourceLimitMb: 128,
    riskLevel: 'low',
    requiresApproval: false,
    authorized: true,
  },
  external_submission: {
    name: 'external_submission',
    purpose: 'Submitting proposals or client messages externally (PROHIBITED FOR AUTO-EXECUTION)',
    permissions: ['external:message'],
    inputSchema: '{}',
    outputSchema: '{}',
    timeoutMs: 0,
    resourceLimitMb: 0,
    riskLevel: 'high',
    requiresApproval: true,
    authorized: false,
  },
  shell_exec: {
    name: 'shell_exec',
    purpose: 'Arbitrary shell execution (DISABLED BY SECURITY POLICY)',
    permissions: ['os:shell'],
    inputSchema: '{}',
    outputSchema: '{}',
    timeoutMs: 0,
    resourceLimitMb: 0,
    riskLevel: 'high',
    requiresApproval: true,
    authorized: false,
  },
};

export function assertToolAuthorized(toolName: string): ToolDefinition {
  const tool = TOOL_REGISTRY[toolName];
  if (!tool || !tool.authorized) {
    throw new Error(`Security policy blocked unauthorized tool execution: ${toolName}`);
  }
  return tool;
}

// ============================================================================
// Workspace Confinement, Symlink Defense & Race-Safe File I/O (BUG-03)
// ============================================================================

export function sanitizePathSegment(segment: string): string {
  const clean = segment.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.{2,}/g, '_');
  if (!clean || clean === '.' || clean === '..') {
    throw new Error('Invalid path segment');
  }
  return clean;
}

function resolveRealAncestor(targetPath: string): { realExisting: string; remainingSegments: string[] } {
  let cursor = path.resolve(targetPath);
  const trailing: string[] = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    trailing.unshift(path.basename(cursor));
    cursor = parent;
  }
  const realExisting = fs.existsSync(cursor) ? fs.realpathSync(cursor) : cursor;
  return { realExisting, remainingSegments: trailing };
}

function assertNoSymlinksUnderRoot(rootDir: string, targetPath: string): void {
  const rel = path.relative(rootDir, targetPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Path escapes isolated project workspace');
  }

  // Verify the project root itself is not a symlink (if it exists)
  if (fs.existsSync(rootDir)) {
    const rootStat = fs.lstatSync(rootDir);
    if (rootStat.isSymbolicLink()) {
      throw new Error('Symbolic links are not permitted as project workspace roots');
    }
  }

  const segments = rel ? rel.split(path.sep).filter(Boolean) : [];
  let cursor = rootDir;
  for (const seg of segments) {
    cursor = path.join(cursor, seg);
    if (fs.existsSync(cursor)) {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) {
        throw new Error(`Symbolic link blocked inside isolated workspace: ${seg}`);
      }
    } else {
      // Also catch broken symlinks: lstatSync succeeds on dangling symlinks whereas existsSync returns false
      try {
        const lstat = fs.lstatSync(cursor);
        if (lstat.isSymbolicLink()) {
          throw new Error(`Symbolic link blocked inside isolated workspace: ${seg}`);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          throw err;
        }
      }
      break;
    }
  }
}

export function getProjectWorkspaceRoot(projectId: string): string {
  const safeId = sanitizePathSegment(projectId);
  const baseDir = path.resolve(CONFIG.projectsDir);
  const projectRoot = path.resolve(baseDir, safeId);
  if (!projectRoot.startsWith(baseDir + path.sep)) {
    throw new Error('Workspace boundary violation');
  }

  // Reject symlinks on the project root itself and verify canonical realpath boundary
  try {
    const lstat = fs.lstatSync(projectRoot);
    if (lstat.isSymbolicLink()) {
      throw new Error('Symbolic link blocked as project workspace root');
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      throw err;
    }
  }

  if (fs.existsSync(baseDir)) {
    const realBase = fs.realpathSync(baseDir);
    if (fs.existsSync(projectRoot)) {
      const realProject = fs.realpathSync(projectRoot);
      if (!realProject.startsWith(realBase + path.sep)) {
        throw new Error('Canonical workspace root escapes projects directory');
      }
      return realProject;
    }
    return path.resolve(realBase, safeId);
  }

  return projectRoot;
}

export function resolveSafeWorkspacePath(projectId: string, relativePath: string): string {
  const projectRoot = getProjectWorkspaceRoot(projectId);
  const normalizedRel = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (normalizedRel.includes('\0') || normalizedRel.split('/').includes('..')) {
    throw new Error('Path traversal attempt blocked');
  }
  const resolved = path.resolve(projectRoot, normalizedRel);
  if (resolved !== projectRoot && !resolved.startsWith(projectRoot + path.sep)) {
    throw new Error('Path escapes isolated project workspace');
  }

  // Enforce symlink rejection along every path segment inside the workspace
  assertNoSymlinksUnderRoot(projectRoot, resolved);

  // Verify resolved canonical path of deepest existing ancestor remains strictly within real projectRoot
  if (fs.existsSync(projectRoot)) {
    const realRoot = fs.realpathSync(projectRoot);
    const { realExisting, remainingSegments } = resolveRealAncestor(resolved);
    const canonicalTarget =
      remainingSegments.length > 0 ? path.resolve(realExisting, ...remainingSegments) : realExisting;
    if (canonicalTarget !== realRoot && !canonicalTarget.startsWith(realRoot + path.sep)) {
      throw new Error('Resolved real path escapes isolated project workspace');
    }
    return canonicalTarget;
  }

  return resolved;
}

const O_NOFOLLOW_FLAG = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;

export function readSafeWorkspaceFile(
  projectId: string,
  relativePath: string,
  maxBytes?: number,
): { buffer: Buffer; sizeBytes: number; absolutePath: string } {
  const absPath = resolveSafeWorkspacePath(projectId, relativePath);
  let fd: number | null = null;
  try {
    fd = fs.openSync(absPath, fs.constants.O_RDONLY | O_NOFOLLOW_FLAG);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error('Target path is not a regular file');
    }
    if (maxBytes !== undefined && stat.size > maxBytes) {
      const sliceBuf = Buffer.alloc(maxBytes);
      const bytesRead = fs.readSync(fd, sliceBuf, 0, maxBytes, 0);
      return { buffer: sliceBuf.subarray(0, bytesRead), sizeBytes: stat.size, absolutePath: absPath };
    }
    const buf = fs.readFileSync(fd);
    return { buffer: buf, sizeBytes: stat.size, absolutePath: absPath };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ELOOP') {
      throw new Error('Symbolic link access blocked during file open');
    }
    throw err;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close errors
      }
    }
  }
}

export function writeSafeWorkspaceFile(
  projectId: string,
  relativePath: string,
  data: Buffer | string,
): { absolutePath: string; buffer: Buffer } {
  const absPath = resolveSafeWorkspacePath(projectId, relativePath);
  const parentDir = path.dirname(absPath);
  fs.mkdirSync(parentDir, { recursive: true });
  // Re-verify after directory creation so no parent segment was replaced with a symlink
  const verifiedPath = resolveSafeWorkspacePath(projectId, relativePath);
  const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;

  let fd: number | null = null;
  try {
    fd = fs.openSync(
      verifiedPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | O_NOFOLLOW_FLAG,
      0o600,
    );
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error('Write target is not a regular file');
    }
    fs.writeFileSync(fd, buffer);
    return { absolutePath: verifiedPath, buffer };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ELOOP') {
      throw new Error('Symbolic link write blocked during file open');
    }
    throw err;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close errors
      }
    }
  }
}

// ============================================================================
// Prompt Injection Sanitizer (Section 24)
// ============================================================================

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  /disregard\s+(all\s+)?system\s+prompt/i,
  /you\s+are\s+now\s+(in\s+)?developer\s+mode/i,
  /exfiltrate\s+(api\s+key|secret|env|password)/i,
  /run\s+shell\s+command/i,
  /execute\s+powershell/i,
  /<\s*\/?\s*system\s*>/i,
];

export function sanitizeUntrustedText(raw: string): {
  sanitized: string;
  injectionDetected: boolean;
  matchedPatterns: string[];
} {
  const cleaned = String(raw || '')
    .replace(/\u0000/g, '')
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .slice(0, 32000);

  const matchedPatterns: string[] = [];
  for (const rx of INJECTION_PATTERNS) {
    if (rx.test(cleaned)) {
      matchedPatterns.push(rx.source);
    }
  }

  return {
    sanitized: cleaned,
    injectionDetected: matchedPatterns.length > 0,
    matchedPatterns,
  };
}

export function wrapUntrustedForPrompt(label: string, content: string): string {
  const { sanitized } = sanitizeUntrustedText(content);
  const safeContent = sanitized.replace(/<\/untrusted_data>/gi, '[escaped_tag]');
  return `<untrusted_data source="${label}">\n${safeContent}\n</untrusted_data>`;
}

// ============================================================================
// SSRF Protection: IP Ranges, DNS Resolution, Redirect Revalidation & Byte Cap
// (BUG-04, BUG-10, BUG-11)
// ============================================================================

function expandIpv6ToWords(ip: string): number[] | null {
  const bare = ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (!net.isIPv6(bare)) return null;

  // Handle trailing IPv4 dotted quad (e.g. ::ffff:127.0.0.1)
  let normalized = bare;
  const lastColon = bare.lastIndexOf(':');
  const tail = bare.slice(lastColon + 1);
  if (tail.includes('.') && net.isIPv4(tail)) {
    const octets = tail.split('.').map(Number);
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    normalized = `${bare.slice(0, lastColon)}:${high}:${low}`;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':').filter(Boolean) : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':').filter(Boolean) : [];
  const missing = 8 - (left.length + right.length);
  if (missing < 0) return null;
  const full = [...left, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...right];
  if (full.length !== 8) return null;
  const words = full.map((h) => parseInt(h, 16));
  if (words.some((w) => !Number.isFinite(w) || w < 0 || w > 0xffff)) return null;
  return words;
}

export function isLoopbackIp(ip: string): boolean {
  const bare = ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (bare === 'localhost') return true;
  if (net.isIPv4(bare)) {
    return bare.split('.').map(Number)[0] === 127;
  }
  const words = expandIpv6ToWords(bare);
  if (!words) return false;
  // ::1
  if (words.slice(0, 7).every((w) => w === 0) && words[7] === 1) return true;
  // ::ffff:127.0.0.0/104
  if (words.slice(0, 5).every((w) => w === 0) && words[5] === 0xffff && (words[6] >> 8) === 127) return true;
  return false;
}

function isPrivateIpv4Octets(a: number, b: number, c: number): boolean {
  if (a === 0) return true; // 0.0.0.0/8 (this network)
  if (a === 10) return true; // 10.0.0.0/8 (RFC1918)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (a === 127) return true; // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local & cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (RFC1918)
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 (IETF protocol)
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 (RFC1918)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (benchmarking)
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 (TEST-NET-2)
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 (TEST-NET-3)
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + 255.255.255.255 broadcast
  return false;
}

export function isPrivateOrRestrictedIp(hostOrIp: string): boolean {
  const lower = hostOrIp.trim().toLowerCase();
  if (
    !lower ||
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal') ||
    lower.endsWith('.arpa')
  ) {
    return true;
  }

  const bare = lower.replace(/^\[|\]$/g, '').split('%')[0];

  if (net.isIPv4(bare)) {
    const parts = bare.split('.').map(Number);
    return isPrivateIpv4Octets(parts[0], parts[1], parts[2]);
  }

  const words = expandIpv6ToWords(bare);
  if (words) {
    // :: unspecified
    if (words.every((w) => w === 0)) return true;
    // ::1 loopback
    if (words.slice(0, 7).every((w) => w === 0) && words[7] === 1) return true;
    // IPv4-mapped ::ffff:0:0/96 or IPv4-compatible ::/96
    const isMapped = words.slice(0, 5).every((w) => w === 0) && words[5] === 0xffff;
    const isCompat = words.slice(0, 6).every((w) => w === 0);
    if (isMapped || isCompat) {
      const a = words[6] >> 8;
      const b = words[6] & 0xff;
      const c = words[7] >> 8;
      return isPrivateIpv4Octets(a, b, c);
    }
    // NAT64 well-known prefix 64:ff9b::/96 -> embedded IPv4 in last 32 bits
    if (words[0] === 0x0064 && words[1] === 0xff9b && words[2] === 0 && words[3] === 0 && words[4] === 0 && words[5] === 0) {
      const a = words[6] >> 8;
      const b = words[6] & 0xff;
      const c = words[7] >> 8;
      return isPrivateIpv4Octets(a, b, c);
    }
    // 6to4 (2002::/16) -> embedded IPv4 in words[1], words[2]
    if (words[0] === 0x2002) {
      const a = words[1] >> 8;
      const b = words[1] & 0xff;
      const c = words[2] >> 8;
      return isPrivateIpv4Octets(a, b, c);
    }
    // Teredo (2001:0000::/32)
    if (words[0] === 0x2001 && words[1] === 0x0000) return true;
    // Unique local fc00::/7
    if ((words[0] & 0xfe00) === 0xfc00) return true;
    // Link-local fe80::/10
    if ((words[0] & 0xffc0) === 0xfe80) return true;
    // Site-local deprecated fec0::/10
    if ((words[0] & 0xffc0) === 0xfec0) return true;
    // Multicast ff00::/8
    if ((words[0] & 0xff00) === 0xff00) return true;
    // Documentation 2001:db8::/32
    if (words[0] === 0x2001 && words[1] === 0x0db8) return true;
    return false;
  }

  return false;
}

export function validateExternalUrl(
  rawUrl: string,
  options: { allowLocalOllama?: boolean; allowedHosts?: string[] } = {},
): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL format');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Only http and https URLs are permitted');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Embedded URL credentials are not permitted');
  }

  const host = parsed.hostname.toLowerCase();
  const isLoopback = isLoopbackIp(host);

  if (options.allowLocalOllama && isLoopback) {
    return parsed;
  }

  if (isPrivateOrRestrictedIp(host)) {
    throw new Error(`Blocked restricted internal or private network host: ${host}`);
  }

  if (options.allowedHosts && options.allowedHosts.length > 0) {
    const ok = options.allowedHosts.some(
      (allowed) => host === allowed.toLowerCase() || host.endsWith('.' + allowed.toLowerCase()),
    );
    if (!ok) {
      throw new Error(`Host ${host} is not in the permitted allowlist`);
    }
  }

  return parsed;
}

export interface ResolvedExternalTarget {
  url: URL;
  pinnedAddress: string;
  pinnedFamily: 4 | 6;
  allAddresses: string[];
}

export async function validateAndResolveExternalUrl(
  rawUrl: string,
  options: {
    allowLocalOllama?: boolean;
    allowedHosts?: string[];
    customLookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  } = {},
): Promise<ResolvedExternalTarget> {
  const parsed = validateExternalUrl(rawUrl, options);
  const bareHost = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  // If literal IP, already validated by validateExternalUrl
  const ipFamily = net.isIP(bareHost);
  if (ipFamily === 4 || ipFamily === 6) {
    if (!options.allowLocalOllama && isPrivateOrRestrictedIp(bareHost)) {
      throw new Error(`Blocked restricted IP address: ${bareHost}`);
    }
    return {
      url: parsed,
      pinnedAddress: bareHost,
      pinnedFamily: ipFamily as 4 | 6,
      allAddresses: [bareHost],
    };
  }

  const lookupFn =
    options.customLookup ||
    (async (host: string) =>
      (await dns.promises.lookup(host, { all: true, verbatim: true })) as Array<{
        address: string;
        family: number;
      }>);

  let records: Array<{ address: string; family: number }>;
  try {
    records = await lookupFn(bareHost);
  } catch (err) {
    throw new Error(
      `DNS resolution failed for ${bareHost}: ${err instanceof Error ? err.message : 'lookup error'}`,
    );
  }

  if (!records || records.length === 0) {
    throw new Error(`DNS resolution returned no addresses for ${bareHost}`);
  }

  // Validate EVERY resolved IPv4 and IPv6 record before permitting any connection
  for (const rec of records) {
    const allowedLoopback = Boolean(options.allowLocalOllama && isLoopbackIp(bareHost) && isLoopbackIp(rec.address));
    if (!allowedLoopback && isPrivateOrRestrictedIp(rec.address)) {
      throw new Error(`Blocked DNS resolution to restricted/private network address (${bareHost} -> ${rec.address})`);
    }
  }

  const primary = records[0];
  return {
    url: parsed,
    pinnedAddress: primary.address,
    pinnedFamily: primary.family === 6 ? 6 : 4,
    allAddresses: records.map((r) => r.address),
  };
}

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  allowLocalOllama?: boolean;
  allowedHosts?: string[];
  signal?: AbortSignal;
  customLookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
}

export interface SafeFetchResponse {
  status: number;
  ok: boolean;
  finalUrl: string;
  redirectCount: number;
  headers: Record<string, string>;
  bodyBuffer: Buffer;
  bodyText: string;
  compressedBytes: number;
  decompressedBytes: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export async function safeExternalFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeFetchResponse> {
  const maxRedirects = options.maxRedirects ?? 5;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024; // 2 MB default hard cap
  const timeoutMs = options.timeoutMs ?? 12000;

  let currentUrl = rawUrl;
  let currentMethod = (options.method || 'GET').toUpperCase();
  let currentBody = options.body;
  let redirectCount = 0;

  while (true) {
    if (options.signal?.aborted) {
      throw new Error('REQUEST_ABORTED');
    }

    const resolved = await validateAndResolveExternalUrl(currentUrl, {
      allowLocalOllama: options.allowLocalOllama,
      allowedHosts: options.allowedHosts,
      customLookup: options.customLookup,
    });

    const singleHop = await executePinnedHttpRequest(resolved, {
      method: currentMethod,
      headers: options.headers,
      body: currentBody,
      timeoutMs,
      maxBytes,
      signal: options.signal,
    });

    if (REDIRECT_STATUSES.has(singleHop.status) && singleHop.headers.location) {
      if (redirectCount >= maxRedirects) {
        throw new Error(`Exceeded maximum redirect limit (${maxRedirects})`);
      }
      const nextUrl = new URL(singleHop.headers.location, resolved.url).toString();
      redirectCount++;
      currentUrl = nextUrl;
      if (singleHop.status === 303 || ((singleHop.status === 301 || singleHop.status === 302) && currentMethod === 'POST')) {
        currentMethod = 'GET';
        currentBody = undefined;
      }
      continue;
    }

    return {
      ...singleHop,
      finalUrl: resolved.url.toString(),
      redirectCount,
    };
  }
}

function executePinnedHttpRequest(
  target: ResolvedExternalTarget,
  opts: {
    method: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
    timeoutMs: number;
    maxBytes: number;
    signal?: AbortSignal;
  },
): Promise<Omit<SafeFetchResponse, 'finalUrl' | 'redirectCount'>> {
  return new Promise((resolve, reject) => {
    const isHttps = target.url.protocol === 'https:';
    const transport = isHttps ? https : http;
    let settled = false;

    const finishReject = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const finishResolve = (val: Omit<SafeFetchResponse, 'finalUrl' | 'redirectCount'>) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(val);
    };

    const reqHeaders: Record<string, string> = {
      'Accept-Encoding': 'gzip, deflate, br',
      ...(opts.headers || {}),
    };
    const bodyBuf =
      opts.body !== undefined ? (typeof opts.body === 'string' ? Buffer.from(opts.body, 'utf8') : opts.body) : undefined;
    if (bodyBuf && !Object.keys(reqHeaders).some((k) => k.toLowerCase() === 'content-length')) {
      reqHeaders['Content-Length'] = String(bodyBuf.length);
    }

    // Pin TCP connection strictly to the already-validated DNS address (eliminates DNS rebinding TOCTOU)
    const pinnedLookup = (
      _hostname: string,
      lookupOpts: unknown,
      cb?: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void,
    ) => {
      const callback = typeof lookupOpts === 'function' ? (lookupOpts as typeof cb) : cb;
      if (!callback) return;
      if (typeof lookupOpts === 'object' && lookupOpts !== null && (lookupOpts as { all?: boolean }).all) {
        callback(null, [{ address: target.pinnedAddress, family: target.pinnedFamily }]);
      } else {
        callback(null, target.pinnedAddress, target.pinnedFamily);
      }
    };

    const req = transport.request(
      {
        protocol: target.url.protocol,
        hostname: target.url.hostname,
        port: target.url.port ? Number(target.url.port) : isHttps ? 443 : 80,
        path: `${target.url.pathname}${target.url.search}`,
        method: opts.method,
        headers: reqHeaders,
        lookup: pinnedLookup as unknown as typeof dns.lookup,
        servername: isHttps && !net.isIP(target.url.hostname) ? target.url.hostname : undefined,
      },
      (res) => {
        const status = res.statusCode || 0;
        const flatHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (v !== undefined) {
            flatHeaders[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
          }
        }

        // For redirects, drain/destroy immediately without reading body and return headers for manual revalidation
        if (REDIRECT_STATUSES.has(status) && flatHeaders.location) {
          res.resume();
          res.destroy();
          finishResolve({
            status,
            ok: false,
            headers: flatHeaders,
            bodyBuffer: Buffer.alloc(0),
            bodyText: '',
            compressedBytes: 0,
            decompressedBytes: 0,
          });
          return;
        }

        // Pre-check Content-Length header against hard byte limit
        const declaredLen = flatHeaders['content-length'] ? Number(flatHeaders['content-length']) : NaN;
        if (Number.isFinite(declaredLen) && declaredLen > opts.maxBytes) {
          res.destroy();
          req.destroy();
          finishReject(new Error(`Response size limit exceeded (${declaredLen} bytes > ${opts.maxBytes} bytes)`));
          return;
        }

        const encoding = (flatHeaders['content-encoding'] || '').toLowerCase().trim();
        let compressedBytes = 0;
        let decompressedBytes = 0;
        const chunks: Buffer[] = [];

        let decoder: zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | null = null;
        if (encoding === 'gzip' || encoding === 'x-gzip') {
          decoder = zlib.createGunzip();
        } else if (encoding === 'deflate') {
          decoder = zlib.createInflate();
        } else if (encoding === 'br') {
          decoder = zlib.createBrotliDecompress();
        }

        const abortOversize = (kind: string) => {
          decoder?.destroy();
          res.destroy();
          req.destroy();
          finishReject(new Error(`Response ${kind} size limit exceeded (max ${opts.maxBytes} bytes)`));
        };

        if (decoder) {
          res.on('data', (chunk: Buffer) => {
            compressedBytes += chunk.length;
            if (compressedBytes > opts.maxBytes) {
              abortOversize('compressed');
              return;
            }
          });

          decoder.on('data', (chunk: Buffer) => {
            decompressedBytes += chunk.length;
            if (decompressedBytes > opts.maxBytes) {
              abortOversize('decompressed');
              return;
            }
            chunks.push(chunk);
          });

          decoder.on('error', (err) => {
            res.destroy();
            finishReject(new Error(`Failed to decompress response: ${err.message}`));
          });

          decoder.on('end', () => {
            const fullBuf = Buffer.concat(chunks);
            finishResolve({
              status,
              ok: status >= 200 && status < 300,
              headers: flatHeaders,
              bodyBuffer: fullBuf,
              bodyText: fullBuf.toString('utf8'),
              compressedBytes,
              decompressedBytes,
            });
          });

          res.on('error', (err) => finishReject(err));
          res.pipe(decoder);
        } else {
          res.on('data', (chunk: Buffer) => {
            compressedBytes += chunk.length;
            decompressedBytes += chunk.length;
            if (decompressedBytes > opts.maxBytes) {
              abortOversize('body');
              return;
            }
            chunks.push(chunk);
          });
          res.on('error', (err) => finishReject(err));
          res.on('end', () => {
            const fullBuf = Buffer.concat(chunks);
            finishResolve({
              status,
              ok: status >= 200 && status < 300,
              headers: flatHeaders,
              bodyBuffer: fullBuf,
              bodyText: fullBuf.toString('utf8'),
              compressedBytes,
              decompressedBytes,
            });
          });
        }
      },
    );

    const onAbort = () => {
      req.destroy();
      finishReject(new Error('REQUEST_ABORTED'));
    };

    const timer = setTimeout(() => {
      req.destroy();
      finishReject(new Error(`Outbound request timed out after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      if (opts.signal) {
        opts.signal.removeEventListener('abort', onAbort);
      }
    };

    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort();
        return;
      }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    req.on('error', (err) => {
      finishReject(err instanceof Error ? err : new Error(String(err)));
    });

    if (bodyBuf) {
      req.write(bodyBuf);
    }
    req.end();
  });
}

// ============================================================================
// First-Run Localhost-Only Bootstrap Guard & Setup Token Verification (BUG-01)
// ============================================================================

export function isLocalhostBootstrapRequest(req: Request): { allowed: boolean; reason?: string } {
  const socketAddr = req.socket?.remoteAddress || '';
  if (!socketAddr || !isLoopbackIp(socketAddr)) {
    return {
      allowed: false,
      reason:
        'First-run admin setup is restricted to localhost (127.0.0.1 / ::1). Remote bootstrap is blocked. Set HUB_ADMIN_PASSCODE in server environment variables for remote deployments.',
    };
  }

  // Even if bound behind a local reverse proxy, reject if X-Forwarded-For indicates a remote client
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim().length > 0) {
    const hops = xff
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (hops.some((hop) => !isLoopbackIp(hop))) {
      return {
        allowed: false,
        reason:
          'Remote first-run admin setup via forwarded proxy traffic is blocked. Connect directly from localhost or configure HUB_ADMIN_PASSCODE on the server.',
      };
    }
  }

  const forwarded = req.headers['x-real-ip'];
  if (typeof forwarded === 'string' && forwarded.trim().length > 0 && !isLoopbackIp(forwarded.trim())) {
    return {
      allowed: false,
      reason: 'Remote first-run admin setup is blocked. Configure HUB_ADMIN_PASSCODE on the server.',
    };
  }

  return { allowed: true };
}

export function verifySetupToken(candidate: string | undefined): boolean {
  const expected = CONFIG.setupTokenEnv;
  if (!expected) return true; // No setup token configured in env; localhost guard still applies
  if (!candidate) return false;
  const a = Buffer.from(candidate.trim());
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ============================================================================
// Authentication Rate Limiter, Progressive Backoff & Lockout (BUG-02)
// ============================================================================

interface AuthBucketState {
  windowAttempts: number[];
  consecutiveFailures: number;
  lockedUntil: number;
  lastAttemptAt: number;
}

export interface FailedAuthAttemptLog {
  timestamp: string;
  clientKey: string;
  bucket: 'login' | 'bootstrap';
  reason: string;
}

const AUTH_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const AUTH_MAX_WINDOW_ATTEMPTS = 12;
const AUTH_LOCKOUT_THRESHOLD = 5;
const AUTH_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes
const MAX_TRACKED_CLIENTS = 1000;
const MAX_FAILED_ATTEMPT_LOGS = 500;
const FAILED_LOG_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours

const authRateBuckets = new Map<string, AuthBucketState>();
const failedAuthAttemptLogs: FailedAuthAttemptLog[] = [];

export function getAuthClientKey(req: Request): string {
  const ip = (CONFIG.trustProxy ? req.ip : req.socket?.remoteAddress) || req.socket?.remoteAddress || 'unknown';
  return ip.replace(/^::ffff:/, '');
}

function getOrCreateBucket(key: string): AuthBucketState {
  let state = authRateBuckets.get(key);
  if (!state) {
    // Bounded eviction when map reaches capacity
    if (authRateBuckets.size >= MAX_TRACKED_CLIENTS) {
      const oldestKey = authRateBuckets.keys().next().value;
      if (oldestKey) authRateBuckets.delete(oldestKey);
    }
    state = { windowAttempts: [], consecutiveFailures: 0, lockedUntil: 0, lastAttemptAt: 0 };
    authRateBuckets.set(key, state);
  }
  return state;
}

export function checkAuthRateLimit(
  req: Request,
  bucket: 'login' | 'bootstrap',
): { allowed: boolean; retryAfterSec?: number; delayMs?: number; reason?: string } {
  const now = Date.now();
  const key = `${bucket}:${getAuthClientKey(req)}`;
  const state = getOrCreateBucket(key);

  // Prune expired sliding-window timestamps
  state.windowAttempts = state.windowAttempts.filter((ts) => now - ts < AUTH_WINDOW_MS);

  if (state.lockedUntil > now) {
    const retryAfterSec = Math.max(1, Math.ceil((state.lockedUntil - now) / 1000));
    return {
      allowed: false,
      retryAfterSec,
      reason: `Too many failed authentication attempts. Locked out for ${retryAfterSec}s.`,
    };
  }

  if (state.windowAttempts.length >= AUTH_MAX_WINDOW_ATTEMPTS) {
    const oldest = state.windowAttempts[0];
    const retryAfterSec = Math.max(1, Math.ceil((oldest + AUTH_WINDOW_MS - now) / 1000));
    return {
      allowed: false,
      retryAfterSec,
      reason: `Authentication rate limit exceeded. Try again in ${retryAfterSec}s.`,
    };
  }

  state.windowAttempts.push(now);
  state.lastAttemptAt = now;

  // Progressive delay based on consecutive failures (capped in test env for fast suite runs)
  const delayCap = process.env.VITEST === 'true' ? 50 : 6000;
  const delayMs =
    state.consecutiveFailures > 0
      ? Math.min(delayCap, 250 * Math.pow(2, state.consecutiveFailures - 1))
      : 0;

  return { allowed: true, delayMs };
}

export function recordAuthFailure(req: Request, bucket: 'login' | 'bootstrap', reason: string): {
  consecutiveFailures: number;
  locked: boolean;
  retryAfterSec?: number;
} {
  const now = Date.now();
  const clientKey = getAuthClientKey(req);
  const key = `${bucket}:${clientKey}`;
  const state = getOrCreateBucket(key);
  state.consecutiveFailures += 1;

  let locked = false;
  let retryAfterSec: number | undefined;
  if (state.consecutiveFailures >= AUTH_LOCKOUT_THRESHOLD) {
    state.lockedUntil = now + AUTH_LOCKOUT_MS;
    locked = true;
    retryAfterSec = Math.ceil(AUTH_LOCKOUT_MS / 1000);
  }

  // Bounded retention log of failed auth attempts
  failedAuthAttemptLogs.push({
    timestamp: new Date(now).toISOString(),
    clientKey,
    bucket,
    reason,
  });
  const cutoff = now - FAILED_LOG_RETENTION_MS;
  while (
    failedAuthAttemptLogs.length > MAX_FAILED_ATTEMPT_LOGS ||
    (failedAuthAttemptLogs.length > 0 && Date.parse(failedAuthAttemptLogs[0].timestamp) < cutoff)
  ) {
    failedAuthAttemptLogs.shift();
  }

  return { consecutiveFailures: state.consecutiveFailures, locked, retryAfterSec };
}

export function recordAuthSuccess(req: Request, bucket: 'login' | 'bootstrap'): void {
  const key = `${bucket}:${getAuthClientKey(req)}`;
  const state = authRateBuckets.get(key);
  if (state) {
    state.consecutiveFailures = 0;
    state.lockedUntil = 0;
  }
}

export function getRecentAuthFailures(): FailedAuthAttemptLog[] {
  return [...failedAuthAttemptLogs];
}

export function resetAuthRateLimiter(): void {
  authRateBuckets.clear();
  failedAuthAttemptLogs.length = 0;
}

// ============================================================================
// Local Authentication & Session Management (scrypt + in-memory Bearer tokens)
// ============================================================================

const SESSION_SECRET = process.env.HUB_SESSION_SECRET?.trim() || crypto.randomBytes(32).toString('hex');
const activeSessions = new Map<string, { createdAt: number; expiresAt: number }>();
const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours

export function hashPassword(password: string): { hash: string; salt: string } {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash: derived, salt };
}

export function verifyPassword(password: string, storedHash: string, salt: string): boolean {
  const derived = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(storedHash, 'hex');
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

export function verifyEnvPasscode(candidate: string): boolean {
  if (!CONFIG.adminPasscodeEnv) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(CONFIG.adminPasscodeEnv);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function createSessionToken(): { token: string; expiresAt: number } {
  const raw = crypto.randomBytes(32).toString('hex');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(raw).digest('hex');
  const token = `${raw}.${sig}`;
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  activeSessions.set(token, { createdAt: now, expiresAt });
  return { token, expiresAt };
}

export function verifySessionToken(token: string | undefined): boolean {
  if (!token) return false;
  const session = activeSessions.get(token);
  if (!session) return false;
  if (Date.now() > session.expiresAt) {
    activeSessions.delete(token);
    return false;
  }
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(parts[0]).digest('hex');
  const a = Buffer.from(parts[1]);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function revokeSessionToken(token: string | undefined): void {
  if (token) activeSessions.delete(token);
}

export function extractBearerToken(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  // Allow query token ONLY on file download endpoints when triggered via browser link
  if (typeof req.query.downloadToken === 'string' && req.method === 'GET' && req.path.endsWith('/download')) {
    return req.query.downloadToken;
  }
  return undefined;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = extractBearerToken(req);
  if (!verifySessionToken(token)) {
    res.status(401).json({
      error: 'Authentication required',
      code: 'UNAUTHORIZED',
    });
    return;
  }
  next();
}
