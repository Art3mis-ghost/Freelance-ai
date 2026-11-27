import React, { useCallback, useEffect, useState } from 'react';
import {
  ShieldCheck,
  RefreshCw,
  Plug,
  Unplug,
  Plus,
  Lock,
  CheckCircle2,
  AlertTriangle,
  Activity,
  ExternalLink,
} from 'lucide-react';
import { apiRequest, formatShortDate, isSafeHttpUrl } from '../api.ts';
import type {
  PlatformAccountRecord,
  PlatformActivityLog,
  PlatformCapabilities,
  PlatformConnectionMethod,
  PlatformIntegrationMode,
} from '../../shared/types.ts';

const CAPABILITY_LABELS: Array<{ key: keyof PlatformCapabilities; label: string }> = [
  { key: 'publicJobDiscovery', label: 'Public Job Discovery' },
  { key: 'authenticatedJobDiscovery', label: 'Authenticated Job Discovery' },
  { key: 'jobDetails', label: 'Job Details Retrieval' },
  { key: 'search', label: 'Keyword Search' },
  { key: 'applicationDrafting', label: 'Application Drafting' },
  { key: 'applicationSubmission', label: 'Application Submission' },
  { key: 'messaging', label: 'Client Messaging' },
  { key: 'fileUploads', label: 'File Uploads' },
  { key: 'deliverableSubmission', label: 'Deliverable Submission' },
  { key: 'applicationStatusTracking', label: 'Application Status Tracking' },
  { key: 'clientFeedbackRetrieval', label: 'Client Feedback Retrieval' },
  { key: 'contractStatus', label: 'Contract Status Tracking' },
  { key: 'apiAvailability', label: 'Official API Availability' },
  { key: 'browserInteractionPermitted', label: 'Permitted Browser Session' },
];

const MODE_LABELS: Record<PlatformIntegrationMode, string> = {
  MODE_A_OFFICIAL_API: 'Mode A — Official API',
  MODE_B_PERMITTED_BROWSER: 'Mode B — Permitted Browser',
  MODE_C_MANUAL_ASSISTANCE: 'Mode C — Manual Assistance',
  MODE_D_PUBLIC_SOURCE: 'Mode D — Public Source',
};

const METHOD_LABELS: Record<PlatformConnectionMethod, string> = {
  official_oauth: 'Official OAuth',
  official_api_key: 'Official API Key',
  permitted_browser_session: 'Permitted Browser Session',
  manual_browser_assisted: 'Manual Browser-Assisted',
  manual_import: 'Manual Import',
  public_api: 'Official Public API',
};

function statusTextColor(status: PlatformAccountRecord['status']): string {
  switch (status) {
    case 'connected':
      return 'text-emerald-400';
    case 'expired':
    case 'needs_verification':
    case 'requires_manual_login':
      return 'text-amber-400';
    case 'error':
      return 'text-rose-400';
    case 'disabled':
    case 'api_unavailable':
    case 'not_connected':
    default:
      return 'text-slate-400';
  }
}

export const PlatformAccountsView: React.FC<{ onNavigateSources?: () => void }> = ({ onNavigateSources }) => {
  const [accounts, setAccounts] = useState<PlatformAccountRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [logs, setLogs] = useState<PlatformActivityLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Connect form state
  const [connectMethod, setConnectMethod] = useState<PlatformConnectionMethod>('manual_import');
  const [accountIdentifier, setAccountIdentifier] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [profileUrl, setProfileUrl] = useState('');
  const [credentialSecret, setCredentialSecret] = useState('');
  const [credentialScope, setCredentialScope] = useState('');
  const [expiresAt, setExpiresAt] = useState('');

  // Custom adapter form
  const [showAddCustom, setShowAddCustom] = useState(false);
  const [customName, setCustomName] = useState('');
  const [customMode, setCustomMode] = useState<PlatformIntegrationMode>('MODE_C_MANUAL_ASSISTANCE');
  const [customProfileUrl, setCustomProfileUrl] = useState('');
  const [customPolicy, setCustomPolicy] = useState('');

  const loadAccounts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiRequest<{ accounts: PlatformAccountRecord[] }>('/api/platform-accounts');
      setAccounts(res.accounts);
      setSelectedId((prev) => prev || res.accounts[0]?.id || null);
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Failed to load platform accounts' });
    } finally {
      setLoading(false);
    }
  }, []);

  const loadLogs = useCallback(async (platformId: string) => {
    try {
      const res = await apiRequest<{ logs: PlatformActivityLog[] }>(`/api/platform-accounts/${platformId}/logs`);
      setLogs(res.logs);
    } catch {
      setLogs([]);
    }
  }, []);

  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  const selected = accounts.find((a) => a.id === selectedId) || accounts[0] || null;

  useEffect(() => {
    if (!selected) return;
    setConnectMethod(selected.connectionMethod);
    setAccountIdentifier(selected.accountIdentifier || '');
    setDisplayName(selected.displayName || '');
    setProfileUrl(selected.profileUrl || '');
    setCredentialSecret('');
    setCredentialScope(selected.credentialScope || '');
    setExpiresAt(selected.expiresAt ? selected.expiresAt.slice(0, 16) : '');
    void loadLogs(selected.id);
  }, [selected?.id, loadLogs]);

  const handleToggleEnabled = async (acc: PlatformAccountRecord) => {
    setBusyId(acc.id);
    setFeedback(null);
    try {
      const res = await apiRequest<{ account: PlatformAccountRecord }>(`/api/platform-accounts/${acc.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !acc.enabled }),
      });
      setAccounts((prev) => prev.map((a) => (a.id === acc.id ? res.account : a)));
      setFeedback({ type: 'ok', text: `${acc.platformName} ${res.account.enabled ? 'enabled' : 'disabled'}.` });
      if (selected?.id === acc.id) void loadLogs(acc.id);
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Update failed' });
    } finally {
      setBusyId(null);
    }
  };

  const handleToggleCapability = async (acc: PlatformAccountRecord, key: keyof PlatformCapabilities) => {
    if (!acc.permittedCapabilities[key]) {
      setFeedback({
        type: 'err',
        text: `${CAPABILITY_LABELS.find((c) => c.key === key)?.label || key} is locked by ${acc.platformName} compliance policy.`,
      });
      return;
    }
    setBusyId(acc.id);
    setFeedback(null);
    try {
      const res = await apiRequest<{ account: PlatformAccountRecord }>(`/api/platform-accounts/${acc.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ capabilities: { [key]: !acc.capabilities[key] } }),
      });
      setAccounts((prev) => prev.map((a) => (a.id === acc.id ? res.account : a)));
      void loadLogs(acc.id);
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Failed to toggle capability' });
    } finally {
      setBusyId(null);
    }
  };

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    setBusyId(selected.id);
    setFeedback(null);
    try {
      const res = await apiRequest<{ account: PlatformAccountRecord }>(`/api/platform-accounts/${selected.id}/connect`, {
        method: 'POST',
        body: JSON.stringify({
          connectionMethod: connectMethod,
          accountIdentifier: accountIdentifier.trim() || undefined,
          displayName: displayName.trim() || undefined,
          profileUrl: profileUrl.trim() || undefined,
          credentialSecret: credentialSecret.trim() || undefined,
          credentialScope: credentialScope.trim() || undefined,
          expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        }),
      });
      setAccounts((prev) => prev.map((a) => (a.id === selected.id ? res.account : a)));
      setCredentialSecret('');
      setFeedback({
        type: 'ok',
        text: `Saved ${selected.platformName} connection (${MODE_LABELS[res.account.integrationMode]}).`,
      });
      void loadLogs(selected.id);
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Connection failed' });
    } finally {
      setBusyId(null);
    }
  };

  const handleTest = async (acc: PlatformAccountRecord) => {
    setBusyId(acc.id);
    setFeedback(null);
    try {
      const res = await apiRequest<{ ok: boolean; message: string; account: PlatformAccountRecord }>(
        `/api/platform-accounts/${acc.id}/test`,
        { method: 'POST' },
      );
      setAccounts((prev) => prev.map((a) => (a.id === acc.id ? res.account : a)));
      setFeedback({ type: res.ok ? 'ok' : 'err', text: res.message });
      if (selected?.id === acc.id) void loadLogs(acc.id);
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Connection test failed' });
    } finally {
      setBusyId(null);
    }
  };

  const handleDisconnect = async (acc: PlatformAccountRecord) => {
    setBusyId(acc.id);
    setFeedback(null);
    try {
      const res = await apiRequest<{ account: PlatformAccountRecord }>(
        `/api/platform-accounts/${acc.id}/disconnect`,
        { method: 'POST' },
      );
      setAccounts((prev) => prev.map((a) => (a.id === acc.id ? res.account : a)));
      setFeedback({
        type: 'ok',
        text: `Disconnected ${acc.platformName} and cleared stored encrypted credentials.`,
      });
      if (selected?.id === acc.id) void loadLogs(acc.id);
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Disconnect failed' });
    } finally {
      setBusyId(null);
    }
  };

  const handleCreateCustom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!customName.trim()) return;
    setBusyId('custom');
    setFeedback(null);
    try {
      const res = await apiRequest<{ account: PlatformAccountRecord }>('/api/platform-accounts', {
        method: 'POST',
        body: JSON.stringify({
          platformName: customName.trim(),
          integrationMode: customMode,
          profileUrl: customProfileUrl.trim() || undefined,
          policySummary: customPolicy.trim() || undefined,
        }),
      });
      setAccounts((prev) => [...prev, res.account]);
      setSelectedId(res.account.id);
      setCustomName('');
      setCustomProfileUrl('');
      setCustomPolicy('');
      setShowAddCustom(false);
      setFeedback({ type: 'ok', text: `Added custom platform adapter "${res.account.platformName}".` });
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Failed to create adapter' });
    } finally {
      setBusyId(null);
    }
  };

  const connectedCount = accounts.filter((a) => a.status === 'connected' && a.enabled).length;
  const manualAssistedCount = accounts.filter((a) => a.integrationMode === 'MODE_C_MANUAL_ASSISTANCE').length;

  return (
    <div className="space-y-6">
      {/* Header Row */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800/80 pb-4">
        <div>
          <h2 className="text-lg font-semibold text-white">Platform Accounts & Capability Policy Engine</h2>
          <p className="text-sm text-slate-400 mt-0.5">
            Manage freelance marketplaces, remote job boards, isolated encrypted credentials, and per-capability compliance rules.
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          {onNavigateSources && (
            <button
              onClick={onNavigateSources}
              className="px-3 py-2 text-xs font-medium text-slate-300 hover:text-white bg-slate-900 border border-slate-800 rounded-lg transition-colors whitespace-nowrap"
            >
              Connector Rate Limits
            </button>
          )}
          <button
            onClick={() => setShowAddCustom((v) => !v)}
            className="px-3 py-2 text-xs font-medium text-white bg-cyan-600 hover:bg-cyan-500 rounded-lg flex items-center gap-1.5 transition-colors whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Platform Adapter
          </button>
          <button
            onClick={() => void loadAccounts()}
            className="p-2 text-slate-400 hover:text-white bg-slate-900 border border-slate-800 rounded-lg transition-colors"
            title="Refresh platform accounts"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Summary Metrics Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-[#0B1221] border border-slate-800/80 rounded-xl p-4">
          <div className="text-xs text-slate-400 uppercase tracking-wider">Registered Platforms</div>
          <div className="text-2xl font-semibold text-white mt-1 tabular-nums">{accounts.length}</div>
          <div className="text-xs text-slate-500 mt-1">10 built-in + custom adapters</div>
        </div>
        <div className="bg-[#0B1221] border border-slate-800/80 rounded-xl p-4">
          <div className="text-xs text-slate-400 uppercase tracking-wider">Active / Connected</div>
          <div className="text-2xl font-semibold text-emerald-400 mt-1 tabular-nums">{connectedCount}</div>
          <div className="text-xs text-slate-500 mt-1">Permitted public feeds & official APIs</div>
        </div>
        <div className="bg-[#0B1221] border border-slate-800/80 rounded-xl p-4">
          <div className="text-xs text-slate-400 uppercase tracking-wider">Manual Assistance Mode</div>
          <div className="text-2xl font-semibold text-cyan-400 mt-1 tabular-nums">{manualAssistedCount}</div>
          <div className="text-xs text-slate-500 mt-1">Zero unauthorized scraping or bots</div>
        </div>
        <div className="bg-[#0B1221] border border-slate-800/80 rounded-xl p-4">
          <div className="text-xs text-slate-400 uppercase tracking-wider">Credential Isolation</div>
          <div className="text-2xl font-semibold text-white mt-1">AES-256-GCM</div>
          <div className="text-xs text-slate-500 mt-1">Never exposed to AI prompts or logs</div>
        </div>
      </div>

      {feedback && (
        <div
          className={`px-4 py-3 rounded-lg border text-sm flex items-center gap-2 ${
            feedback.type === 'ok'
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
              : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
          }`}
        >
          {feedback.type === 'ok' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertTriangle className="w-4 h-4 shrink-0" />}
          <span>{feedback.text}</span>
        </div>
      )}

      {/* Custom Adapter Form */}
      {showAddCustom && (
        <form
          onSubmit={handleCreateCustom}
          className="bg-[#0B1221] border border-slate-800/80 rounded-xl p-5 grid grid-cols-1 md:grid-cols-2 gap-4"
        >
          <div className="md:col-span-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white">Register Extensible Platform Adapter</h3>
            <button
              type="button"
              onClick={() => setShowAddCustom(false)}
              className="text-xs text-slate-400 hover:text-white"
            >
              Cancel
            </button>
          </div>
          <div>
            <label className="text-xs text-slate-400 block mb-1">Platform Name</label>
            <input
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              placeholder="e.g. Toptal, Malt, FlexJobs"
              required
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-500"
            />
          </div>
          <div>
            <label className="text-xs text-slate-400 block mb-1">Integration Mode</label>
            <select
              value={customMode}
              onChange={(e) => setCustomMode(e.target.value as PlatformIntegrationMode)}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-500"
            >
              <option value="MODE_C_MANUAL_ASSISTANCE">Mode C — Manual Assistance (Default Safe)</option>
              <option value="MODE_A_OFFICIAL_API">Mode A — Official API Integration</option>
              <option value="MODE_D_PUBLIC_SOURCE">Mode D — Public Source Integration</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-slate-400 block mb-1">Profile / Portal URL (Optional)</label>
            <input
              value={customProfileUrl}
              onChange={(e) => setCustomProfileUrl(e.target.value)}
              placeholder="https://example.com/profile"
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-500"
            />
          </div>
          <div>
            <label className="text-xs text-slate-400 block mb-1">Policy Notes</label>
            <input
              value={customPolicy}
              onChange={(e) => setCustomPolicy(e.target.value)}
              placeholder="Document permitted API scopes or manual rules"
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-500"
            />
          </div>
          <div className="md:col-span-2 flex justify-end">
            <button
              type="submit"
              disabled={busyId === 'custom'}
              className="px-4 py-2 text-xs font-medium bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg disabled:opacity-50"
            >
              Create Adapter
            </button>
          </div>
        </form>
      )}

      {/* Main Split Layout: Platform List + Selected Platform Detail & Policy Matrix */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        {/* Left List */}
        <div className="xl:col-span-5 bg-[#0B1221] border border-slate-800/80 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-800/80 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Platform Adapters
            </span>
            <span className="text-xs text-slate-500 tabular-nums">{accounts.length} total</span>
          </div>
          <div className="divide-y divide-slate-800/60 max-h-[720px] overflow-y-auto">
            {accounts.map((acc) => {
              const isSelected = selected?.id === acc.id;
              return (
                <button
                  key={acc.id}
                  onClick={() => setSelectedId(acc.id)}
                  className={`w-full text-left px-4 py-3.5 transition-colors flex items-center justify-between gap-3 ${
                    isSelected ? 'bg-cyan-500/10' : 'hover:bg-slate-900/60'
                  }`}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-white truncate">{acc.platformName}</span>
                      {acc.hasStoredCredentials && (
                        <Lock className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                      )}
                    </div>
                    <div className="text-xs text-slate-400 mt-0.5 truncate">
                      {MODE_LABELS[acc.integrationMode]} · {METHOD_LABELS[acc.connectionMethod]}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className={`text-xs font-medium ${statusTextColor(acc.status)}`}>
                      {acc.status.replace(/_/g, ' ')}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      {acc.enabled ? 'enabled' : 'disabled'}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Right Detail Panel */}
        <div className="xl:col-span-7 space-y-5">
          {selected ? (
            <>
              <div className="bg-[#0B1221] border border-slate-800/80 rounded-xl p-5 space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-800/80 pb-4">
                  <div>
                    <div className="flex items-center gap-2.5">
                      <h3 className="text-base font-semibold text-white">{selected.platformName}</h3>
                      <span className={`text-xs font-medium ${statusTextColor(selected.status)}`}>
                        · {selected.status.replace(/_/g, ' ')}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 mt-1">{selected.policySummary}</p>
                    <p className="text-xs text-amber-300/90 mt-1.5 flex items-center gap-1.5">
                      <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
                      <span>{selected.complianceRestriction}</span>
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      onClick={() => void handleTest(selected)}
                      disabled={busyId === selected.id}
                      className="px-3 py-1.5 text-xs font-medium text-cyan-300 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 rounded-lg transition-colors whitespace-nowrap"
                    >
                      Test Connection
                    </button>
                    <button
                      onClick={() => void handleToggleEnabled(selected)}
                      disabled={busyId === selected.id}
                      className="px-3 py-1.5 text-xs font-medium text-slate-200 bg-slate-900 hover:bg-slate-800 border border-slate-700 rounded-lg transition-colors whitespace-nowrap"
                    >
                      {selected.enabled ? 'Disable' : 'Enable'}
                    </button>
                    {(selected.hasStoredCredentials || selected.status === 'connected') && (
                      <button
                        onClick={() => void handleDisconnect(selected)}
                        disabled={busyId === selected.id}
                        className="px-3 py-1.5 text-xs font-medium text-rose-300 bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 rounded-lg flex items-center gap-1.5 transition-colors whitespace-nowrap"
                      >
                        <Unplug className="w-3.5 h-3.5" />
                        Disconnect
                      </button>
                    )}
                  </div>
                </div>

                {/* Metadata Strip */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs border-b border-slate-800/80 pb-4">
                  <div>
                    <div className="text-slate-500">Integration Mode</div>
                    <div className="text-slate-200 font-medium mt-0.5">{MODE_LABELS[selected.integrationMode]}</div>
                  </div>
                  <div>
                    <div className="text-slate-500">Credentials Stored</div>
                    <div className="text-slate-200 font-medium mt-0.5">
                      {selected.hasStoredCredentials ? 'Encrypted (AES-256-GCM)' : 'None stored'}
                    </div>
                  </div>
                  <div>
                    <div className="text-slate-500">Last Verified</div>
                    <div className="text-slate-200 font-medium mt-0.5 tabular-nums">
                      {formatShortDate(selected.lastVerifiedAt)}
                    </div>
                  </div>
                  <div>
                    <div className="text-slate-500">Token Expiry</div>
                    <div className="text-slate-200 font-medium mt-0.5 tabular-nums">
                      {selected.expiresAt ? formatShortDate(selected.expiresAt) : 'N/A'}
                    </div>
                  </div>
                </div>

                {selected.lastError && (
                  <div className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg px-3 py-2">
                    Last status message: {selected.lastError}
                  </div>
                )}

                {/* Connection & Account Configuration Form */}
                <form onSubmit={handleConnect} className="space-y-3">
                  <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                    Connect / Reconnect Account
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs text-slate-400 block mb-1">Connection Method</label>
                      <select
                        value={connectMethod}
                        onChange={(e) => setConnectMethod(e.target.value as PlatformConnectionMethod)}
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-500"
                      >
                        {selected.supportedMethods.map((m) => (
                          <option key={m} value={m}>
                            {METHOD_LABELS[m]}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="text-xs text-slate-400 block mb-1">Account Username / Email (Optional)</label>
                      <input
                        value={accountIdentifier}
                        onChange={(e) => setAccountIdentifier(e.target.value)}
                        placeholder="you@domain.com or @handle"
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-500"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-slate-400 block mb-1">Display Name</label>
                      <input
                        value={displayName}
                        onChange={(e) => setDisplayName(e.target.value)}
                        placeholder="Freelancer profile label"
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-500"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-slate-400 block mb-1">Profile URL</label>
                      <div className="flex items-center gap-2">
                        <input
                          value={profileUrl}
                          onChange={(e) => setProfileUrl(e.target.value)}
                          placeholder="https://..."
                          className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-500"
                        />
                        {isSafeHttpUrl(profileUrl) && (
                          <a
                            href={profileUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="p-2 text-cyan-400 hover:text-cyan-300 bg-slate-900 border border-slate-800 rounded-lg"
                            title="Open profile"
                          >
                            <ExternalLink className="w-4 h-4" />
                          </a>
                        )}
                      </div>
                    </div>

                    {(connectMethod === 'official_oauth' || connectMethod === 'official_api_key') && (
                      <>
                        <div>
                          <label className="text-xs text-slate-400 block mb-1">
                            Official OAuth Token / API Key (Encrypted at Rest)
                          </label>
                          <input
                            type="password"
                            value={credentialSecret}
                            onChange={(e) => setCredentialSecret(e.target.value)}
                            placeholder={selected.hasStoredCredentials ? '•••••••• (enter to replace)' : 'Paste official token'}
                            className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-500"
                          />
                        </div>
                        <div>
                          <label className="text-xs text-slate-400 block mb-1">Token Expiry (Optional)</label>
                          <input
                            type="datetime-local"
                            value={expiresAt}
                            onChange={(e) => setExpiresAt(e.target.value)}
                            className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-500"
                          />
                        </div>
                      </>
                    )}
                  </div>

                  <div className="flex items-center justify-between pt-2">
                    <span className="text-xs text-slate-500">
                      Credentials are never sent to AI prompts, browser storage, or frontend payloads.
                    </span>
                    <button
                      type="submit"
                      disabled={busyId === selected.id}
                      className="px-4 py-2 text-xs font-medium bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg flex items-center gap-1.5 transition-colors whitespace-nowrap disabled:opacity-50"
                    >
                      <Plug className="w-3.5 h-3.5" />
                      {selected.hasStoredCredentials ? 'Reconnect / Update' : 'Save Connection'}
                    </button>
                  </div>
                </form>
              </div>

              {/* Independent Capability Toggles Matrix */}
              <div className="bg-[#0B1221] border border-slate-800/80 rounded-xl p-5">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <h4 className="text-sm font-semibold text-white">Capability & Compliance Matrix</h4>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Each capability can be toggled independently within platform policy boundaries. Locked items are prohibited by platform terms.
                    </p>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {CAPABILITY_LABELS.map(({ key, label }) => {
                    const enabled = selected.capabilities[key];
                    const permitted = selected.permittedCapabilities[key];
                    return (
                      <div
                        key={key}
                        className="flex items-center justify-between px-3 py-2 rounded-lg bg-slate-950/70 border border-slate-800/70"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          {!permitted && <Lock className="w-3.5 h-3.5 text-slate-500 shrink-0" />}
                          <span className={`text-xs truncate ${permitted ? 'text-slate-200' : 'text-slate-500'}`}>
                            {label}
                          </span>
                        </div>
                        <button
                          type="button"
                          disabled={!permitted || busyId === selected.id}
                          onClick={() => void handleToggleCapability(selected, key)}
                          className={`text-xs font-medium px-2 py-0.5 rounded transition-colors whitespace-nowrap ${
                            !permitted
                              ? 'text-slate-500 cursor-not-allowed'
                              : enabled
                                ? 'text-emerald-300 bg-emerald-500/15 hover:bg-emerald-500/25'
                                : 'text-slate-400 bg-slate-800/70 hover:text-white'
                          }`}
                        >
                          {!permitted ? 'Policy Locked' : enabled ? 'Enabled' : 'Disabled'}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Platform Activity Log */}
              <div className="bg-[#0B1221] border border-slate-800/80 rounded-xl p-5">
                <div className="flex items-center gap-2 mb-3">
                  <Activity className="w-4 h-4 text-cyan-400" />
                  <h4 className="text-sm font-semibold text-white">Platform Activity Log</h4>
                </div>
                {logs.length === 0 ? (
                  <p className="text-xs text-slate-500">No recorded events for {selected.platformName} yet.</p>
                ) : (
                  <div className="divide-y divide-slate-800/60 max-h-56 overflow-y-auto">
                    {logs.map((log) => (
                      <div key={log.id} className="py-2 flex items-start justify-between gap-3 text-xs">
                        <div>
                          <span className="font-medium text-slate-200">{log.action.replace(/_/g, ' ')}</span>
                          <p className="text-slate-400 mt-0.5">{log.message}</p>
                        </div>
                        <span className="text-[11px] text-slate-500 shrink-0 tabular-nums">
                          {formatShortDate(log.createdAt)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="bg-[#0B1221] border border-slate-800/80 rounded-xl p-8 text-center text-sm text-slate-400">
              Select a platform adapter to configure connection settings and capabilities.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
