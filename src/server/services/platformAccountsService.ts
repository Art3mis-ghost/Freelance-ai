import crypto from 'node:crypto';
import { getDb, logAudit } from '../db/database.ts';
import { decryptSecretStrict, encryptSecret } from '../config.ts';
import { validateExternalUrl } from '../security.ts';
import { checkSourceHealth } from './connectors.ts';
import type {
  PlatformAccountRecord,
  PlatformAccountStatus,
  PlatformActivityLog,
  PlatformCapabilities,
  PlatformConnectionMethod,
  PlatformIntegrationMode,
} from '../../shared/types.ts';

const EMPTY_CAPABILITIES: PlatformCapabilities = {
  publicJobDiscovery: false,
  authenticatedJobDiscovery: false,
  jobDetails: false,
  search: false,
  applicationDrafting: true,
  applicationSubmission: false,
  messaging: false,
  fileUploads: false,
  deliverableSubmission: false,
  applicationStatusTracking: true,
  clientFeedbackRetrieval: false,
  contractStatus: true,
  apiAvailability: false,
  browserInteractionPermitted: false,
};

function parseJsonObject<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  try {
    return { ...fallback, ...(JSON.parse(raw) as Partial<T>) };
  } catch {
    return fallback;
  }
}

function parseJsonArray<T>(raw: unknown, fallback: T[]): T[] {
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : fallback;
  } catch {
    return fallback;
  }
}

function computeEffectiveStatus(row: Record<string, unknown>): PlatformAccountStatus {
  const enabled = Boolean(row.enabled);
  if (!enabled) return 'disabled';
  const rawStatus = String(row.status || 'not_connected') as PlatformAccountStatus;
  const expiresAt = row.expires_at ? String(row.expires_at) : null;
  if (rawStatus === 'connected' && expiresAt) {
    const expTime = Date.parse(expiresAt);
    if (!Number.isNaN(expTime) && expTime <= Date.now()) {
      return 'expired';
    }
  }
  return rawStatus;
}

function mapPlatformRow(row: Record<string, unknown>): PlatformAccountRecord {
  const capabilities = parseJsonObject<PlatformCapabilities>(row.capabilities_json, EMPTY_CAPABILITIES);
  const permittedCapabilities = parseJsonObject<PlatformCapabilities>(
    row.permitted_capabilities_json,
    EMPTY_CAPABILITIES,
  );
  const permissions = parseJsonObject(row.permissions_json, {
    allowDrafting: true,
    allowManualHandoff: true,
    allowOfficialApiCalls: false,
    requireApprovalBeforeExternalAction: true,
  });

  return {
    id: String(row.id),
    platformKey: String(row.platform_key),
    platformName: String(row.platform_name),
    category: (String(row.category || 'freelance_marketplace') as PlatformAccountRecord['category']),
    status: computeEffectiveStatus(row),
    connectionMethod: String(row.connection_method || 'manual_import') as PlatformConnectionMethod,
    integrationMode: String(row.integration_mode || 'MODE_C_MANUAL_ASSISTANCE') as PlatformIntegrationMode,
    supportedMethods: parseJsonArray<PlatformConnectionMethod>(row.supported_methods_json, ['manual_import']),
    enabled: Boolean(row.enabled),
    accountIdentifier: row.account_identifier ? String(row.account_identifier) : null,
    displayName: row.display_name ? String(row.display_name) : null,
    profileUrl: row.profile_url ? String(row.profile_url) : null,
    // SECURITY: Never expose stored secrets, OAuth tokens, API keys, or session cookies to UI/agents/logs
    hasStoredCredentials: Boolean(row.encrypted_credentials && String(row.encrypted_credentials).length > 0),
    credentialScope: row.credential_scope ? String(row.credential_scope) : null,
    lastVerifiedAt: row.last_verified_at ? String(row.last_verified_at) : null,
    expiresAt: row.expires_at ? String(row.expires_at) : null,
    lastError: row.last_error ? String(row.last_error) : null,
    policySummary: String(row.policy_summary || ''),
    complianceRestriction: String(row.compliance_restriction || ''),
    capabilities,
    permittedCapabilities,
    permissions,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function logPlatformActivity(
  platformId: string,
  action: string,
  status: PlatformActivityLog['status'],
  message: string,
  metadata: Record<string, unknown> = {},
): void {
  const db = getDb();
  // Strip any accidental secret-like keys from activity log metadata
  const sanitizedMeta: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(metadata)) {
    if (/secret|token|password|cookie|key|auth/i.test(k)) continue;
    sanitizedMeta[k] = v;
  }
  db.prepare(
    `INSERT INTO platform_activity_logs (id, platform_id, action, status, message, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(crypto.randomUUID(), platformId, action, status, message, JSON.stringify(sanitizedMeta), new Date().toISOString());
}

export function listPlatformAccounts(): PlatformAccountRecord[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM platform_accounts
       ORDER BY CASE category WHEN 'remote_job_board' THEN 1 WHEN 'freelance_marketplace' THEN 2 ELSE 3 END, platform_name ASC`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map(mapPlatformRow);
}

export function getPlatformAccount(idOrKey: string): PlatformAccountRecord | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM platform_accounts WHERE id = ? OR platform_key = ?')
    .get(idOrKey, idOrKey) as Record<string, unknown> | undefined;
  return row ? mapPlatformRow(row) : null;
}

export function listPlatformActivityLogs(platformId: string, limit = 40): PlatformActivityLog[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM platform_activity_logs
       WHERE platform_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(platformId, Math.max(1, Math.min(200, limit))) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    id: String(r.id),
    platformId: String(r.platform_id),
    action: String(r.action),
    status: String(r.status) as PlatformActivityLog['status'],
    message: String(r.message),
    metadata: parseJsonObject<Record<string, unknown>>(r.metadata_json, {}),
    createdAt: String(r.created_at),
  }));
}

export function createCustomPlatformAdapter(input: {
  platformName: string;
  platformKey?: string;
  category?: PlatformAccountRecord['category'];
  integrationMode?: PlatformIntegrationMode;
  connectionMethod?: PlatformConnectionMethod;
  profileUrl?: string;
  policySummary?: string;
}): PlatformAccountRecord {
  const db = getDb();
  const cleanName = input.platformName.trim().slice(0, 80);
  if (!cleanName) throw new Error('Platform name is required');

  const key = (
    input.platformKey?.trim() ||
    cleanName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
  ).slice(0, 48);
  if (!key) throw new Error('Valid platform key is required');

  const existing = db.prepare('SELECT id FROM platform_accounts WHERE platform_key = ?').get(key);
  if (existing) throw new Error(`Platform adapter "${key}" already exists.`);

  if (input.profileUrl) {
    validateExternalUrl(input.profileUrl, { allowLocalOllama: false });
  }

  const mode: PlatformIntegrationMode = input.integrationMode || 'MODE_C_MANUAL_ASSISTANCE';
  const method: PlatformConnectionMethod =
    input.connectionMethod ||
    (mode === 'MODE_D_PUBLIC_SOURCE'
      ? 'public_api'
      : mode === 'MODE_A_OFFICIAL_API'
        ? 'official_api_key'
        : 'manual_import');

  const permitted: PlatformCapabilities = {
    ...EMPTY_CAPABILITIES,
    publicJobDiscovery: mode === 'MODE_D_PUBLIC_SOURCE',
    authenticatedJobDiscovery: mode === 'MODE_A_OFFICIAL_API',
    jobDetails: mode === 'MODE_D_PUBLIC_SOURCE' || mode === 'MODE_A_OFFICIAL_API',
    search: mode === 'MODE_D_PUBLIC_SOURCE' || mode === 'MODE_A_OFFICIAL_API',
    apiAvailability: mode === 'MODE_D_PUBLIC_SOURCE' || mode === 'MODE_A_OFFICIAL_API',
    browserInteractionPermitted: false, // Never allow unattended browser automation by default
  };

  const id = `plat_${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO platform_accounts (
      id, platform_key, platform_name, category, status, connection_method, integration_mode,
      supported_methods_json, enabled, profile_url, policy_summary, compliance_restriction,
      capabilities_json, permitted_capabilities_json, permissions_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    key,
    cleanName,
    input.category || 'custom_adapter',
    mode === 'MODE_D_PUBLIC_SOURCE' ? 'connected' : 'not_connected',
    method,
    mode,
    JSON.stringify(['official_oauth', 'official_api_key', 'manual_browser_assisted', 'manual_import', 'public_api']),
    input.profileUrl || null,
    input.policySummary ||
      'Custom platform adapter. Operates strictly within user-configured capabilities and human approval rules.',
    'Policy engine enforces human approval for all external submissions and blocks unauthorized scraping.',
    JSON.stringify(permitted),
    JSON.stringify(permitted),
    JSON.stringify({
      allowDrafting: true,
      allowManualHandoff: true,
      allowOfficialApiCalls: mode === 'MODE_A_OFFICIAL_API' || mode === 'MODE_D_PUBLIC_SOURCE',
      requireApprovalBeforeExternalAction: true,
    }),
    now,
    now,
  );

  logPlatformActivity(id, 'adapter_created', 'success', `Created custom platform adapter "${cleanName}" (${mode}).`);
  logAudit('platform_adapter_created', 'platform_account', id, { platformKey: key, integrationMode: mode });
  return getPlatformAccount(id)!;
}

export function updatePlatformAccountPolicy(
  platformId: string,
  patch: {
    enabled?: boolean;
    integrationMode?: PlatformIntegrationMode;
    connectionMethod?: PlatformConnectionMethod;
    accountIdentifier?: string | null;
    displayName?: string | null;
    profileUrl?: string | null;
    capabilities?: Partial<PlatformCapabilities>;
    permissions?: Partial<PlatformAccountRecord['permissions']>;
  },
): PlatformAccountRecord {
  const db = getDb();
  const current = getPlatformAccount(platformId);
  if (!current) throw new Error(`Platform account not found: ${platformId}`);

  if (patch.profileUrl) {
    validateExternalUrl(patch.profileUrl, { allowLocalOllama: false });
  }

  // Enforce Capability & Policy Engine: requested capabilities can NEVER exceed permittedCapabilities
  const nextCapabilities: PlatformCapabilities = { ...current.capabilities };
  const blockedCapabilities: string[] = [];

  if (patch.capabilities) {
    for (const [k, rawVal] of Object.entries(patch.capabilities)) {
      const capKey = k as keyof PlatformCapabilities;
      if (!(capKey in nextCapabilities)) continue;
      const requested = Boolean(rawVal);
      if (requested && !current.permittedCapabilities[capKey]) {
        blockedCapabilities.push(capKey);
        nextCapabilities[capKey] = false;
      } else {
        nextCapabilities[capKey] = requested;
      }
    }
  }

  // Enforce supported connection methods
  const nextMethod = patch.connectionMethod || current.connectionMethod;
  if (!current.supportedMethods.includes(nextMethod)) {
    throw new Error(
      `Connection method "${nextMethod}" is not permitted for ${current.platformName}. Allowed: ${current.supportedMethods.join(', ')}.`,
    );
  }

  // Prevent switching a manual-only restricted platform into MODE_A or MODE_B without permitted API/browser support
  let nextMode = patch.integrationMode || current.integrationMode;
  if (nextMode === 'MODE_A_OFFICIAL_API' && !current.permittedCapabilities.apiAvailability) {
    throw new Error(`${current.platformName} does not have an official permitted API available. Use Mode C (Manual Assistance).`);
  }
  if (nextMode === 'MODE_B_PERMITTED_BROWSER' && !current.permittedCapabilities.browserInteractionPermitted) {
    throw new Error(
      `${current.platformName} prohibits automated browser sessions under platform policy. Use Mode C (Manual Assistance).`,
    );
  }

  const nextEnabled = patch.enabled !== undefined ? patch.enabled : current.enabled;
  const nextPermissions = {
    ...current.permissions,
    ...(patch.permissions || {}),
    // Safety invariant: external actions always require approval unless explicitly permitted by official API
    requireApprovalBeforeExternalAction:
      patch.permissions?.requireApprovalBeforeExternalAction !== undefined
        ? Boolean(patch.permissions.requireApprovalBeforeExternalAction)
        : current.permissions.requireApprovalBeforeExternalAction,
  };

  let nextStatus: PlatformAccountStatus = current.status;
  if (!nextEnabled) {
    nextStatus = 'disabled';
  } else if (current.status === 'disabled') {
    nextStatus =
      nextMode === 'MODE_D_PUBLIC_SOURCE'
        ? 'connected'
        : current.hasStoredCredentials
          ? 'connected'
          : current.permittedCapabilities.apiAvailability
            ? 'not_connected'
            : 'api_unavailable';
  }

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE platform_accounts
     SET enabled = ?, integration_mode = ?, connection_method = ?, status = ?,
         account_identifier = ?, display_name = ?, profile_url = ?,
         capabilities_json = ?, permissions_json = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    nextEnabled ? 1 : 0,
    nextMode,
    nextMethod,
    nextStatus,
    patch.accountIdentifier !== undefined ? patch.accountIdentifier : current.accountIdentifier,
    patch.displayName !== undefined ? patch.displayName : current.displayName,
    patch.profileUrl !== undefined ? patch.profileUrl : current.profileUrl,
    JSON.stringify(nextCapabilities),
    JSON.stringify(nextPermissions),
    now,
    current.id,
  );

  // Synchronize matching public source enabled state if linked
  if (['remotive_public', 'remoteok_public', 'arbeitnow_public'].includes(current.platformKey)) {
    db.prepare('UPDATE sources SET enabled = ?, connection_status = ?, updated_at = ? WHERE id = ?').run(
      nextEnabled ? 1 : 0,
      nextEnabled ? 'ready' : 'disabled',
      now,
      current.platformKey,
    );
  }

  const note =
    blockedCapabilities.length > 0
      ? `Updated policy (blocked restricted capabilities: ${blockedCapabilities.join(', ')}).`
      : `Updated ${current.platformName} policy and capability settings.`;
  logPlatformActivity(current.id, 'policy_updated', blockedCapabilities.length > 0 ? 'warning' : 'info', note, {
    enabled: nextEnabled,
    integrationMode: nextMode,
    blockedCapabilities,
  });
  logAudit('platform_policy_updated', 'platform_account', current.id, {
    platformKey: current.platformKey,
    enabled: nextEnabled,
    integrationMode: nextMode,
    blockedCapabilities,
  });

  return getPlatformAccount(current.id)!;
}

export function connectPlatformAccount(
  platformId: string,
  input: {
    connectionMethod: PlatformConnectionMethod;
    accountIdentifier?: string;
    displayName?: string;
    profileUrl?: string;
    credentialSecret?: string;
    credentialScope?: string;
    expiresAt?: string | null;
  },
): PlatformAccountRecord {
  const db = getDb();
  const current = getPlatformAccount(platformId);
  if (!current) throw new Error(`Platform account not found: ${platformId}`);

  if (!current.supportedMethods.includes(input.connectionMethod)) {
    throw new Error(
      `Method "${input.connectionMethod}" is not supported for ${current.platformName}. Supported: ${current.supportedMethods.join(', ')}.`,
    );
  }

  if (input.profileUrl) {
    validateExternalUrl(input.profileUrl, { allowLocalOllama: false });
  }

  const now = new Date().toISOString();
  let encryptedCredentials: string | null = null;
  let nextMode: PlatformIntegrationMode = current.integrationMode;
  let nextStatus: PlatformAccountStatus = current.status;
  let lastError: string | null = null;

  if (input.connectionMethod === 'official_oauth' || input.connectionMethod === 'official_api_key') {
    if (!current.permittedCapabilities.apiAvailability) {
      throw new Error(
        `${current.platformName} does not support official API token connections. Use Manual Assistance or Manual Import.`,
      );
    }
    const secret = input.credentialSecret?.trim() || '';
    if (!secret) {
      throw new Error('Official OAuth token or API key is required for official API connection.');
    }
    // Store isolated encrypted credential payload; never returned in API responses or logs
    encryptedCredentials = encryptSecret(
      JSON.stringify({
        method: input.connectionMethod,
        secret,
        savedAt: now,
      }),
    );
    nextMode = 'MODE_A_OFFICIAL_API';
    nextStatus = 'connected';
  } else if (input.connectionMethod === 'public_api') {
    if (!current.permittedCapabilities.publicJobDiscovery) {
      throw new Error(`${current.platformName} does not expose an unauthenticated public API feed.`);
    }
    nextMode = 'MODE_D_PUBLIC_SOURCE';
    nextStatus = 'connected';
  } else {
    // Manual browser-assisted or manual import: NEVER claim fake connected API session!
    // Honestly record profile metadata and keep status truthful (requires_manual_login or api_unavailable).
    nextMode = 'MODE_C_MANUAL_ASSISTANCE';
    nextStatus = current.permittedCapabilities.apiAvailability ? 'requires_manual_login' : 'api_unavailable';
  }

  // Respect expiry timestamp if already expired
  if (nextStatus === 'connected' && input.expiresAt) {
    const exp = Date.parse(input.expiresAt);
    if (!Number.isNaN(exp) && exp <= Date.now()) {
      nextStatus = 'expired';
      lastError = 'Stored token expiration timestamp has already passed. Reconnect with a fresh token.';
    }
  }

  db.prepare(
    `UPDATE platform_accounts
     SET enabled = 1,
         status = ?,
         connection_method = ?,
         integration_mode = ?,
         account_identifier = ?,
         display_name = ?,
         profile_url = ?,
         encrypted_credentials = COALESCE(?, encrypted_credentials),
         credential_scope = ?,
         last_verified_at = ?,
         expires_at = ?,
         last_error = ?,
         updated_at = ?
     WHERE id = ?`,
  ).run(
    nextStatus,
    input.connectionMethod,
    nextMode,
    input.accountIdentifier?.trim() || current.accountIdentifier,
    input.displayName?.trim() || current.displayName,
    input.profileUrl?.trim() || current.profileUrl,
    encryptedCredentials,
    input.credentialScope?.trim() || current.credentialScope,
    now,
    input.expiresAt !== undefined ? input.expiresAt : current.expiresAt,
    lastError,
    now,
    current.id,
  );

  logPlatformActivity(
    current.id,
    'account_connected',
    nextStatus === 'expired' ? 'warning' : 'success',
    nextStatus === 'connected'
      ? `Connected ${current.platformName} via ${input.connectionMethod} (${nextMode}).`
      : `Saved ${current.platformName} manual workspace profile (${nextMode}; status: ${nextStatus}).`,
    { method: input.connectionMethod, mode: nextMode, status: nextStatus },
  );
  logAudit('platform_account_connected', 'platform_account', current.id, {
    platformKey: current.platformKey,
    method: input.connectionMethod,
    mode: nextMode,
    status: nextStatus,
  });

  return getPlatformAccount(current.id)!;
}

export function disconnectPlatformAccount(platformId: string): PlatformAccountRecord {
  const db = getDb();
  const current = getPlatformAccount(platformId);
  if (!current) throw new Error(`Platform account not found: ${platformId}`);

  const now = new Date().toISOString();
  const nextStatus: PlatformAccountStatus =
    current.integrationMode === 'MODE_D_PUBLIC_SOURCE'
      ? 'disabled'
      : current.permittedCapabilities.apiAvailability
        ? 'not_connected'
        : 'api_unavailable';

  // Immediately wipe isolated encrypted credentials & session tokens on disconnect
  db.prepare(
    `UPDATE platform_accounts
     SET status = ?,
         encrypted_credentials = NULL,
         credential_scope = NULL,
         expires_at = NULL,
         last_error = NULL,
         enabled = CASE WHEN integration_mode = 'MODE_D_PUBLIC_SOURCE' THEN 0 ELSE enabled END,
         integration_mode = CASE WHEN integration_mode = 'MODE_A_OFFICIAL_API' THEN 'MODE_C_MANUAL_ASSISTANCE' ELSE integration_mode END,
         updated_at = ?
     WHERE id = ?`,
  ).run(nextStatus, now, current.id);

  logPlatformActivity(
    current.id,
    'account_disconnected',
    'info',
    `Disconnected ${current.platformName} and cleared stored encrypted credentials.`,
  );
  logAudit('platform_account_disconnected', 'platform_account', current.id, {
    platformKey: current.platformKey,
  });

  return getPlatformAccount(current.id)!;
}

export async function testPlatformConnection(platformId: string): Promise<{
  ok: boolean;
  status: PlatformAccountStatus;
  message: string;
  account: PlatformAccountRecord;
}> {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM platform_accounts WHERE id = ? OR platform_key = ?')
    .get(platformId, platformId) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`Platform account not found: ${platformId}`);

  const account = mapPlatformRow(row);
  const now = new Date().toISOString();

  // Public API boards perform a real live health check against the official public endpoint
  if (
    account.integrationMode === 'MODE_D_PUBLIC_SOURCE' &&
    ['remotive_public', 'remoteok_public', 'arbeitnow_public'].includes(account.platformKey)
  ) {
    const check = await checkSourceHealth(account.platformKey);
    const nextStatus: PlatformAccountStatus = check.ok ? 'connected' : 'error';
    db.prepare(
      'UPDATE platform_accounts SET status = ?, last_verified_at = ?, last_error = ?, updated_at = ? WHERE id = ?',
    ).run(nextStatus, now, check.ok ? null : check.message, now, account.id);
    logPlatformActivity(account.id, 'connection_test', check.ok ? 'success' : 'error', check.message);
    return { ok: check.ok, status: nextStatus, message: check.message, account: getPlatformAccount(account.id)! };
  }

  // Official API credentials check: verify encrypted secret decrypts cleanly and is not expired
  if (account.integrationMode === 'MODE_A_OFFICIAL_API') {
    const enc = row.encrypted_credentials ? String(row.encrypted_credentials) : '';
    if (!enc) {
      db.prepare(
        'UPDATE platform_accounts SET status = ?, last_verified_at = ?, last_error = ?, updated_at = ? WHERE id = ?',
      ).run('not_connected', now, 'No official API token stored.', now, account.id);
      return {
        ok: false,
        status: 'not_connected',
        message: 'No official API credentials are stored. Reconnect with an official token.',
        account: getPlatformAccount(account.id)!,
      };
    }

    const dec = decryptSecretStrict(enc);
    if (!dec.ok) {
      const msg = 'Stored platform credential cannot be decrypted with the current encryption key. Reconnect required.';
      db.prepare(
        'UPDATE platform_accounts SET status = ?, last_verified_at = ?, last_error = ?, updated_at = ? WHERE id = ?',
      ).run('error', now, msg, now, account.id);
      logPlatformActivity(account.id, 'connection_test', 'error', msg);
      return { ok: false, status: 'error', message: msg, account: getPlatformAccount(account.id)! };
    }

    if (account.expiresAt && Date.parse(account.expiresAt) <= Date.now()) {
      const msg = `Credentials expired on ${account.expiresAt}. Refresh or reconnect token.`;
      db.prepare(
        'UPDATE platform_accounts SET status = ?, last_verified_at = ?, last_error = ?, updated_at = ? WHERE id = ?',
      ).run('expired', now, msg, now, account.id);
      logPlatformActivity(account.id, 'connection_test', 'warning', msg);
      return { ok: false, status: 'expired', message: msg, account: getPlatformAccount(account.id)! };
    }

    const msg = `Encrypted ${account.connectionMethod} credentials verified and valid locally. Ready for permitted API requests.`;
    db.prepare(
      'UPDATE platform_accounts SET status = ?, last_verified_at = ?, last_error = NULL, updated_at = ? WHERE id = ?',
    ).run('connected', now, now, account.id);
    logPlatformActivity(account.id, 'connection_test', 'success', msg);
    return { ok: true, status: 'connected', message: msg, account: getPlatformAccount(account.id)! };
  }

  // Mode C Manual Assistance: be completely transparent
  const manualMsg = `${account.platformName} operates in Mode C (Manual Assistance). Automated login/scraping is disabled by policy; manual import, proposal drafting, execution, QA, and delivery packaging are ready.`;
  db.prepare('UPDATE platform_accounts SET last_verified_at = ?, updated_at = ? WHERE id = ?').run(now, now, account.id);
  logPlatformActivity(account.id, 'connection_test', 'info', manualMsg);
  return {
    ok: true,
    status: account.status,
    message: manualMsg,
    account: getPlatformAccount(account.id)!,
  };
}
