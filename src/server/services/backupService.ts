import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import type { Archiver } from 'archiver';
import { CONFIG, getEncryptionKeyBuffer, getEncryptionKeyInfo } from '../config.ts';

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
      return (obj.default as (format: 'zip', options?: { zlib?: { level?: number } }) => Archiver)('zip', opts);
    }
  }
  throw new Error('Failed to load archiver module');
}

export interface SqliteBackupVerificationResult {
  ok: boolean;
  integrityCheck: string;
  foreignKeyViolations: number;
  sha256: string;
  sizeBytes: number;
  tableCounts: Record<string, number>;
}

export interface BackupManifest {
  schemaVersion: number;
  createdAt: string;
  appName: string;
  nodeVersion: string;
  platform: string;
  hostname: string;
  database: {
    relativePath: string;
    backupMethod: 'sqlite_online_backup' | 'sqlite_vacuum_into';
    verification: SqliteBackupVerificationResult;
  };
  includedArtifacts: {
    projectsCount: number;
    projectIds: string[];
    runtimeLogsIncluded: string[];
    nonSecretConfigPath: string;
    restoreInstructionsPath: string;
  };
  excludedSecrets: Array<{
    item: string;
    reason: string;
    recoveryMethod: string;
  }>;
}

export interface FullBackupResult {
  archivePath: string;
  manifest: BackupManifest;
  archiveSizeBytes: number;
  archiveSha256: string;
}

export interface EncryptedKeyBackupPayload {
  format: 'freelance-hub-key-backup:v1';
  createdAt: string;
  kdf: {
    algorithm: 'scrypt';
    saltBase64: string;
    N: number;
    r: number;
    p: number;
    keyLen: number;
  };
  cipher: {
    algorithm: 'aes-256-gcm';
    ivBase64: string;
    authTagBase64: string;
    ciphertextBase64: string;
  };
  metadata: {
    keySource: string;
    fingerprintSha256Prefix: string;
  };
}

function sha256File(filePath: string): string {
  const hash = crypto.createHash('sha256');
  const buf = fs.readFileSync(filePath);
  hash.update(buf);
  return hash.digest('hex');
}

function tryRestrictFilePermissions(filePath: string): void {
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // chmod may be a no-op on Windows NTFS; scripts/backup.ps1 also enforces icacls
  }
}

/**
 * Performs a SQLite WAL-consistent online backup using Node's native SQLite backup API
 * (with automatic VACUUM INTO fallback) and verifies the resulting snapshot by reopening it
 * and running PRAGMA integrity_check and PRAGMA foreign_key_check.
 */
export async function createVerifiedSqliteBackup(
  sourceDbPath: string,
  destinationDbPath: string,
): Promise<{
  backupMethod: 'sqlite_online_backup' | 'sqlite_vacuum_into';
  verification: SqliteBackupVerificationResult;
}> {
  if (!fs.existsSync(sourceDbPath)) {
    throw new Error(`Source SQLite database does not exist: ${sourceDbPath}`);
  }

  fs.mkdirSync(path.dirname(destinationDbPath), { recursive: true });
  if (fs.existsSync(destinationDbPath)) {
    fs.rmSync(destinationDbPath, { force: true });
  }

  const sourceDb = new DatabaseSync(sourceDbPath);
  let backupMethod: 'sqlite_online_backup' | 'sqlite_vacuum_into' = 'sqlite_online_backup';

  try {
    sourceDb.exec('PRAGMA busy_timeout = 5000;');
    if (typeof sqliteBackup === 'function') {
      await sqliteBackup(sourceDb, destinationDbPath);
      backupMethod = 'sqlite_online_backup';
    } else {
      const escapedDest = destinationDbPath.replace(/'/g, "''");
      sourceDb.exec(`VACUUM INTO '${escapedDest}';`);
      backupMethod = 'sqlite_vacuum_into';
    }
  } finally {
    sourceDb.close();
  }

  tryRestrictFilePermissions(destinationDbPath);
  const verification = verifySqliteBackupFile(destinationDbPath);
  if (!verification.ok) {
    throw new Error(
      `SQLite backup verification failed (integrity=${verification.integrityCheck}, fkViolations=${verification.foreignKeyViolations})`,
    );
  }

  return { backupMethod, verification };
}

export function verifySqliteBackupFile(backupDbPath: string): SqliteBackupVerificationResult {
  if (!fs.existsSync(backupDbPath)) {
    throw new Error(`Backup database file not found: ${backupDbPath}`);
  }

  const verifyDb = new DatabaseSync(backupDbPath, { readOnly: true });
  try {
    const integrityRow = verifyDb.prepare('PRAGMA integrity_check;').get() as { integrity_check?: string } | undefined;
    const integrityCheck = String(integrityRow?.integrity_check || 'unknown');
    const fkRows = verifyDb.prepare('PRAGMA foreign_key_check;').all();
    const foreignKeyViolations = fkRows.length;

    const tables = verifyDb
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>;

    const tableCounts: Record<string, number> = {};
    for (const t of tables) {
      if (!/^[a-zA-Z0-9_]+$/.test(t.name)) continue;
      const cntRow = verifyDb.prepare(`SELECT COUNT(*) AS cnt FROM "${t.name}"`).get() as { cnt: number };
      tableCounts[t.name] = Number(cntRow?.cnt || 0);
    }

    const stat = fs.statSync(backupDbPath);
    const sha256 = sha256File(backupDbPath);

    return {
      ok: integrityCheck.toLowerCase() === 'ok' && foreignKeyViolations === 0,
      integrityCheck,
      foreignKeyViolations,
      sha256,
      sizeBytes: stat.size,
      tableCounts,
    };
  } finally {
    verifyDb.close();
  }
}

/**
 * Exports a separately encrypted backup of the active encryption key material (and optional
 * non-database auth config) protected by a user-supplied recovery passphrase (scrypt + AES-256-GCM).
 * Must be stored separately from the main database backup archive.
 */
export function exportEncryptedKeyBackup(
  passphrase: string,
  outputPath: string,
): { outputPath: string; fingerprintSha256Prefix: string; keySource: string } {
  const trimmedPass = passphrase.trim();
  if (trimmedPass.length < 12) {
    throw new Error('Recovery passphrase must be at least 12 characters long.');
  }

  const keyInfo = getEncryptionKeyInfo();
  let rawKeyMaterial = '';
  if (keyInfo.source === 'env' && process.env.HUB_SECRET_ENCRYPTION_KEY?.trim()) {
    rawKeyMaterial = process.env.HUB_SECRET_ENCRYPTION_KEY.trim();
  } else if (keyInfo.source === 'keyfile' && fs.existsSync(keyInfo.keyFilePath)) {
    rawKeyMaterial = fs.readFileSync(keyInfo.keyFilePath, 'utf8').trim();
  } else {
    // Fallback for test/ephemeral environments: export hex representation of derived key
    rawKeyMaterial = getEncryptionKeyBuffer().toString('hex');
  }

  const derivedFingerprint = crypto
    .createHash('sha256')
    .update(getEncryptionKeyBuffer())
    .digest('hex')
    .slice(0, 16);

  const plaintextPayload = JSON.stringify({
    HUB_SECRET_ENCRYPTION_KEY: rawKeyMaterial,
    keySource: keyInfo.source,
    exportedAt: new Date().toISOString(),
  });

  const salt = crypto.randomBytes(32);
  const N = 32768;
  const r = 8;
  const p = 1;
  const keyLen = 32;
  const wrappingKey = crypto.scryptSync(trimmedPass, salt, keyLen, { N, r, p, maxmem: 64 * 1024 * 1024 });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', wrappingKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintextPayload, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const envelope: EncryptedKeyBackupPayload = {
    format: 'freelance-hub-key-backup:v1',
    createdAt: new Date().toISOString(),
    kdf: {
      algorithm: 'scrypt',
      saltBase64: salt.toString('base64'),
      N,
      r,
      p,
      keyLen,
    },
    cipher: {
      algorithm: 'aes-256-gcm',
      ivBase64: iv.toString('base64'),
      authTagBase64: authTag.toString('base64'),
      ciphertextBase64: encrypted.toString('base64'),
    },
    metadata: {
      keySource: keyInfo.source,
      fingerprintSha256Prefix: derivedFingerprint,
    },
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(envelope, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  tryRestrictFilePermissions(outputPath);

  return {
    outputPath,
    fingerprintSha256Prefix: derivedFingerprint,
    keySource: keyInfo.source,
  };
}

export function restoreEncryptedKeyBackup(
  encryptedBackupPath: string,
  passphrase: string,
): { encryptionKey: string; keySource: string; exportedAt: string; fingerprintSha256Prefix: string } {
  if (!fs.existsSync(encryptedBackupPath)) {
    throw new Error(`Encrypted key backup not found: ${encryptedBackupPath}`);
  }
  const raw = JSON.parse(fs.readFileSync(encryptedBackupPath, 'utf8')) as EncryptedKeyBackupPayload;
  if (raw.format !== 'freelance-hub-key-backup:v1') {
    throw new Error('Unsupported key backup format.');
  }

  const salt = Buffer.from(raw.kdf.saltBase64, 'base64');
  const iv = Buffer.from(raw.cipher.ivBase64, 'base64');
  const authTag = Buffer.from(raw.cipher.authTagBase64, 'base64');
  const ciphertext = Buffer.from(raw.cipher.ciphertextBase64, 'base64');

  const wrappingKey = crypto.scryptSync(passphrase.trim(), salt, raw.kdf.keyLen, {
    N: raw.kdf.N,
    r: raw.kdf.r,
    p: raw.kdf.p,
    maxmem: 64 * 1024 * 1024,
  });

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', wrappingKey, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    const parsed = JSON.parse(decrypted) as {
      HUB_SECRET_ENCRYPTION_KEY: string;
      keySource: string;
      exportedAt: string;
    };
    return {
      encryptionKey: parsed.HUB_SECRET_ENCRYPTION_KEY,
      keySource: parsed.keySource,
      exportedAt: parsed.exportedAt,
      fingerprintSha256Prefix: raw.metadata.fingerprintSha256Prefix,
    };
  } catch {
    throw new Error('Failed to decrypt key backup: invalid recovery passphrase or corrupted key archive.');
  }
}

function buildSanitizedRuntimeConfig(): Record<string, unknown> {
  return {
    note: 'Non-secret runtime settings snapshot. All credentials, encryption keys, passcodes, and tokens are intentionally omitted.',
    HOST: CONFIG.host,
    PORT: CONFIG.port,
    TRUST_PROXY: CONFIG.trustProxy,
    HUB_STRICT_KEY_CHECK: CONFIG.strictKeyCheck,
    WORKSPACE_DIR: path.relative(CONFIG.rootDir, CONFIG.workspaceDir) || './FreelanceAgentHub',
    OLLAMA_BASE_URL: CONFIG.ollamaBaseUrl,
    OLLAMA_DEFAULT_MODEL: CONFIG.ollamaDefaultModel,
    FREELLM_BASE_URL: CONFIG.freeLlmBaseUrl || null,
    FREELLM_MODEL: CONFIG.freeLlmModel || null,
    OPENAI_COMPAT_BASE_URL: CONFIG.openAiCompatBaseUrl || null,
    OPENAI_COMPAT_MODEL: CONFIG.openAiCompatModel || null,
  };
}

function buildRestoreInstructionsMarkdown(): string {
  return [
    '# Freelance AI Agent Hub — Disaster Recovery & Restore Procedure',
    '',
    'This backup archive contains:',
    '- `data/hub.db` — A SQLite WAL-consistent, integrity-verified database snapshot.',
    '- `projects/` — All isolated project workspaces and generated deliverables.',
    '- `logs/` — Recent runtime server logs (if present).',
    '- `config/non_secret_config.json` — Non-secret host/port/model configuration snapshot.',
    '- `backup_manifest.json` — SHA-256 checksums, integrity verification output, and table row counts.',
    '',
    '## Intentionally Excluded Secrets',
    'For security, `.env`, `HUB_SECRET_ENCRYPTION_KEY`, `FreelanceAgentHub/.hub-secret.key`, `HUB_ADMIN_PASSCODE`, and `HUB_SETUP_TOKEN` are **NOT** inside this ZIP archive.',
    '',
    '## Step-by-Step Restore on a New Machine or Cloud Server',
    '1. Install Node.js 22.13+ and run `npm install && npm run build` (or `.\\scripts\\install.ps1` on Windows).',
    '2. Ensure the Hub server is stopped (`\\.\\scripts\\stop.ps1` on Windows).',
    '3. Restore `data/hub.db` into `FreelanceAgentHub/data/hub.db` and remove any old `hub.db-wal` / `hub.db-shm` files.',
    '4. Restore `projects/` into `FreelanceAgentHub/projects/`.',
    '5. **Restore the Encryption Key** (required to decrypt stored AI provider keys in `hub.db`):',
    '   - Decrypt your separate encrypted key backup file (`*.keybackup.enc.json`):',
    '     ```bash',
    '     npx tsx src/server/db/backup.ts --restore-key <path-to-keybackup.enc.json>',
    '     ```',
    '   - Place the recovered `HUB_SECRET_ENCRYPTION_KEY` into your `.env` file (or save it to `FreelanceAgentHub/.hub-secret.key` with owner-only permissions).',
    '   - If you do not have the original encryption key, the Hub will still start (unless `HUB_STRICT_KEY_CHECK=true`), warn you about undecryptable provider keys, and allow you to re-enter them in Settings.',
    '6. Reapply desired non-secret settings (`PORT`, `HOST`, `OLLAMA_BASE_URL`, etc.) from `config/non_secret_config.json` into `.env`.',
    '7. Start the Hub (`\\.\\scripts\\start.ps1` or `npm start`) and verify health.',
  ].join('\n');
}

function appendDirectoryExcludingSymlinks(
  archive: Archiver,
  sourceDir: string,
  archivePrefix: string,
  maxFileSizeBytes?: number,
): string[] {
  const included: string[] = [];
  if (!fs.existsSync(sourceDir)) return included;

  const walk = (absDir: string, relDir: string) => {
    const entries = fs.readdirSync(absDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue; // never follow symlinks into backups
      const absChild = path.join(absDir, entry.name);
      const relChild = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(absChild, relChild);
      } else if (entry.isFile()) {
        const stat = fs.statSync(absChild);
        if (maxFileSizeBytes && stat.size > maxFileSizeBytes) continue;
        const archivePath = `${archivePrefix}/${relChild}`.replace(/\\/g, '/');
        archive.file(absChild, { name: archivePath });
        included.push(relChild);
      }
    }
  };

  walk(sourceDir, '');
  return included;
}

export async function createFullVerifiedBackup(options?: {
  dbPath?: string;
  workspaceDir?: string;
  outputArchivePath?: string;
}): Promise<FullBackupResult> {
  const dbPath = options?.dbPath || CONFIG.dbPath;
  const workspaceDir = options?.workspaceDir || CONFIG.workspaceDir;
  const backupsDir = path.join(workspaceDir, 'backups');
  fs.mkdirSync(backupsDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const archivePath =
    options?.outputArchivePath || path.join(backupsDir, `FreelanceAgentHub_Backup_${stamp}.zip`);
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub_backup_'));
  const stagedDbPath = path.join(tempDir, 'hub.db');

  try {
    const { backupMethod, verification } = await createVerifiedSqliteBackup(dbPath, stagedDbPath);

    const projectsDir = path.join(workspaceDir, 'projects');
    const projectIds = fs.existsSync(projectsDir)
      ? fs
          .readdirSync(projectsDir, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.isSymbolicLink())
          .map((e) => e.name)
      : [];

    const logsDir = path.join(workspaceDir, 'logs');
    const nonSecretConfig = buildSanitizedRuntimeConfig();
    const restoreInstructions = buildRestoreInstructionsMarkdown();

    const runtimeLogsIncluded: string[] = [];

    await new Promise<void>((resolve, reject) => {
      const archive = createZipArchive();
      const output = fs.createWriteStream(archivePath, { mode: 0o600 });

      output.on('close', () => resolve());
      output.on('error', (err: Error) => reject(err));
      archive.on('error', (err: Error) => {
        output.destroy();
        reject(err);
      });

      archive.pipe(output);

      // 1. Consistent verified SQLite DB snapshot
      archive.file(stagedDbPath, { name: 'data/hub.db' });

      // 2. Project workspaces (skipping symlinks)
      appendDirectoryExcludingSymlinks(archive, projectsDir, 'projects');

      // 3. Recent runtime logs (capped at 5 MB per log file)
      if (fs.existsSync(logsDir)) {
        const logs = appendDirectoryExcludingSymlinks(archive, logsDir, 'logs', 5 * 1024 * 1024);
        runtimeLogsIncluded.push(...logs);
      }

      // 4. Sanitized non-secret runtime config & restore procedure
      archive.append(`${JSON.stringify(nonSecretConfig, null, 2)}\n`, { name: 'config/non_secret_config.json' });
      archive.append(`${restoreInstructions}\n`, { name: 'RESTORE_INSTRUCTIONS.md' });

      // 5. Complete backup manifest
      const manifest: BackupManifest = {
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        appName: 'Freelance AI Agent Hub',
        nodeVersion: process.version,
        platform: process.platform,
        hostname: os.hostname(),
        database: {
          relativePath: 'data/hub.db',
          backupMethod,
          verification,
        },
        includedArtifacts: {
          projectsCount: projectIds.length,
          projectIds,
          runtimeLogsIncluded,
          nonSecretConfigPath: 'config/non_secret_config.json',
          restoreInstructionsPath: 'RESTORE_INSTRUCTIONS.md',
        },
        excludedSecrets: [
          {
            item: '.env',
            reason: 'Contains local secrets, setup tokens, and environment credentials.',
            recoveryMethod: 'Recreate from .env.example + config/non_secret_config.json + decrypted key backup.',
          },
          {
            item: 'HUB_SECRET_ENCRYPTION_KEY / FreelanceAgentHub/.hub-secret.key',
            reason: 'Never bundle the decryption key inside the same archive as encrypted database records.',
            recoveryMethod: 'Export separately via npm run backup:key or scripts/backup.ps1 -BackupKeyPassphrase ... and store in a password manager or offline vault.',
          },
          {
            item: 'HUB_ADMIN_PASSCODE / HUB_SETUP_TOKEN',
            reason: 'Authentication credentials are excluded from data archives.',
            recoveryMethod: 'Already hashed in hub.db (auth_credentials) or set via HUB_ADMIN_PASSCODE environment variable on target server.',
          },
        ],
      };

      archive.append(`${JSON.stringify(manifest, null, 2)}\n`, { name: 'backup_manifest.json' });
      // Stash manifest on temp file for return after close
      fs.writeFileSync(path.join(tempDir, 'manifest.json'), JSON.stringify(manifest), 'utf8');

      void archive.finalize();
    });

    tryRestrictFilePermissions(archivePath);
    const manifest = JSON.parse(fs.readFileSync(path.join(tempDir, 'manifest.json'), 'utf8')) as BackupManifest;
    const stat = fs.statSync(archivePath);
    const archiveSha256 = sha256File(archivePath);

    return {
      archivePath,
      manifest,
      archiveSizeBytes: stat.size,
      archiveSha256,
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
