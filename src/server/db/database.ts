import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { CONFIG, decryptSecretStrict, ensureDirectories, setKeyValidationStatus } from '../config.ts';
import type { HubSettings } from '../../shared/types.ts';

let dbInstance: DatabaseSync | null = null;
let currentDbPath: string | null = null;

export const DEFAULT_SETTINGS: HubSettings = {
  userSkills: [
    'TypeScript',
    'JavaScript',
    'React',
    'Node.js',
    'Python',
    'Excel',
    'Data Cleaning',
    'Web Research',
    'Technical Writing',
    'Content Writing',
    'Automation',
    'SEO',
    'WordPress',
    'Spreadsheet Work',
  ],
  scoreWeights: {
    skillCompatibility: 30,
    budget: 20,
    timeRequired: 15,
    deadlineFeasibility: 10,
    clientCredibility: 10,
    competition: 10,
    risk: 5,
  },
  filters: {
    minBudget: 25,
    maxWorkingHours: 40,
    minMatchScore: 55,
    preferredCategories: [
      'Programming',
      'Web development',
      'Automation',
      'Data processing',
      'Data cleaning',
      'Excel',
      'Spreadsheet work',
      'Writing',
      'Content writing',
      'Technical documentation',
      'Business research',
      'Internet research',
      'SEO',
      'Testing',
    ],
    preferredPlatforms: [],
    preferredCurrencies: ['USD', 'EUR', 'GBP'],
    preferredPaymentTypes: ['fixed', 'hourly', 'unknown'],
    maxDeadlineDays: 30,
    excludedKeywords: [
      'logo design',
      'graphic design',
      'photoshop',
      'illustrator',
      'flyer design',
      'brochure design',
      'banner design',
      'poster design',
      't-shirt design',
      'brand identity design',
      '3d modeling',
      'video editing',
    ],
    includedKeywords: [],
    scamRiskThreshold: 60,
    maxComplexity: 'high',
    requiredSkills: [],
    excludedSkills: ['Adobe Photoshop', 'Adobe Illustrator', 'CorelDRAW', 'InDesign', 'After Effects'],
    excludeGraphicDesign: true,
  },
  resourceLimits: {
    maxConcurrentAgents: 1,
    maxMemoryPercent: 80,
    maxCpuPercent: 85,
    gpuPreference: 'auto',
    queueLimit: 50,
    modelLoadingStrategy: 'single_sequential',
  },
  scheduler: {
    enabled: false,
    searchFrequencyMinutes: 60,
    maxJobsPerSearch: 25,
    minScoreForShortlist: 70,
    maxActiveProjects: 3,
    maxCorrectionRetries: 2,
    autoAnalyzeImported: true,
  },
  notifications: {
    highMatchJob: true,
    proposalReady: true,
    projectApproval: true,
    taskEvents: true,
    qaEvents: true,
    captchaAlert: true,
    connectorErrors: true,
    providerErrors: true,
    lowResources: true,
    submissionReady: true,
  },
  workspaceLocation: CONFIG.workspaceDir,
  demoMode: false,
};

export function initDatabase(customPath?: string): DatabaseSync {
  const targetPath = customPath || CONFIG.dbPath;
  if (dbInstance && currentDbPath === targetPath) {
    return dbInstance;
  }
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch {
      // ignore
    }
  }
  if (targetPath !== ':memory:') {
    ensureDirectories();
  }
  const db = new DatabaseSync(targetPath);
  db.exec('PRAGMA foreign_keys = ON;');
  if (targetPath !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');
  }
  runMigrations(db);
  seedDefaults(db);
  dbInstance = db;
  currentDbPath = targetPath;
  verifyStoredEncryptedSecrets(db);
  return db;
}

export function verifyStoredEncryptedSecrets(db: DatabaseSync): {
  ok: boolean;
  checkedCount: number;
  failedProviderIds: string[];
  message: string;
} {
  const rows = db
    .prepare("SELECT id, name, encrypted_api_key FROM ai_providers WHERE encrypted_api_key IS NOT NULL AND encrypted_api_key != ''")
    .all() as Array<{ id: string; name: string; encrypted_api_key: string }>;

  const failedProviderIds: string[] = [];
  for (const row of rows) {
    const res = decryptSecretStrict(row.encrypted_api_key);
    if (!res.ok) {
      failedProviderIds.push(row.id);
    }
  }

  const status =
    failedProviderIds.length === 0
      ? {
          ok: true,
          checkedCount: rows.length,
          failedProviderIds: [],
          message:
            rows.length > 0
              ? `Verified ${rows.length} encrypted AI provider credential(s) decrypt cleanly.`
              : 'Encryption key initialized and ready.',
        }
      : {
          ok: false,
          checkedCount: rows.length,
          failedProviderIds,
          message: `Encryption key mismatch: ${failedProviderIds.length} stored AI provider key(s) (${failedProviderIds.join(', ')}) cannot be decrypted with the active key. Restore the original HUB_SECRET_ENCRYPTION_KEY or re-save keys in Settings.`,
        };

  setKeyValidationStatus(status);

  if (!status.ok) {
    console.warn(`[SECURITY WARNING] ${status.message}`);
    try {
      db.prepare(
        'INSERT INTO audit_logs (id, action, actor, resource_type, resource_id, severity, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        crypto.randomUUID(),
        'encryption_key_mismatch',
        'system',
        'security',
        'ai_providers',
        'error',
        JSON.stringify({ failedProviderIds }),
        new Date().toISOString(),
      );
    } catch {
      // ignore if audit logging fails during boot
    }
    if (CONFIG.strictKeyCheck) {
      throw new Error(status.message);
    }
  }

  return status;
}

export function getDb(): DatabaseSync {
  if (!dbInstance) {
    return initDatabase();
  }
  return dbInstance;
}

export function closeDatabase(): void {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch {
      // ignore
    }
    dbInstance = null;
    currentDbPath = null;
  }
}

function runMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map(
      (r) => r.version,
    ),
  );

  if (!applied.has(1)) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS auth_credentials (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        claimed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        connector_type TEXT NOT NULL,
        implementation_status TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        automation_allowed INTEGER NOT NULL DEFAULT 0,
        browser_automation_allowed INTEGER NOT NULL DEFAULT 0,
        connection_status TEXT NOT NULL DEFAULT 'disabled',
        capabilities_json TEXT NOT NULL DEFAULT '[]',
        rate_limit_per_hour INTEGER NOT NULL DEFAULT 20,
        search_frequency_minutes INTEGER NOT NULL DEFAULT 60,
        last_successful_search TEXT,
        last_error TEXT,
        jobs_discovered INTEGER NOT NULL DEFAULT 0,
        jobs_imported INTEGER NOT NULL DEFAULT 0,
        policy_note TEXT NOT NULL DEFAULT '',
        endpoint_url TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
        source_name TEXT NOT NULL,
        source_job_id TEXT,
        job_url TEXT,
        title TEXT NOT NULL,
        normalized_title TEXT NOT NULL,
        description TEXT NOT NULL,
        client_info_json TEXT,
        budget REAL,
        currency TEXT NOT NULL DEFAULT 'USD',
        payment_type TEXT NOT NULL DEFAULT 'unknown',
        posted_date TEXT,
        deadline TEXT,
        skills_json TEXT NOT NULL DEFAULT '[]',
        category TEXT NOT NULL DEFAULT 'Other feasible work',
        estimated_hours REAL,
        job_score REAL,
        risk_score REAL,
        match_score REAL,
        score_breakdown_json TEXT,
        analysis_json TEXT,
        status TEXT NOT NULL DEFAULT 'new',
        is_demo INTEGER NOT NULL DEFAULT 0,
        rejection_reason TEXT,
        override_rejected INTEGER NOT NULL DEFAULT 0,
        user_edited INTEGER NOT NULL DEFAULT 0,
        date_discovered TEXT NOT NULL,
        date_imported TEXT NOT NULL,
        date_analyzed TEXT,
        date_updated TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_source_job ON jobs(source_id, source_job_id);
      CREATE INDEX IF NOT EXISTS idx_jobs_url ON jobs(job_url);
      CREATE INDEX IF NOT EXISTS idx_jobs_norm_title ON jobs(normalized_title);
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
      CREATE INDEX IF NOT EXISTS idx_jobs_score ON jobs(job_score);

      CREATE TABLE IF NOT EXISTS proposals (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        version INTEGER NOT NULL DEFAULT 1,
        introduction TEXT NOT NULL,
        full_proposal TEXT NOT NULL,
        approach TEXT NOT NULL,
        timeline TEXT NOT NULL,
        questions_json TEXT NOT NULL DEFAULT '[]',
        suggested_bid REAL,
        currency TEXT NOT NULL DEFAULT 'USD',
        pricing_explanation TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'draft',
        generated_by TEXT NOT NULL DEFAULT 'rule-template',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_proposals_job ON proposals(job_id);

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
        proposal_id TEXT REFERENCES proposals(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'awaiting_approval',
        workspace_path TEXT NOT NULL,
        plan_markdown TEXT,
        submission_message TEXT,
        qa_score REAL,
        qa_status TEXT,
        correction_attempts INTEGER NOT NULL DEFAULT 0,
        max_correction_attempts INTEGER NOT NULL DEFAULT 2,
        estimated_earnings REAL,
        is_demo INTEGER NOT NULL DEFAULT 0,
        submitted_at TEXT,
        paid_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);

      CREATE TABLE IF NOT EXISTS project_tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        agent_type TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        priority INTEGER NOT NULL DEFAULT 5,
        depends_on_json TEXT NOT NULL DEFAULT '[]',
        tool_name TEXT,
        output_summary TEXT,
        error_message TEXT,
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_project_tasks_project ON project_tasks(project_id);

      CREATE TABLE IF NOT EXISTS agent_tasks (
        id TEXT PRIMARY KEY,
        task_type TEXT NOT NULL,
        agent_type TEXT NOT NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        job_id TEXT REFERENCES jobs(id) ON DELETE CASCADE,
        dedupe_key TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'queued',
        priority INTEGER NOT NULL DEFAULT 5,
        progress INTEGER NOT NULL DEFAULT 0,
        retries INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 2,
        timeout_ms INTEGER NOT NULL DEFAULT 120000,
        depends_on_task_id TEXT,
        result_json TEXT,
        error_message TEXT,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(status, priority);
      CREATE INDEX IF NOT EXISTS idx_agent_tasks_dedupe ON agent_tasks(dedupe_key);

      CREATE TABLE IF NOT EXISTS task_logs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
        level TEXT NOT NULL DEFAULT 'info',
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_task_logs_task ON task_logs(task_id);

      CREATE TABLE IF NOT EXISTS deliverables (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        file_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        verified INTEGER NOT NULL DEFAULT 0,
        sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(project_id, relative_path)
      );

      CREATE INDEX IF NOT EXISTS idx_deliverables_project ON deliverables(project_id);

      CREATE TABLE IF NOT EXISTS qa_reports (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        attempt_number INTEGER NOT NULL DEFAULT 1,
        score REAL NOT NULL,
        status TEXT NOT NULL,
        checklist_json TEXT NOT NULL DEFAULT '[]',
        issues_json TEXT NOT NULL DEFAULT '[]',
        summary_markdown TEXT NOT NULL,
        disclaimer TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_qa_reports_project ON qa_reports(project_id);

      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'info',
        read INTEGER NOT NULL DEFAULT 0,
        related_entity_type TEXT,
        related_entity_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read, created_at);

      CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        amount REAL NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        platform_fee REAL NOT NULL DEFAULT 0,
        net_amount REAL NOT NULL,
        paid_at TEXT NOT NULL,
        notes TEXT,
        is_demo INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_payments_project ON payments(project_id);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ai_providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider_type TEXT NOT NULL,
        api_url TEXT NOT NULL,
        encrypted_api_key TEXT,
        model TEXT NOT NULL,
        context_limit INTEGER NOT NULL DEFAULT 8192,
        timeout_ms INTEGER NOT NULL DEFAULT 60000,
        priority INTEGER NOT NULL DEFAULT 1,
        role TEXT NOT NULL DEFAULT 'primary',
        enabled INTEGER NOT NULL DEFAULT 0,
        last_status TEXT NOT NULL DEFAULT 'unknown',
        last_checked_at TEXT,
        last_error TEXT
      );

      CREATE TABLE IF NOT EXISTS search_history (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        query TEXT NOT NULL DEFAULT '',
        jobs_found INTEGER NOT NULL DEFAULT 0,
        jobs_imported INTEGER NOT NULL DEFAULT 0,
        duplicates_skipped INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        error_message TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        actor TEXT NOT NULL DEFAULT 'system',
        resource_type TEXT NOT NULL,
        resource_id TEXT,
        severity TEXT NOT NULL DEFAULT 'info',
        details_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);

      CREATE TABLE IF NOT EXISTS browser_sessions (
        id TEXT PRIMARY KEY,
        connector_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'idle',
        requires_human_verification INTEGER NOT NULL DEFAULT 0,
        verification_note TEXT,
        last_screenshot_path TEXT,
        logs_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
      1,
      'initial_schema',
      new Date().toISOString(),
    );
  }

  if (!applied.has(2)) {
    const safeAddColumn = (table: string, colDef: string) => {
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${colDef}`);
      } catch {
        // column already exists
      }
    };
    safeAddColumn('agent_tasks', 'next_retry_at TEXT');
    safeAddColumn('agent_tasks', 'failure_code TEXT');
    safeAddColumn('projects', 'stage_checkpoint TEXT');
    safeAddColumn('project_tasks', 'stage_key TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_agent_tasks_retry ON agent_tasks(status, next_retry_at);');
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
      2,
      'stage_checkpoints_and_retry_backoff',
      new Date().toISOString(),
    );
  }

  if (!applied.has(3)) {
    const safeAddColumn = (table: string, colDef: string) => {
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${colDef}`);
      } catch {
        // column already exists
      }
    };
    safeAddColumn('projects', "execution_mode TEXT NOT NULL DEFAULT 'ai_generated'");
    safeAddColumn('projects', 'degraded_reason TEXT');
    safeAddColumn('qa_reports', "requirement_checks_json TEXT NOT NULL DEFAULT '[]'");
    safeAddColumn('qa_reports', 'human_review_gate_json TEXT');
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
      3,
      'degraded_execution_and_qa_requirement_traceability',
      new Date().toISOString(),
    );
  }
}

function seedDefaults(db: DatabaseSync): void {
  const now = new Date().toISOString();

  // Seed default settings if absent
  const existingSettings = db.prepare('SELECT key FROM settings WHERE key = ?').get('hub_settings');
  if (!existingSettings) {
    db.prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)').run(
      'hub_settings',
      JSON.stringify(DEFAULT_SETTINGS),
      now,
    );
  }

  // Seed real job sources & clearly labeled platform connector scaffolds
  const defaultSources = [
    {
      id: 'manual',
      name: 'Manual Import (URL / Text / CSV / JSON)',
      connectorType: 'manual',
      implementationStatus: 'functional',
      enabled: 1,
      automationAllowed: 0,
      browserAutomationAllowed: 0,
      connectionStatus: 'ready',
      capabilities: ['manual_url_import', 'manual_text_import', 'csv_import', 'json_import', 'deduplication'],
      rateLimitPerHour: 1000,
      searchFrequencyMinutes: 0,
      policyNote: 'Always enabled. Import jobs from any platform via pasted description, URL, CSV, or JSON without violating site terms.',
      endpointUrl: null,
    },
    {
      id: 'remotive_public',
      name: 'Remotive Public Remote Feed',
      connectorType: 'public_api',
      implementationStatus: 'functional',
      enabled: 1,
      automationAllowed: 1,
      browserAutomationAllowed: 0,
      connectionStatus: 'ready',
      capabilities: ['search', 'job_retrieval', 'normalization', 'deduplication', 'health_check'],
      rateLimitPerHour: 12,
      searchFrequencyMinutes: 60,
      policyNote: 'Official public Remotive JSON feed (https://remotive.com/api/remote-jobs). Respects rate limits and attribution.',
      endpointUrl: 'https://remotive.com/api/remote-jobs',
    },
    {
      id: 'arbeitnow_public',
      name: 'Arbeitnow Public Job Board API',
      connectorType: 'public_api',
      implementationStatus: 'functional',
      enabled: 1,
      automationAllowed: 1,
      browserAutomationAllowed: 0,
      connectionStatus: 'ready',
      capabilities: ['search', 'job_retrieval', 'normalization', 'deduplication', 'health_check'],
      rateLimitPerHour: 15,
      searchFrequencyMinutes: 60,
      policyNote: 'Official public Arbeitnow JSON API (https://www.arbeitnow.com/api/job-board-api). Permitted public access.',
      endpointUrl: 'https://www.arbeitnow.com/api/job-board-api',
    },
    {
      id: 'upwork',
      name: 'Upwork',
      connectorType: 'platform_scaffold',
      implementationStatus: 'scaffold_manual_only',
      enabled: 0,
      automationAllowed: 0,
      browserAutomationAllowed: 0,
      connectionStatus: 'manual_only',
      capabilities: ['manual_import_alternative', 'normalization', 'deduplication'],
      rateLimitPerHour: 10,
      searchFrequencyMinutes: 120,
      policyNote: 'Connector scaffold only. Upwork prohibits automated scraping and requires official OAuth API partner approval. Use Manual Import (URL / Text / CSV / JSON).',
      endpointUrl: null,
    },
    {
      id: 'freelancer',
      name: 'Freelancer.com',
      connectorType: 'platform_scaffold',
      implementationStatus: 'scaffold_manual_only',
      enabled: 0,
      automationAllowed: 0,
      browserAutomationAllowed: 0,
      connectionStatus: 'manual_only',
      capabilities: ['manual_import_alternative', 'normalization', 'deduplication'],
      rateLimitPerHour: 10,
      searchFrequencyMinutes: 120,
      policyNote: 'Connector scaffold only. Requires user-authorized Freelancer.com OAuth API token. Browser automation disabled by default.',
      endpointUrl: null,
    },
    {
      id: 'fiverr',
      name: 'Fiverr',
      connectorType: 'platform_scaffold',
      implementationStatus: 'scaffold_manual_only',
      enabled: 0,
      automationAllowed: 0,
      browserAutomationAllowed: 0,
      connectionStatus: 'manual_only',
      capabilities: ['manual_import_alternative', 'normalization', 'deduplication'],
      rateLimitPerHour: 6,
      searchFrequencyMinutes: 180,
      policyNote: 'Connector scaffold only. Fiverr Terms of Service prohibit automated scraping and bots. Import briefs manually.',
      endpointUrl: null,
    },
    {
      id: 'peopleperhour',
      name: 'PeoplePerHour',
      connectorType: 'platform_scaffold',
      implementationStatus: 'scaffold_manual_only',
      enabled: 0,
      automationAllowed: 0,
      browserAutomationAllowed: 0,
      connectionStatus: 'manual_only',
      capabilities: ['manual_import_alternative', 'normalization', 'deduplication'],
      rateLimitPerHour: 10,
      searchFrequencyMinutes: 120,
      policyNote: 'Connector scaffold only. No unauthenticated public scraping permitted. Use Manual Import.',
      endpointUrl: null,
    },
    {
      id: 'guru',
      name: 'Guru',
      connectorType: 'platform_scaffold',
      implementationStatus: 'scaffold_manual_only',
      enabled: 0,
      automationAllowed: 0,
      browserAutomationAllowed: 0,
      connectionStatus: 'manual_only',
      capabilities: ['manual_import_alternative', 'normalization', 'deduplication'],
      rateLimitPerHour: 10,
      searchFrequencyMinutes: 120,
      policyNote: 'Connector scaffold only. Automated scraping disabled by policy. Use Manual Import.',
      endpointUrl: null,
    },
    {
      id: 'wellfound',
      name: 'Wellfound',
      connectorType: 'platform_scaffold',
      implementationStatus: 'scaffold_manual_only',
      enabled: 0,
      automationAllowed: 0,
      browserAutomationAllowed: 0,
      connectionStatus: 'manual_only',
      capabilities: ['manual_import_alternative', 'normalization', 'deduplication'],
      rateLimitPerHour: 10,
      searchFrequencyMinutes: 120,
      policyNote: 'Connector scaffold only. Anti-bot restrictions apply; scraping is disabled. Use Manual Import.',
      endpointUrl: null,
    },
  ];

  const insertSource = db.prepare(`
    INSERT OR IGNORE INTO sources (
      id, name, connector_type, implementation_status, enabled, automation_allowed,
      browser_automation_allowed, connection_status, capabilities_json, rate_limit_per_hour,
      search_frequency_minutes, policy_note, endpoint_url, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const s of defaultSources) {
    insertSource.run(
      s.id,
      s.name,
      s.connectorType,
      s.implementationStatus,
      s.enabled,
      s.automationAllowed,
      s.browserAutomationAllowed,
      s.connectionStatus,
      JSON.stringify(s.capabilities),
      s.rateLimitPerHour,
      s.searchFrequencyMinutes,
      s.policyNote,
      s.endpointUrl,
      now,
      now,
    );
  }

  // Seed default AI Providers (Local-First Ollama -> FreeLLMAPI -> OpenAI-Compatible -> Server Gemini Fallback)
  const defaultProviders = [
    {
      id: 'ollama_local',
      name: 'Local Ollama (Primary)',
      providerType: 'ollama',
      apiUrl: CONFIG.ollamaBaseUrl,
      model: CONFIG.ollamaDefaultModel,
      contextLimit: 8192,
      timeoutMs: 90000,
      priority: 1,
      role: 'primary',
      enabled: 1,
      lastStatus: 'unknown',
    },
    {
      id: 'freellmapi',
      name: 'FreeLLMAPI (Configurable Fallback)',
      providerType: 'freellmapi',
      apiUrl: CONFIG.freeLlmBaseUrl || 'https://api.freellmapi.example/v1',
      model: CONFIG.freeLlmModel || 'gpt-4o-mini',
      contextLimit: 16384,
      timeoutMs: 60000,
      priority: 2,
      role: 'fallback',
      enabled: CONFIG.freeLlmBaseUrl ? 1 : 0,
      lastStatus: CONFIG.freeLlmBaseUrl ? 'unknown' : 'unconfigured',
    },
    {
      id: 'openai_compat',
      name: 'OpenAI-Compatible Provider',
      providerType: 'openai_compatible',
      apiUrl: CONFIG.openAiCompatBaseUrl || 'https://api.openai.com/v1',
      model: CONFIG.openAiCompatModel || 'gpt-4o-mini',
      contextLimit: 32768,
      timeoutMs: 60000,
      priority: 3,
      role: 'fallback',
      enabled: CONFIG.openAiCompatBaseUrl ? 1 : 0,
      lastStatus: CONFIG.openAiCompatBaseUrl ? 'unknown' : 'unconfigured',
    },
    {
      id: 'gemini_fallback',
      name: 'Gemini API (Server Fallback)',
      providerType: 'gemini',
      apiUrl: 'https://generativelanguage.googleapis.com',
      model: 'gemini-4-hydrogen',
      contextLimit: 65536,
      timeoutMs: 60000,
      priority: 4,
      role: 'fallback',
      enabled: process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY' ? 1 : 0,
      lastStatus: process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY' ? 'unknown' : 'unconfigured',
    },
  ];

  const insertProvider = db.prepare(`
    INSERT OR IGNORE INTO ai_providers (
      id, name, provider_type, api_url, encrypted_api_key, model, context_limit,
      timeout_ms, priority, role, enabled, last_status
    ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const p of defaultProviders) {
    insertProvider.run(
      p.id,
      p.name,
      p.providerType,
      p.apiUrl,
      p.model,
      p.contextLimit,
      p.timeoutMs,
      p.priority,
      p.role,
      p.enabled,
      p.lastStatus,
    );
  }
}

export function getHubSettings(): HubSettings {
  const db = getDb();
  const row = db.prepare('SELECT value_json FROM settings WHERE key = ?').get('hub_settings') as
    | { value_json: string }
    | undefined;
  if (!row) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(row.value_json) as Partial<HubSettings>;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      scoreWeights: { ...DEFAULT_SETTINGS.scoreWeights, ...(parsed.scoreWeights || {}) },
      filters: { ...DEFAULT_SETTINGS.filters, ...(parsed.filters || {}) },
      resourceLimits: { ...DEFAULT_SETTINGS.resourceLimits, ...(parsed.resourceLimits || {}) },
      scheduler: { ...DEFAULT_SETTINGS.scheduler, ...(parsed.scheduler || {}) },
      notifications: { ...DEFAULT_SETTINGS.notifications, ...(parsed.notifications || {}) },
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveHubSettings(next: HubSettings): HubSettings {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at',
  ).run('hub_settings', JSON.stringify(next), now);
  return next;
}

export function logAudit(
  action: string,
  resourceType: string,
  resourceId: string | null,
  details: Record<string, unknown> = {},
  severity: 'info' | 'warning' | 'error' = 'info',
  actor = 'operator',
): void {
  const db = getDb();
  db.prepare(
    'INSERT INTO audit_logs (id, action, actor, resource_type, resource_id, severity, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    crypto.randomUUID(),
    action,
    actor,
    resourceType,
    resourceId,
    severity,
    JSON.stringify(details),
    new Date().toISOString(),
  );
}

export function createNotification(
  type: string,
  title: string,
  message: string,
  severity: 'info' | 'success' | 'warning' | 'error' = 'info',
  relatedEntityType: string | null = null,
  relatedEntityId: string | null = null,
): void {
  const db = getDb();
  db.prepare(
    'INSERT INTO notifications (id, type, title, message, severity, read, related_entity_type, related_entity_id, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)',
  ).run(
    crypto.randomUUID(),
    type,
    title,
    message,
    severity,
    relatedEntityType,
    relatedEntityId,
    new Date().toISOString(),
  );
}
