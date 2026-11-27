import React, { useEffect, useState } from 'react';
import { Save, Activity, Zap, Download, HardDrive, Terminal } from 'lucide-react';
import { apiRequest, formatShortDate } from '../api.ts';
import type { AiProviderRecord, HubSettings } from '../../shared/types.ts';

interface SettingsViewProps {
  onSettingsChanged: () => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({ onSettingsChanged }) => {
  const [tab, setTab] = useState<'providers' | 'scoring' | 'filters' | 'resources' | 'system'>('providers');
  const [settings, setSettings] = useState<HubSettings | null>(null);
  const [providers, setProviders] = useState<AiProviderRecord[]>([]);
  const [apiKeysDraft, setApiKeysDraft] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadAll = async () => {
    const [sRes, pRes] = await Promise.all([
      apiRequest<{ settings: HubSettings }>('/api/settings'),
      apiRequest<{ providers: AiProviderRecord[] }>('/api/ai-providers'),
    ]);
    setSettings(sRes.settings);
    setProviders(pRes.providers);
  };

  useEffect(() => {
    void loadAll();
  }, []);

  const handleSaveSettings = async () => {
    if (!settings) return;
    setBusy(true);
    setFeedback(null);
    try {
      const res = await apiRequest<{ settings: HubSettings }>('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ settings }),
      });
      setSettings(res.settings);
      onSettingsChanged();
      setFeedback('Settings saved to SQLite database.');
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setBusy(false);
    }
  };

  const handleSaveProvider = async (p: AiProviderRecord) => {
    setBusy(true);
    setFeedback(null);
    try {
      await apiRequest(`/api/ai-providers/${p.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: p.name,
          providerType: p.providerType,
          apiUrl: p.apiUrl,
          apiKey: p.providerType === 'gemini' ? undefined : apiKeysDraft[p.id] || undefined,
          model: p.model,
          contextLimit: p.contextLimit,
          timeoutMs: p.timeoutMs,
          priority: p.priority,
          role: p.role,
          enabled: p.enabled,
        }),
      });
      setApiKeysDraft((prev) => ({ ...prev, [p.id]: '' }));
      await loadAll();
      setFeedback(`Updated AI provider "${p.name}". Credentials are encrypted at rest and never returned in plaintext.`);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Provider update failed');
    } finally {
      setBusy(false);
    }
  };

  const handleHealthCheck = async (providerId: string) => {
    setBusy(true);
    setFeedback(null);
    try {
      const res = await apiRequest<{ online: boolean; latencyMs: number; availableModels: string[]; message: string }>(
        `/api/ai-providers/${providerId}/health`,
        { method: 'POST' },
      );
      await loadAll();
      setFeedback(
        `${providerId}: ${res.online ? 'ONLINE' : 'OFFLINE'} (${res.latencyMs}ms) — ${res.message}${
          res.availableModels.length > 0 ? `. Models: ${res.availableModels.slice(0, 6).join(', ')}` : ''
        }`,
      );
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Health check failed');
    } finally {
      setBusy(false);
    }
  };

  const handleTestCompletion = async (providerId: string) => {
    setBusy(true);
    setFeedback(null);
    try {
      const res = await apiRequest<{ ok: boolean; result: { text: string; model: string; latencyMs: number } }>(
        `/api/ai-providers/${providerId}/test`,
        { method: 'POST', body: JSON.stringify({}) },
      );
      setFeedback(`Model test succeeded (${res.result.model}, ${res.result.latencyMs}ms): "${res.result.text}"`);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Model test failed');
    } finally {
      setBusy(false);
    }
  };

  const handleExportConfig = async () => {
    const data = await apiRequest<Record<string, unknown>>('/api/settings/export');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `freelance_hub_config_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setFeedback('Exported sanitized configuration JSON (all API keys omitted).');
  };

  const handleCreateBackup = async () => {
    setBusy(true);
    try {
      const res = await apiRequest<{ backupPath: string }>('/api/backup/create', { method: 'POST' });
      setFeedback(`SQLite & settings backup created at: ${res.backupPath}`);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Backup failed');
    } finally {
      setBusy(false);
    }
  };

  if (!settings) return <div className="text-xs text-slate-400 p-6">Loading settings...</div>;

  const weightTotal = Object.values(settings.scoreWeights).reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-white tracking-tight">Settings & System Configuration</h1>
          <p className="text-sm text-slate-400 mt-1">
            Configure local-first Ollama & fallback AI providers, scoring weights, graphic design exclusions, resource limits, and Windows backups.
          </p>
        </div>
        {tab !== 'providers' && tab !== 'system' && (
          <button
            onClick={handleSaveSettings}
            disabled={busy}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-cyan-500 text-slate-950 hover:bg-cyan-400 self-start whitespace-nowrap"
          >
            <Save className="w-3.5 h-3.5" />
            <span>{busy ? 'Saving...' : 'Save Settings'}</span>
          </button>
        )}
      </div>

      {/* Sub-tabs */}
      <div className="flex flex-wrap items-center gap-1 p-1 bg-[#0B1221] border border-slate-800 rounded-lg w-fit">
        {[
          { id: 'providers', label: 'AI Providers & Routing' },
          { id: 'scoring', label: 'Scoring Weights' },
          { id: 'filters', label: 'Filters & Skills' },
          { id: 'resources', label: 'Resources & Scheduler' },
          { id: 'system', label: 'Windows, Backup & Export' },
        ].map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id as typeof tab)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap ${
              tab === t.id ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-400 hover:text-white'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {feedback && (
        <div className="text-xs text-cyan-200 bg-cyan-500/10 border border-cyan-500/30 rounded-lg px-4 py-2.5">
          {feedback}
        </div>
      )}

      {/* 1. AI Providers */}
      {tab === 'providers' && (
        <div className="space-y-4">
          <p className="text-xs text-slate-400">
            Routing runs strictly in priority order (Priority 1 = Local Ollama first, then enabled fallbacks). Connectivity is verified with real live requests — providers are never assumed online.
          </p>
          {providers.map((p, idx) => (
            <div key={p.id} className="bg-[#0B1221] border border-slate-800/90 rounded-xl p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-white">{p.name}</h2>
                  <p className="text-xs text-slate-400 font-mono">
                    Priority #{p.priority} · Type: {p.providerType} · Status:{' '}
                    <span
                      className={
                        p.lastStatus === 'online'
                          ? 'text-emerald-400'
                          : p.lastStatus === 'offline' || p.lastStatus === 'error'
                            ? 'text-rose-400'
                            : 'text-amber-300'
                      }
                    >
                      {p.lastStatus}
                    </span>
                    {p.lastCheckedAt ? ` · Checked ${formatShortDate(p.lastCheckedAt)}` : ''}
                  </p>
                  {p.lastError && <p className="text-xs text-rose-400 mt-1">{p.lastError}</p>}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <label className="inline-flex items-center gap-1.5 text-xs text-slate-300 mr-2">
                    <input
                      type="checkbox"
                      checked={p.enabled}
                      onChange={(e) => {
                        const copy = [...providers];
                        copy[idx] = { ...p, enabled: e.target.checked };
                        setProviders(copy);
                      }}
                    />
                    <span>Enabled</span>
                  </label>
                  <button
                    onClick={() => handleHealthCheck(p.id)}
                    disabled={busy}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs border border-slate-700 rounded-lg text-slate-200 hover:border-cyan-400/50"
                  >
                    <Activity className="w-3.5 h-3.5" />
                    <span>Check Health</span>
                  </button>
                  <button
                    onClick={() => handleTestCompletion(p.id)}
                    disabled={busy || !p.enabled}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs border border-slate-700 rounded-lg text-cyan-300 hover:border-cyan-400/50 disabled:opacity-40"
                  >
                    <Zap className="w-3.5 h-3.5" />
                    <span>Test Model</span>
                  </button>
                  <button
                    onClick={() => handleSaveProvider(p)}
                    disabled={busy}
                    className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-cyan-500 text-slate-950 hover:bg-cyan-400"
                  >
                    Save
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-4 gap-3 text-xs">
                <div className="md:col-span-2">
                  <label className="block text-slate-400 mb-1">Endpoint URL</label>
                  <input
                    value={p.apiUrl}
                    disabled={p.providerType === 'gemini'}
                    onChange={(e) => {
                      const copy = [...providers];
                      copy[idx] = { ...p, apiUrl: e.target.value };
                      setProviders(copy);
                    }}
                    className="w-full bg-[#060A14] border border-slate-700 rounded-lg px-3 py-2 font-mono text-white disabled:opacity-60"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Model Name</label>
                  <input
                    value={p.model}
                    onChange={(e) => {
                      const copy = [...providers];
                      copy[idx] = { ...p, model: e.target.value };
                      setProviders(copy);
                    }}
                    className="w-full bg-[#060A14] border border-slate-700 rounded-lg px-3 py-2 font-mono text-white"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Priority (1 = Highest)</label>
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={p.priority}
                    onChange={(e) => {
                      const copy = [...providers];
                      copy[idx] = { ...p, priority: Number(e.target.value) };
                      setProviders(copy);
                    }}
                    className="w-full bg-[#060A14] border border-slate-700 rounded-lg px-3 py-2 font-mono text-white"
                  />
                </div>

                {p.providerType === 'freellmapi' || p.providerType === 'openai_compatible' ? (
                  <div className="md:col-span-2">
                    <label className="block text-slate-400 mb-1">
                      Optional Endpoint Token ({p.hasApiKey ? 'Encrypted key stored' : 'Not set'})
                    </label>
                    <input
                      type="password"
                      placeholder="Leave blank to keep existing or use server .env"
                      value={apiKeysDraft[p.id] || ''}
                      onChange={(e) => setApiKeysDraft({ ...apiKeysDraft, [p.id]: e.target.value })}
                      className="w-full bg-[#060A14] border border-slate-700 rounded-lg px-3 py-2 text-white"
                    />
                  </div>
                ) : p.providerType === 'gemini' ? (
                  <div className="md:col-span-4 text-slate-400">
                    Managed strictly via server environment variable (<span className="font-mono">GEMINI_API_KEY</span>). Keys are never entered or exposed in the browser.
                  </div>
                ) : (
                  <div className="md:col-span-4 text-slate-400">
                    Runs locally via Ollama on Windows (<span className="font-mono">http://127.0.0.1:11434</span>). No API key required.
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 2. Scoring Weights */}
      {tab === 'scoring' && (
        <div className="bg-[#0B1221] border border-slate-800/90 rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-white">Job Analyst Scoring Rubric</h2>
              <p className="text-xs text-slate-400">Adjust point allocations across the 7 scoring dimensions.</p>
            </div>
            <span className={`text-sm font-mono font-semibold ${weightTotal === 100 ? 'text-emerald-400' : 'text-amber-300'}`}>
              Total: {weightTotal} pts
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            {(
              [
                ['skillCompatibility', 'Skill Compatibility'],
                ['budget', 'Budget & Return'],
                ['timeRequired', 'Time Required'],
                ['deadlineFeasibility', 'Deadline Feasibility'],
                ['clientCredibility', 'Client Credibility'],
                ['competition', 'Competition'],
                ['risk', 'Risk & Safety'],
              ] as const
            ).map(([key, label]) => (
              <div key={key} className="flex items-center justify-between gap-4 border-b border-slate-800/70 pb-3">
                <label className="text-slate-200 font-medium">{label}</label>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={settings.scoreWeights[key]}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      scoreWeights: { ...settings.scoreWeights, [key]: Number(e.target.value) },
                    })
                  }
                  className="w-24 bg-[#060A14] border border-slate-700 rounded-lg px-3 py-1.5 font-mono text-right text-white"
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 3. Filters & Skills */}
      {tab === 'filters' && (
        <div className="bg-[#0B1221] border border-slate-800/90 rounded-xl p-6 space-y-5 text-xs">
          <label className="flex items-center justify-between gap-4 pb-4 border-b border-slate-800/80 cursor-pointer">
            <div>
              <span className="text-sm font-semibold text-white block">Exclude Graphic Design Jobs (Default Policy)</span>
              <span className="text-slate-400">
                Automatically rejects jobs where logos, Photoshop, Illustrator, banners, flyers, or brand graphics are the primary deliverable.
              </span>
            </div>
            <input
              type="checkbox"
              checked={settings.filters.excludeGraphicDesign}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  filters: { ...settings.filters, excludeGraphicDesign: e.target.checked },
                })
              }
              className="w-4 h-4"
            />
          </label>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <label className="block text-slate-400 mb-1">Minimum Budget ($)</label>
              <input
                type="number"
                value={settings.filters.minBudget}
                onChange={(e) =>
                  setSettings({ ...settings, filters: { ...settings.filters, minBudget: Number(e.target.value) } })
                }
                className="w-full bg-[#060A14] border border-slate-700 rounded-lg px-3 py-2 font-mono text-white"
              />
            </div>
            <div>
              <label className="block text-slate-400 mb-1">Max Working Hours</label>
              <input
                type="number"
                value={settings.filters.maxWorkingHours}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    filters: { ...settings.filters, maxWorkingHours: Number(e.target.value) },
                  })
                }
                className="w-full bg-[#060A14] border border-slate-700 rounded-lg px-3 py-2 font-mono text-white"
              />
            </div>
            <div>
              <label className="block text-slate-400 mb-1">Min Match Score</label>
              <input
                type="number"
                value={settings.filters.minMatchScore}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    filters: { ...settings.filters, minMatchScore: Number(e.target.value) },
                  })
                }
                className="w-full bg-[#060A14] border border-slate-700 rounded-lg px-3 py-2 font-mono text-white"
              />
            </div>
            <div>
              <label className="block text-slate-400 mb-1">Scam Risk Threshold</label>
              <input
                type="number"
                value={settings.filters.scamRiskThreshold}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    filters: { ...settings.filters, scamRiskThreshold: Number(e.target.value) },
                  })
                }
                className="w-full bg-[#060A14] border border-slate-700 rounded-lg px-3 py-2 font-mono text-white"
              />
            </div>
          </div>

          <div>
            <label className="block text-slate-400 mb-1">Your Profile Skills (comma-separated)</label>
            <textarea
              rows={2}
              value={settings.userSkills.join(', ')}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  userSkills: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                })
              }
              className="w-full bg-[#060A14] border border-slate-700 rounded-lg px-3 py-2 text-white"
            />
          </div>

          <div>
            <label className="block text-slate-400 mb-1">Excluded Keywords (comma-separated)</label>
            <textarea
              rows={2}
              value={settings.filters.excludedKeywords.join(', ')}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  filters: {
                    ...settings.filters,
                    excludedKeywords: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                  },
                })
              }
              className="w-full bg-[#060A14] border border-slate-700 rounded-lg px-3 py-2 text-white"
            />
          </div>
        </div>
      )}

      {/* 4. Resources & Scheduler */}
      {tab === 'resources' && (
        <div className="bg-[#0B1221] border border-slate-800/90 rounded-xl p-6 space-y-5 text-xs">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-slate-400 mb-1">Max Concurrent Agents (1 recommended for 8GB PCs)</label>
              <input
                type="number"
                min={1}
                max={6}
                value={settings.resourceLimits.maxConcurrentAgents}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    resourceLimits: { ...settings.resourceLimits, maxConcurrentAgents: Number(e.target.value) },
                  })
                }
                className="w-full bg-[#060A14] border border-slate-700 rounded-lg px-3 py-2 font-mono text-white"
              />
            </div>
            <div>
              <label className="block text-slate-400 mb-1">Max Memory Threshold (%)</label>
              <input
                type="number"
                min={50}
                max={95}
                value={settings.resourceLimits.maxMemoryPercent}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    resourceLimits: { ...settings.resourceLimits, maxMemoryPercent: Number(e.target.value) },
                  })
                }
                className="w-full bg-[#060A14] border border-slate-700 rounded-lg px-3 py-2 font-mono text-white"
              />
            </div>
            <div>
              <label className="block text-slate-400 mb-1">Max CPU Threshold (%)</label>
              <input
                type="number"
                min={50}
                max={95}
                value={settings.resourceLimits.maxCpuPercent}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    resourceLimits: { ...settings.resourceLimits, maxCpuPercent: Number(e.target.value) },
                  })
                }
                className="w-full bg-[#060A14] border border-slate-700 rounded-lg px-3 py-2 font-mono text-white"
              />
            </div>
          </div>

          <div className="pt-4 border-t border-slate-800/80 grid grid-cols-1 md:grid-cols-3 gap-4">
            <label className="flex items-center gap-2 text-slate-200 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.scheduler.enabled}
                onChange={(e) =>
                  setSettings({ ...settings, scheduler: { ...settings.scheduler, enabled: e.target.checked } })
                }
              />
              <span>Enable Scheduled Job Discovery</span>
            </label>
            <div>
              <label className="block text-slate-400 mb-1">Search Frequency (minutes)</label>
              <input
                type="number"
                min={10}
                max={1440}
                value={settings.scheduler.searchFrequencyMinutes}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    scheduler: { ...settings.scheduler, searchFrequencyMinutes: Number(e.target.value) },
                  })
                }
                className="w-full bg-[#060A14] border border-slate-700 rounded-lg px-3 py-2 font-mono text-white"
              />
            </div>
            <div>
              <label className="block text-slate-400 mb-1">Max QA Correction Retries</label>
              <input
                type="number"
                min={0}
                max={5}
                value={settings.scheduler.maxCorrectionRetries}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    scheduler: { ...settings.scheduler, maxCorrectionRetries: Number(e.target.value) },
                  })
                }
                className="w-full bg-[#060A14] border border-slate-700 rounded-lg px-3 py-2 font-mono text-white"
              />
            </div>
          </div>
        </div>
      )}

      {/* 5. Windows Deployment, Backups & Sanitized Export */}
      {tab === 'system' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-[#0B1221] border border-slate-800/90 rounded-xl p-5 space-y-4">
            <div className="flex items-center gap-2">
              <HardDrive className="w-4 h-4 text-cyan-400" />
              <h2 className="text-sm font-semibold text-white">Local Storage, Backup & Configuration</h2>
            </div>
            <p className="text-xs text-slate-400 font-mono break-all">
              Active Workspace Root: {settings.workspaceLocation}
            </p>
            <div className="flex flex-wrap gap-2.5">
              <button
                onClick={handleCreateBackup}
                disabled={busy}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg bg-cyan-500 text-slate-950 hover:bg-cyan-400"
              >
                <HardDrive className="w-3.5 h-3.5" />
                <span>Create SQLite Backup Now</span>
              </button>
              <button
                onClick={handleExportConfig}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-700 text-slate-200 hover:border-cyan-400/50"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Export Sanitized Config JSON</span>
              </button>
            </div>
            <p className="text-xs text-slate-500">
              Exported configuration files strictly strip all encrypted API tokens and passcodes.
            </p>
          </div>

          <div className="bg-[#0B1221] border border-slate-800/90 rounded-xl p-5 space-y-3">
            <div className="flex items-center gap-2">
              <Terminal className="w-4 h-4 text-cyan-400" />
              <h2 className="text-sm font-semibold text-white">Windows 10/11 & Cloud Local Run Commands</h2>
            </div>
            <p className="text-xs text-slate-400">
              This full-stack application runs natively outside any sandbox using PowerShell scripts in <span className="font-mono text-slate-200">scripts/</span>:
            </p>
            <pre className="bg-[#060A14] border border-slate-800 rounded-lg p-3.5 text-xs font-mono text-cyan-200 overflow-x-auto">
{`# Windows 10/11 PowerShell
.\\scripts\\install.ps1
.\\scripts\\start.ps1
.\\scripts\\check-health.ps1
.\\scripts\\backup.ps1
.\\scripts\\stop.ps1

# Linux / Cloud Node.js 22+
npm install && npm run build
NODE_ENV=production PORT=3000 npm start`}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
};
