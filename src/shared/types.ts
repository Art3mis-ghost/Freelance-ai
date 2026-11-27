export type NavSection =
  | 'dashboard'
  | 'discovery'
  | 'job-details'
  | 'proposals'
  | 'agents'
  | 'projects'
  | 'workspace'
  | 'qa'
  | 'submissions'
  | 'platform-accounts'
  | 'ai-providers'
  | 'automation'
  | 'tasks'
  | 'analytics'
  | 'sources'
  | 'settings';

export type JobStatus =
  | 'new'
  | 'analyzed'
  | 'shortlisted'
  | 'rejected'
  | 'proposal_drafted'
  | 'proposal_submitted'
  | 'awaiting_approval'
  | 'approved'
  | 'in_progress'
  | 'qa_review'
  | 'ready_for_submission'
  | 'submitted'
  | 'paid'
  | 'expired';

export type AgentType =
  | 'job_scout'
  | 'job_analyst'
  | 'proposal_writer'
  | 'research_agent'
  | 'work_planner'
  | 'execution_agent'
  | 'coding_agent'
  | 'document_agent'
  | 'data_agent'
  | 'qa_agent'
  | 'correction_agent'
  | 'delivery_agent'
  | 'security_agent';

export type TaskStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'paused'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface ScoreWeights {
  skillCompatibility: number;
  budget: number;
  timeRequired: number;
  deadlineFeasibility: number;
  clientCredibility: number;
  competition: number;
  risk: number;
}

export interface ScoreBreakdownItem {
  criterion: keyof ScoreWeights;
  label: string;
  score: number;
  maxScore: number;
  reasoning: string;
}

export interface JobAnalysis {
  requiredSkills: string[];
  requiredDeliverables: string[];
  estimatedHours: number;
  difficulty: 'low' | 'medium' | 'high';
  expectedHourlyRate: number | null;
  feasibility: 'high' | 'medium' | 'low';
  toolsNeeded: string[];
  missingCapabilities: string[];
  scamIndicators: string[];
  isGraphicDesignPrimary: boolean;
  graphicDesignReason: string | null;
  promptInjectionDetected: boolean;
  summary: string;
  analyzedBy: string;
  clientCredibilityNote: string;
  competitionNote: string;
}

export interface JobRecord {
  id: string;
  sourceId: string;
  sourceName: string;
  sourceJobId: string | null;
  jobUrl: string | null;
  title: string;
  description: string;
  clientInfo: Record<string, unknown> | null;
  budget: number | null;
  currency: string;
  paymentType: 'fixed' | 'hourly' | 'unknown';
  postedDate: string | null;
  deadline: string | null;
  skills: string[];
  category: string;
  estimatedHours: number | null;
  jobScore: number | null;
  riskScore: number | null;
  matchScore: number | null;
  scoreBreakdown: ScoreBreakdownItem[] | null;
  analysis: JobAnalysis | null;
  status: JobStatus;
  isDemo: boolean;
  rejectionReason: string | null;
  overrideRejected: boolean;
  userEdited: boolean;
  dateDiscovered: string;
  dateImported: string;
  dateAnalyzed: string | null;
  dateUpdated: string;
}

export interface JobSourceRecord {
  id: string;
  name: string;
  connectorType: 'public_api' | 'manual' | 'platform_scaffold';
  implementationStatus: 'functional' | 'scaffold_manual_only';
  enabled: boolean;
  automationAllowed: boolean;
  browserAutomationAllowed: boolean;
  connectionStatus: 'connected' | 'ready' | 'manual_only' | 'error' | 'disabled';
  capabilities: string[];
  rateLimitPerHour: number;
  searchFrequencyMinutes: number;
  lastSuccessfulSearch: string | null;
  lastError: string | null;
  jobsDiscovered: number;
  jobsImported: number;
  policyNote: string;
  endpointUrl: string | null;
}

export interface ProposalRecord {
  id: string;
  jobId: string;
  jobTitle?: string;
  version: number;
  introduction: string;
  fullProposal: string;
  approach: string;
  timeline: string;
  questions: string[];
  suggestedBid: number | null;
  currency: string;
  pricingExplanation: string;
  status: 'draft' | 'reviewed' | 'submitted_manually' | 'awarded' | 'archived';
  generatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRecord {
  id: string;
  jobId: string;
  proposalId: string | null;
  title: string;
  sourceName?: string;
  jobUrl?: string | null;
  budget?: number | null;
  currency?: string;
  clientInfo?: Record<string, unknown> | null;
  status:
    | 'awaiting_approval'
    | 'planning'
    | 'executing'
    | 'qa_running'
    | 'correcting'
    | 'ready_for_submission'
    | 'needs_review'
    | 'submitted'
    | 'paid'
    | 'failed'
    | 'cancelled';
  workspacePath: string;
  planMarkdown: string | null;
  submissionMessage: string | null;
  qaScore: number | null;
  qaStatus: string | null;
  executionMode?: 'ai_generated' | 'degraded_fallback';
  degradedReason?: string | null;
  correctionAttempts: number;
  maxCorrectionAttempts: number;
  estimatedEarnings: number | null;
  isDemo: boolean;
  submittedAt: string | null;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectTaskRecord {
  id: string;
  projectId: string;
  agentType: AgentType;
  title: string;
  description: string;
  status: TaskStatus;
  priority: number;
  dependsOn: string[];
  toolName: string | null;
  outputSummary: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface AgentTaskRecord {
  id: string;
  taskType: string;
  agentType: AgentType;
  projectId: string | null;
  jobId: string | null;
  dedupeKey: string | null;
  status: TaskStatus;
  priority: number;
  progress: number;
  retries: number;
  maxRetries: number;
  timeoutMs: number;
  dependsOnTaskId: string | null;
  result: Record<string, unknown> | null;
  errorMessage: string | null;
  cancelRequested: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface DeliverableRecord {
  id: string;
  projectId: string;
  filename: string;
  relativePath: string;
  fileType: string;
  sizeBytes: number;
  verified: boolean;
  sha256: string;
  createdAt: string;
}

export interface QaChecklistItem {
  id: string;
  label: string;
  passed: boolean;
  severity: 'critical' | 'major' | 'minor';
  notes: string;
}

export interface RequirementEvidenceLink {
  file: string;
  section: string;
  excerpt: string;
}

export interface RequirementVerificationItem {
  id: string;
  requirement: string;
  category: 'deliverable_format' | 'functional_scope' | 'skill_or_tool' | 'quality_constraint';
  status: 'verified' | 'partial' | 'unverified';
  evidenceLinks: RequirementEvidenceLink[];
  humanReviewRequired: boolean;
  notes: string;
}

export interface HumanReviewGate {
  required: boolean;
  reasons: string[];
  unverifiedRequirements: string[];
}

export interface QaReportRecord {
  id: string;
  projectId: string;
  attemptNumber: number;
  score: number;
  status: 'ready_for_review' | 'needs_review' | 'needs_correction';
  checklist: QaChecklistItem[];
  requirementChecks?: RequirementVerificationItem[];
  humanReviewGate?: HumanReviewGate;
  issues: string[];
  summaryMarkdown: string;
  disclaimer: string;
  createdAt: string;
}

export interface NotificationRecord {
  id: string;
  type: string;
  title: string;
  message: string;
  severity: 'info' | 'success' | 'warning' | 'error';
  read: boolean;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  createdAt: string;
}

export interface PaymentRecord {
  id: string;
  projectId: string;
  jobId: string;
  projectTitle?: string;
  sourceName?: string;
  category?: string;
  amount: number;
  currency: string;
  platformFee: number;
  netAmount: number;
  paidAt: string;
  notes: string | null;
  isDemo: boolean;
  createdAt: string;
}

export type AiProviderType = 'ollama' | 'openai_compatible' | 'freellmapi' | 'gemini';

export type AiProviderErrorCode =
  | 'invalid_endpoint'
  | 'blocked_endpoint'
  | 'auth_failure'
  | 'connection_refused'
  | 'timeout'
  | 'invalid_model'
  | 'server_error';

export interface AiProviderRecord {
  id: string;
  name: string;
  providerType: AiProviderType;
  apiUrl: string;
  hasApiKey: boolean;
  model: string;
  contextLimit: number;
  timeoutMs: number;
  priority: number;
  role: 'primary' | 'fallback' | 'specialized';
  enabled: boolean;
  lastStatus: 'online' | 'offline' | 'unconfigured' | 'error' | 'unknown';
  lastCheckedAt: string | null;
  lastError: string | null;
  lastErrorCode?: AiProviderErrorCode | null;
  availableModels?: string[];
}

export interface ResourceSnapshot {
  platform: string;
  hostname: string;
  nodeVersion: string;
  cpuCores: number;
  cpuModel: string;
  cpuLoadPercent: number;
  memoryTotalMb: number;
  memoryUsedMb: number;
  memoryUsedPercent: number;
  diskFreeGb: number | null;
  diskTotalGb: number | null;
  activeModel: string | null;
  modelLoadingStatus: 'idle' | 'loading' | 'active';
  runningTasks: number;
  queuedTasks: number;
  pausedTasks: number;
  maxConcurrentAgents: number;
  resourcePressure: 'nominal' | 'elevated' | 'critical';
  schedulerPaused: boolean;
  timestamp: string;
}

export interface FilterConfig {
  minBudget: number;
  maxWorkingHours: number;
  minMatchScore: number;
  preferredCategories: string[];
  preferredPlatforms: string[];
  preferredCurrencies: string[];
  preferredPaymentTypes: Array<'fixed' | 'hourly' | 'unknown'>;
  maxDeadlineDays: number;
  excludedKeywords: string[];
  includedKeywords: string[];
  scamRiskThreshold: number;
  maxComplexity: 'low' | 'medium' | 'high';
  requiredSkills: string[];
  excludedSkills: string[];
  excludeGraphicDesign: boolean;
}

export interface ResourceLimitsConfig {
  maxConcurrentAgents: number;
  maxMemoryPercent: number;
  maxCpuPercent: number;
  gpuPreference: 'auto' | 'prefer_gpu' | 'cpu_only';
  queueLimit: number;
  modelLoadingStrategy: 'single_sequential' | 'keep_warm';
}

export interface SchedulerConfig {
  enabled: boolean;
  searchFrequencyMinutes: number;
  maxJobsPerSearch: number;
  minScoreForShortlist: number;
  maxActiveProjects: number;
  maxCorrectionRetries: number;
  autoAnalyzeImported: boolean;
}

export type PlatformAccountStatus =
  | 'not_connected'
  | 'connecting'
  | 'connected'
  | 'expired'
  | 'needs_verification'
  | 'requires_manual_login'
  | 'api_unavailable'
  | 'disabled'
  | 'error';

export type PlatformVerificationStatus =
  | 'not_connected'
  | 'credential_stored'
  | 'credential_encryption_verified'
  | 'live_verification_pending'
  | 'live_verification_successful'
  | 'live_verification_failed'
  | 'authentication_expired'
  | 'authentication_revoked'
  | 'insufficient_permissions'
  | 'api_unavailable'
  | 'manual_verification_required';

export type PlatformConnectionMethod =
  | 'official_oauth'
  | 'official_api_key'
  | 'permitted_browser_session'
  | 'manual_browser_assisted'
  | 'manual_import'
  | 'public_api';

export type PlatformIntegrationMode =
  | 'MODE_A_OFFICIAL_API'
  | 'MODE_B_PERMITTED_BROWSER'
  | 'MODE_C_MANUAL_ASSISTANCE'
  | 'MODE_D_PUBLIC_SOURCE';

export interface PlatformCapabilities {
  publicJobDiscovery: boolean;
  authenticatedJobDiscovery: boolean;
  jobDetails: boolean;
  search: boolean;
  applicationDrafting: boolean;
  applicationSubmission: boolean;
  messaging: boolean;
  fileUploads: boolean;
  deliverableSubmission: boolean;
  applicationStatusTracking: boolean;
  clientFeedbackRetrieval: boolean;
  contractStatus: boolean;
  apiAvailability: boolean;
  browserInteractionPermitted: boolean;
}

export interface PlatformAccountRecord {
  id: string;
  platformKey: string;
  platformName: string;
  category: 'freelance_marketplace' | 'remote_job_board' | 'custom_adapter';
  status: PlatformAccountStatus;
  verificationStatus: PlatformVerificationStatus;
  verificationDetail: string | null;
  connectionMethod: PlatformConnectionMethod;
  integrationMode: PlatformIntegrationMode;
  supportedMethods: PlatformConnectionMethod[];
  enabled: boolean;
  accountIdentifier: string | null;
  displayName: string | null;
  profileUrl: string | null;
  hasStoredCredentials: boolean;
  credentialScope: string | null;
  lastVerifiedAt: string | null;
  expiresAt: string | null;
  lastError: string | null;
  policySummary: string;
  complianceRestriction: string;
  capabilities: PlatformCapabilities;
  permittedCapabilities: PlatformCapabilities;
  permissions: {
    allowDrafting: boolean;
    allowManualHandoff: boolean;
    allowOfficialApiCalls: boolean;
    requireApprovalBeforeExternalAction: boolean;
  };
  createdAt: string;
  updatedAt: string;
}

export interface PlatformActivityLog {
  id: string;
  platformId: string;
  action: string;
  status: 'info' | 'success' | 'warning' | 'error';
  message: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export type AutonomyLevel = 1 | 2 | 3 | 4 | 5;

export interface AutonomyConfig {
  level: AutonomyLevel;
  maxDailyApplications: number;
  maxBidAmountUsd: number;
  maxDailySpendUsd: number;
  requireApprovalForPaidBids: boolean;
  requireApprovalForContractAcceptance: boolean;
  requireApprovalForFinalDelivery: boolean;
  requireApprovalForClientMessages: boolean;
  requireApprovalForExternalUploads: boolean;
  pauseOnPolicyWarning: boolean;
  pauseOnCaptchaOrMfa: boolean;
}

export type ApprovalActionType =
  | 'final_delivery_submission'
  | 'application_submission'
  | 'paid_bid'
  | 'contract_acceptance'
  | 'client_message'
  | 'external_upload'
  | 'platform_account_change'
  | 'project_start';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'revoked' | 'expired';

export interface ApprovalRecord {
  id: string;
  actionType: ApprovalActionType;
  title: string;
  description: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  status: ApprovalStatus;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  platformKey: string | null;
  estimatedCostUsd: number | null;
  payload: Record<string, unknown>;
  requestedBy: string;
  decidedBy: string | null;
  decisionNote: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export type DeliveryStatus =
  | 'not_ready'
  | 'preparing'
  | 'qa_pending'
  | 'ready_for_delivery'
  | 'awaiting_approval'
  | 'delivery_in_progress'
  | 'submission_unverified'
  | 'submission_reported'
  | 'submitted'
  | 'delivered'
  | 'accepted'
  | 'paid'
  | 'failed'
  | 'needs_manual_action'
  | 'cancelled';

export type SubmissionMethod =
  | 'official_api'
  | 'authorized_upload'
  | 'manual_upload'
  | 'guided_browser_workflow';

export type DeliveryEvidenceType =
  | 'official_api_response'
  | 'verified_upload_receipt'
  | 'manual_self_report'
  | 'client_receipt_confirmation'
  | 'client_acceptance_confirmation'
  | 'payment_confirmation'
  | 'failure_report'
  | 'cancellation_record';

export interface DeliveryEvidenceRecord {
  id: string;
  deliveryId: string;
  projectId: string;
  evidenceType: DeliveryEvidenceType;
  verifiedByPlatform: boolean;
  summary: string;
  externalReference: string | null;
  actor: string;
  metadata: Record<string, unknown>;
  recordedAt: string;
}

export interface DeliveryTransitionRecord {
  id: string;
  deliveryId: string;
  projectId: string;
  fromStatus: DeliveryStatus;
  toStatus: DeliveryStatus;
  actor: string;
  reason: string;
  evidenceId: string | null;
  recordedAt: string;
}

export interface SecretScanFinding {
  file: string;
  location: string;
  category: string;
  rule: string;
  riskLevel: 'critical' | 'high' | 'medium' | 'low';
  redactedMatch: string;
  contextHint: string;
}

export interface SecretScanReport {
  scanStatus: 'clean' | 'findings_detected' | 'partially_scanned' | 'error';
  scannedAt: string;
  durationMs: number;
  timedOut: boolean;
  filesScanned: string[];
  formatsInspected: string[];
  unsupportedFormats: Array<{ file: string; format: string; reason: string }>;
  scanErrors: Array<{ file: string; error: string }>;
  findings: SecretScanFinding[];
  warnings: string[];
  riskLevel: 'none' | 'low' | 'medium' | 'high' | 'critical';
  humanReviewRequired: boolean;
}

export interface DeliveryManifestFile {
  filename: string;
  relativePath: string;
  fileType: string;
  sizeBytes: number;
  sha256: string;
  verified: boolean;
}

export interface DeliveryPackageManifest {
  preparedAt: string;
  zipRelativePath: string | null;
  zipSha256: string | null;
  totalFiles: number;
  totalBytes: number;
  includedFiles: DeliveryManifestFile[];
  excludedInternalFiles: string[];
  missingFiles?: string[];
  corruptedFiles?: string[];
  packageWarnings?: string[];
  secretsScanPassed: boolean;
  secretScanReport?: SecretScanReport;
  internalLogsExcluded: boolean;
  qaScore: number | null;
  qaPassed: boolean;
  humanReviewRequired?: boolean;
}

export interface DeliveryRecord {
  id: string;
  projectId: string;
  jobId: string;
  projectTitle: string;
  platformKey: string;
  platformName: string;
  jobUrl: string | null;
  status: DeliveryStatus;
  submissionMethod: SubmissionMethod;
  approvalId: string | null;
  approvalStatus: ApprovalStatus | null;
  packageZipPath: string | null;
  manifest: DeliveryPackageManifest | null;
  deliverySummary: string | null;
  submissionMessage: string | null;
  externalReference: string | null;
  confirmationNote: string | null;
  verificationSource: 'none' | 'manual_self_reported' | 'platform_verified';
  submittedAt: string | null;
  deliveredAt: string | null;
  acceptedAt: string | null;
  paidAt: string | null;
  lastError: string | null;
  evidence: DeliveryEvidenceRecord[];
  transitions: DeliveryTransitionRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface DeliveryReport {
  deliveryId: string;
  projectId: string;
  jobId: string;
  projectTitle: string;
  platformName: string;
  clientInfo: Record<string, unknown> | null;
  budget: number | null;
  currency: string;
  deliveryStatus: DeliveryStatus;
  verificationSource: 'none' | 'manual_self_reported' | 'platform_verified';
  submissionMethod: SubmissionMethod;
  qaScore: number | null;
  qaStatus: string | null;
  approvalStatus: ApprovalStatus | null;
  approvalDecidedAt: string | null;
  packageZipPath: string | null;
  deliverables: DeliveryManifestFile[];
  excludedInternalFiles: string[];
  secretsScanPassed: boolean;
  secretScanReport: SecretScanReport | null;
  submissionMessage: string | null;
  externalReference: string | null;
  confirmationNote: string | null;
  evidence: DeliveryEvidenceRecord[];
  transitions: DeliveryTransitionRecord[];
  submittedAt: string | null;
  deliveredAt: string | null;
  acceptedAt: string | null;
  paidAt: string | null;
  generatedAt: string;
}

export interface HubSettings {
  userSkills: string[];
  scoreWeights: ScoreWeights;
  filters: FilterConfig;
  resourceLimits: ResourceLimitsConfig;
  scheduler: SchedulerConfig;
  autonomy: AutonomyConfig;
  notifications: {
    highMatchJob: boolean;
    proposalReady: boolean;
    projectApproval: boolean;
    taskEvents: boolean;
    qaEvents: boolean;
    captchaAlert: boolean;
    connectorErrors: boolean;
    providerErrors: boolean;
    lowResources: boolean;
    submissionReady: boolean;
  };
  workspaceLocation: string;
  demoMode: boolean;
}

export interface DashboardData {
  demoMode: boolean;
  kpis: {
    totalJobsDiscovered: number;
    newJobs: number;
    suitableJobs: number;
    highMatchJobs: number;
    jobsAwaitingApproval: number;
    activeProjects: number;
    agentsRunning: number;
    agentsQueued: number;
    tasksCompleted: number;
    tasksFailed: number;
    jobsReadyForSubmission: number;
    earningsRecordedCount: number;
    estimatedPotentialEarnings: number;
    actualPaidEarnings: number;
    netPaidEarnings: number;
    connectedPlatforms: number;
    totalPlatforms: number;
    pendingApprovals: number;
    deliveriesInProgress: number;
    deliveriesSubmitted: number;
    onlineProviders: number;
    totalProviders: number;
    autonomyLevel: AutonomyLevel;
  };
  charts: {
    discoveryOverTime: Array<{ date: string; discovered: number; shortlisted: number }>;
    jobsByPlatform: Array<{ platform: string; count: number }>;
    jobsByCategory: Array<{ category: string; count: number }>;
    matchScoreDistribution: Array<{ bucket: string; count: number }>;
    projectStatusBreakdown: Array<{ status: string; count: number }>;
    earningsHistory: Array<{ month: string; estimated: number; actualPaid: number; netPaid: number }>;
    agentPerformance: Array<{ agent: string; completed: number; failed: number }>;
  };
  activityFeed: Array<{
    id: string;
    category: string;
    title: string;
    detail: string;
    severity: string;
    createdAt: string;
  }>;
  resources: ResourceSnapshot;
}

export const SUPPORTED_CATEGORIES = [
  'Virtual assistance',
  'Data entry',
  'Data processing',
  'Data cleaning',
  'Internet research',
  'Lead generation',
  'Customer support',
  'Email support',
  'Live chat support',
  'Writing',
  'Content writing',
  'Proofreading',
  'SEO',
  'Programming',
  'Web development',
  'Testing',
  'Automation',
  'Excel',
  'Spreadsheet work',
  'Word documents',
  'PowerPoint',
  'Business research',
  'Ecommerce',
  'Product listing',
  'Transcription',
  'Translation',
  'Technical documentation',
  'WordPress',
  'Marketing',
  'Administrative tasks',
  'Other feasible work',
] as const;

export const AGENT_ROSTER: Array<{
  id: AgentType;
  name: string;
  role: string;
  allowedTools: string[];
}> = [
  { id: 'job_scout', name: 'Job Scout', role: 'Discovers permitted listings, normalizes feeds, and deduplicates records.', allowedTools: ['connector_search', 'feed_fetch', 'job_dedupe'] },
  { id: 'job_analyst', name: 'Job Analyst', role: 'Scores opportunities, excludes graphic design, and detects scam signals.', allowedTools: ['job_scorer', 'scam_detector', 'prompt_sanitizer'] },
  { id: 'proposal_writer', name: 'Proposal Writer', role: 'Drafts concise, honest, tailored proposals and realistic bid ranges.', allowedTools: ['llm_generate', 'proposal_store'] },
  { id: 'research_agent', name: 'Research Agent', role: 'Synthesizes project requirements and permitted public reference material.', allowedTools: ['llm_generate', 'workspace_write', 'permitted_fetch'] },
  { id: 'work_planner', name: 'Work Planner', role: 'Decomposes approved contracts into sequential, resource-aware subtasks.', allowedTools: ['llm_generate', 'workspace_write'] },
  { id: 'execution_agent', name: 'Execution Agent', role: 'Coordinates end-to-end deliverable production inside isolated workspaces.', allowedTools: ['llm_generate', 'workspace_write', 'workspace_read'] },
  { id: 'coding_agent', name: 'Coding Agent', role: 'Writes clean scripts, websites, HTML, and automated test artifacts.', allowedTools: ['llm_generate', 'workspace_write', 'code_static_check'] },
  { id: 'document_agent', name: 'Document Agent', role: 'Builds real DOCX, PDF, PPTX, and Markdown deliverables on disk.', allowedTools: ['generate_docx', 'generate_pdf', 'generate_pptx', 'workspace_write'] },
  { id: 'data_agent', name: 'Data Agent', role: 'Cleans datasets and builds real XLSX workbooks and CSV deliverables.', allowedTools: ['generate_xlsx', 'generate_csv', 'data_clean'] },
  { id: 'qa_agent', name: 'QA Agent', role: 'Independently inspects deliverables, file signatures, and checklists.', allowedTools: ['workspace_read', 'file_verify', 'qa_evaluate'] },
  { id: 'correction_agent', name: 'Correction Agent', role: 'Fixes failed QA items within bounded retry limits.', allowedTools: ['llm_generate', 'workspace_write', 'generate_docx', 'generate_xlsx', 'generate_pdf'] },
  { id: 'delivery_agent', name: 'Delivery Agent', role: 'Packages verified ZIP bundles and prepares manual submission messages.', allowedTools: ['create_zip', 'workspace_write'] },
  { id: 'security_agent', name: 'Security Agent', role: 'Enforces prompt-injection sanitization, URL safety, and workspace boundaries.', allowedTools: ['prompt_sanitizer', 'url_validator', 'audit_log'] },
];
