import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config();

const ROOT_DIR = process.cwd();
const WORKSPACE_DIR = path.resolve(ROOT_DIR, process.env.WORKSPACE_DIR || './FreelanceAgentHub');
const PROJECTS_DIR = path.join(WORKSPACE_DIR, 'projects');
const DATA_DIR = path.join(WORKSPACE_DIR, 'data');
const BACKUPS_DIR = path.join(WORKSPACE_DIR, 'backups');
const DB_PATH = path.resolve(ROOT_DIR, process.env.DB_PATH || path.join(DATA_DIR, 'hub.db'));
const KEY_FILE_PATH = path.resolve(
  ROOT_DIR,
  process.env.HUB_KEY_FILE || path.join(WORKSPACE_DIR, '.hub-secret.key'),
);
const PID_FILE_PATH = path.resolve(ROOT_DIR, process.env.HUB_PID_FILE || path.join(ROOT_DIR, '.hub.pid'));

export type EncryptionKeySource = 'env' | 'keyfile' | 'ephemeral_test';

let cachedKeyBuffer: Buffer | null = null;
let cachedKeySource: EncryptionKeySource = 'env';
let cachedEnvKeySnapshot: string | undefined;
let ephemeralTestKey: Buffer | null = null;
let lastKeyValidationStatus: {
  ok: boolean;
  checkedCount: number;
  failedProviderIds: string[];
  message: string;
} = {
  ok: true,
  checkedCount: 0,
  failedProviderIds: [],
  message: 'No stored encrypted provider credentials checked yet.',
};

function loadOrCreatePersistentKeyFile(): Buffer {
  // Never silently replace an existing key file; fail loudly if unreadable/corrupt
  if (fs.existsSync(KEY_FILE_PATH)) {
    const stat = fs.lstatSync(KEY_FILE_PATH);
    if (stat.isSymbolicLink()) {
      throw new Error(`Security error: encryption key file must not be a symbolic link (${KEY_FILE_PATH})`);
    }
    const raw = fs.readFileSync(KEY_FILE_PATH, 'utf8').trim();
    if (raw.length < 32) {
      throw new Error(
        `Security error: persistent encryption key file at ${KEY_FILE_PATH} is invalid or truncated. Refusing to overwrite existing key.`,
      );
    }
    return crypto.createHash('sha256').update(raw).digest();
  }

  fs.mkdirSync(path.dirname(KEY_FILE_PATH), { recursive: true });
  const generatedHex = crypto.randomBytes(32).toString('hex');
  try {
    // Exclusive create ('wx') ensures concurrent startups never overwrite a key file
    fs.writeFileSync(KEY_FILE_PATH, `${generatedHex}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try {
      fs.chmodSync(KEY_FILE_PATH, 0o600);
    } catch {
      // chmod may be a no-op on Windows NTFS
    }
    return crypto.createHash('sha256').update(generatedHex).digest();
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
      const existing = fs.readFileSync(KEY_FILE_PATH, 'utf8').trim();
      return crypto.createHash('sha256').update(existing).digest();
    }
    throw err;
  }
}

export function getEncryptionKeyBuffer(): Buffer {
  const envKey = process.env.HUB_SECRET_ENCRYPTION_KEY?.trim();
  if (envKey && envKey.length >= 16) {
    if (cachedKeyBuffer && cachedKeySource === 'env' && cachedEnvKeySnapshot === envKey) {
      return cachedKeyBuffer;
    }
    cachedKeyBuffer = crypto.createHash('sha256').update(envKey).digest();
    cachedKeySource = 'env';
    cachedEnvKeySnapshot = envKey;
    return cachedKeyBuffer;
  }

  // Unit tests running in-memory without an env key use an isolated in-memory test key
  if (process.env.VITEST === 'true' || process.env.NODE_ENV === 'test') {
    if (!ephemeralTestKey) {
      ephemeralTestKey = crypto.randomBytes(32);
    }
    cachedKeySource = 'ephemeral_test';
    return ephemeralTestKey;
  }

  if (cachedKeyBuffer && cachedKeySource === 'keyfile') {
    return cachedKeyBuffer;
  }

  cachedKeyBuffer = loadOrCreatePersistentKeyFile();
  cachedKeySource = 'keyfile';
  cachedEnvKeySnapshot = undefined;
  return cachedKeyBuffer;
}

export function getEncryptionKeyInfo(): {
  source: EncryptionKeySource;
  persistent: boolean;
  keyFilePath: string;
  validationStatus: typeof lastKeyValidationStatus;
} {
  // Ensure key is resolved
  getEncryptionKeyBuffer();
  return {
    source: cachedKeySource,
    persistent: cachedKeySource === 'env' || cachedKeySource === 'keyfile',
    keyFilePath: KEY_FILE_PATH,
    validationStatus: lastKeyValidationStatus,
  };
}

export function setKeyValidationStatus(status: typeof lastKeyValidationStatus): void {
  lastKeyValidationStatus = status;
}

export function resetEncryptionKeyCacheForTests(): void {
  cachedKeyBuffer = null;
  cachedEnvKeySnapshot = undefined;
}

export function encryptSecret(plaintext: string): string {
  if (!plaintext) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKeyBuffer(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptSecretStrict(ciphertext: string | null | undefined): {
  ok: boolean;
  plaintext: string;
  error?: string;
} {
  if (!ciphertext) return { ok: true, plaintext: '' };
  if (!ciphertext.startsWith('enc:v1:')) {
    return { ok: false, plaintext: '', error: 'Unrecognized ciphertext envelope format' };
  }
  try {
    const parts = ciphertext.split(':');
    if (parts.length !== 5) {
      return { ok: false, plaintext: '', error: 'Malformed ciphertext payload' };
    }
    const iv = Buffer.from(parts[2], 'base64');
    const authTag = Buffer.from(parts[3], 'base64');
    const encrypted = Buffer.from(parts[4], 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKeyBuffer(), iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    return { ok: true, plaintext };
  } catch {
    return {
      ok: false,
      plaintext: '',
      error: 'Failed to decrypt secret with current encryption key (key mismatch or corrupted record)',
    };
  }
}

export function decryptSecret(ciphertext: string | null | undefined): string {
  return decryptSecretStrict(ciphertext).plaintext;
}

export function ensureDirectories(): void {
  for (const dir of [WORKSPACE_DIR, PROJECTS_DIR, DATA_DIR, BACKUPS_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

// Bind to 127.0.0.1 by default on local/Windows systems; allow 0.0.0.0 only when explicitly configured via HOST or Cloud Run runtime
const DEFAULT_HOST = process.env.HOST?.trim() || (process.env.K_SERVICE ? '0.0.0.0' : '127.0.0.1');

export const CONFIG = {
  port: Number(process.env.PORT || 3000),
  host: DEFAULT_HOST,
  trustProxy: process.env.TRUST_PROXY === 'true' || Boolean(process.env.K_SERVICE),
  strictKeyCheck: process.env.HUB_STRICT_KEY_CHECK === 'true',
  isProduction: process.env.NODE_ENV === 'production',
  rootDir: ROOT_DIR,
  workspaceDir: WORKSPACE_DIR,
  projectsDir: PROJECTS_DIR,
  dataDir: DATA_DIR,
  backupsDir: BACKUPS_DIR,
  dbPath: DB_PATH,
  keyFilePath: KEY_FILE_PATH,
  pidFilePath: PID_FILE_PATH,
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
  ollamaDefaultModel: process.env.OLLAMA_DEFAULT_MODEL || 'llama3.1:8b',
  freeLlmBaseUrl: process.env.FREELLM_BASE_URL || '',
  freeLlmModel: process.env.FREELLM_MODEL || '',
  openAiCompatBaseUrl: process.env.OPENAI_COMPAT_BASE_URL || '',
  openAiCompatModel: process.env.OPENAI_COMPAT_MODEL || '',
  get adminPasscodeEnv(): string {
    return process.env.HUB_ADMIN_PASSCODE?.trim() || '';
  },
  get setupTokenEnv(): string {
    return process.env.HUB_SETUP_TOKEN?.trim() || '';
  },
};
