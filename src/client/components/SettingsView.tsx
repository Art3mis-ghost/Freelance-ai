import React, { useEffect, useState } from 'react';
import { Save, Activity, Zap, Download, HardDrive, Terminal, Plus, Trash2 } from 'lucide-react';
import { apiRequest, formatShortDate } from '../api.ts';
import type { AiProviderErrorCode, AiProviderRecord, AiProviderType, HubSettings } from '../../shared/types.ts';

const BUILTIN_PROVIDER_IDS = new Set(['ollama_local', 'freellmapi', 'openai_compat', 'gemini_fallback']);

interface SettingsViewProps {
  onSettingsChanged: () => void;
  initialTab?: 'providers' | 'scoring' | 'filters' | 'resources' | 'system';
}

export const SettingsView: React.FC<SettingsViewProps> = ({ onSettingsChanged, initialTab = 'providers' }) => {
  const [tab, setTab] = useState<'providers' | 'scoring' | 'filters' | 'resources' | 'system'>(initialTab);

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);
  const [settings, setSettings] = useState<HubSettings | null>(null);
  const [providers, setProviders] = useState<AiProviderRecord[]>([]);
  const [apiKeysDraft, setApiKeysDraft] = useState<Record<string, string>>({});
  const [showAddProvider, setShowAddProvider] = useState(false);
  const [newProvider, setNewProvider] = useState<{
    name: string;
    providerType: Exclude<AiProviderType, 'gemini'>;
    apiUrl: string;
    model: string;
    apiKey: string;
    priority: number;
    enabled: boolean;
  }>({
    name: 'Local LM Studio',
    providerType: 'openai_compatible',
    apiUrl: 'http://127.0.0.1:1234/v1',
    model: 'auto',
    apiKey: '',
    priority: 5,
    enabled: true,
  });
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

  const persistProvider = async (p: AiProviderRecord) => {
    const draftKey = p.providerType === 'gemini' ? undefined : apiKeysDraft[p.id]?.trim() || undefined;
    await apiRequest(`/api/ai-providers/${p.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: p.name,
        providerType: p.providerType,
        apiUrl: p.apiUrl.trim(),
        apiKey: draftKey,
        model: p.model.trim(),
        contextLimit: p.contextLimit,
        timeoutMs: p.timeoutMs,
        priority: p.priority,
        role: p.role,
        enabled: p.enabled,
      }),
    });
    if (draftKey) {
      setApiKeysDraft((prev) => ({ ...prev, [p.id]: '' }));
    }
  };

  const handleSaveProvider = async (p: AiProviderRecord) => {
    setBusy(true);
    setFeedback(null);
    try {
      await persistProvider(p);
      const isRealUrl = Boolean(p.apiUrl.trim()) && !p.apiUrl.toLowerCase().includes('.example');
      if (isRealUrl && p.providerType !== 'gemini') {
        const res = await apiRequest<{
          online: boolean;
          latencyMs: number;
          availableModels: string[];
          message: string;
          errorCode?: AiProviderErrorCode | null;
        }>(`/api/ai-providers/${p.id}/health`, { method: 'POST' });
        await loadAll();
        setFeedback(
          `Saved "${p.name}" (credentials encrypted at rest). Connectivity check: ${res.online ? 'ONLINE' : 'OFFLINE'}${
            res.errorCode ? ` [${res.errorCode}]` : ''
          } (${res.latencyMs}ms) — ${res.message}`,
        );
      } else {
        await loadAll();
        setFeedback(`Updated AI provider "${p.name}". Credentials are encrypted at rest and never returned in plaintext.`);
      }
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Provider update failed');
    } finally {
      setBusy(false);
    }
  };

  const handleAddCustomProvider = async () => {
    setBusy(true);
    setFeedback(null);
    try {
      const created = await apiRequest<{ provider: AiProviderRecord }>('/api/ai-providers', {
        method: 'POST',
        body: JSON.stringify({
          name: newProvider.name.trim(),
          providerType: newProvider.providerType,
          apiUrl: newProvider.apiUrl.trim(),
          model: newProvider.model.trim() || 'auto',
          apiKey: newProvider.apiKey.trim() || undefined,
          priority: newProvider.priority,
          role: 'fallback',
          enabled: newProvider.enabled,
        }),
      });
      setShowAddProvider(false);
      setNewProvider({
        name: 'Local LM Studio',
        providerType: 'openai_compatible',
        apiUrl: 'http://127.0.0.1:1234/v1',
        model: 'auto',
        apiKey: '',
        priority: 5,
        enabled: true,
      });
      const health = await apiRequest<{
        online: boolean;
        latencyMs: number;
        message: string;
        errorCode?: AiProviderErrorCode | null;
      }>(`/api/ai-providers/${created.provider.id}/health`, { method: 'POST' });
      await loadAll();
      setFeedback(
        `Added "${created.provider.name}". Connectivity check: ${health.online ? 'ONLINE' : 'OFFLINE'}${
          health.errorCode ? ` [${health.errorCode}]` : ''
        } (${health.latencyMs}ms) — ${health.message}`,
      );
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Failed to add provider');
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteProvider = async (p: AiProviderRecord) => {
    setBusy(true);
    setFeedback(null);
    try {
      await apiRequest(`/api/ai-providers/${p.id}`, { method: 'DELETE' });
      await loadAll();
      setFeedback(`Removed custom AI provider "${p.name}".`);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Failed to delete provider');
    } finally {
      setBusy(false);
    }
  };

  const handleHealthCheck = async (providerId: string) => {
    setBusy(true);
    setFeedback(null);
    try {
      const target = providers.find((item) => item.id === providerId);
      if (target) {
        await persistProvider(target);
      }
      const res = await apiRequest<{
        online: boolean;
        latencyMs: number;
        availableModels: string[];
        message: string;
        errorCode?: AiProviderErrorCode | null;
      }>(`/api/ai-providers/${providerId}/health`, { method: 'POST' });
      await loadAll();
      setFeedback(
        `${providerId}: ${res.online ? 'ONLINE' : 'OFFLINE'}${res.errorCode ? ` [${res.errorCode}]` : ''} (${
          res.latencyMs
        }ms) — ${res.message}${
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
      const target = providers.find((item) => item.id === providerId);
      if (target) {
        await persistProvider(target);
      }
      const res = await apiRequest<{ ok: boolean; result: { text: string; model: string; latencyMs: number } }>(
        `/api/ai-providers/${providerId}/test`,
        { method: 'POST', body: JSON.stringify({}) },
      );
      await loadAll();
      setFeedback(`Model test succeeded (${res.result.model}, ${res.result.latencyMs}ms): "${res.result.text}"`);
    } catch (err) {
      await loadAll();
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
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-slate-400">
              Routing runs strictly in priority order. Supports remote HTTPS endpoints and explicit local loopback servers (<span className="font-mono text-slate-300">localhost</span>, <span className="font-mono text-slate-300">127.0.0.1</span>, <span className="font-mono text-slate-300">[::1]</span>) such as Ollama, FreeLLMAPI (<span className="font-mono text-slate-300">:31415/v1</span>), LM Studio (<span className="font-mono text-slate-300">:1234/v1</span>), and local vLLM (<span className="font-mono text-slate-300">:8000/v1</span>). Private LAN and cloud metadata addresses remain blocked.
            </p>
            <button
              onClick={() => setShowAddProvider((v) => !v)}
              disabled={busy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/10 whitespace-nowrap"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add Other Provider</span>
            </button>
          </div>

          {showAddProvider && (
            <div className="bg-[#0B1221] border border-cyan-500/40 rounded-xl p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-white">Add Custom / Local AI Provider (Other Providers)</h2>
                <button
                  onClick={() => setShowAddProvider(false)}
                  className="text-xs text-slate-400 hover:text-white"
                >
                  Cancel
                </button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3 text-xs">
                <div>
                  <label className="block text-slate-400 mb-1">Provider Name</label>
                  <input
                    value={newProvider.name}
                    onChange={(e) => setNewProvider({ ...newProvider, name: e.target.value })}
                    placeholder="e.g. Local LM Studio or Local vLLM"
                    className="w-full bg-[#060A14] border border-slate-700 rounded-lg px-3 py-2 text-white"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Provider Type</label>
                  <select
                    value={newProvider.providerType}
                    onChange={(e) =>
                      setNewProvider({
                        ...newProvider,
                        providerType: e.target.value as Exclude<AiProviderType, 'gemini'>,
                      })
                    }
                    className="w-full bg-[#060A14] border border-slate-700 rounded-lg px-3 py-2 text-white"
                  >
                    <option value="openai_compatible">OpenAI-Compatible (LM Studio, vLLM, etc.)</option>
                    <option value="freellmapi">FreeLLMAPI</option>
                    <option value="ollama">Ollama</option>
                  </select>
                </div>
                <div className="md:col-span-2">
                  <label className="block text-slate-400 mb-1">Endpoint URL</label>
                  <input
                    value={newProvider.apiUrl}
                    onChange={(e) => setNewProvider({ ...newProvider, apiUrl: e.target.value })}
                    placeholder="http://127.0.0.1:1234/v1 or https://api.example.com/v1"
                    className="w-full bg-[#060A14] border border-slate-700 rounded-lg px-3 py-2 font-mono text-white"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Model Name (supports "auto")</label>
                  <input
                    value={newProvider.model}
                    onChange={(e) => setNewProvider({ ...newProvider, model: e.target.value })}
                    placeholder="auto"
                    className="w-full bg-[#060A14] border border-slate-700 rounded-lg px-3 py-2 font-mono text-white"
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-slate-400 mb-1">Optional API Key / Token</label>
                  <input
                    type="password"
                    value={newProvider.apiKey}
                    onChange={(e) => setNewProvider({ ...newProvider, apiKey: e.target.value })}
                    placeholder="Optional for local servers; encrypted at rest"
                    className="w-full bg-[#060A14] border border-slate-700 rounded-lg px-3 py-2 text-white"
                  />
                </div>
                <div className="flex items-end justify-between gap-2">
                  <div className="w-24">
                    <label className="block text-slate-400 mb-1">Priority</label>
                    <input
                      type="number"
                      min={1}
                      max={20}
                      value={newProvider.priority}
                      onChange={(e) => setNewProvider({ ...newProvider, priority: Number(e.target.value) })}
                      className="w-full bg-[#060A14] border border-slate-700 rounded-lg px-3 py-2 font-mono text-white"
                    />
                  </div>
                  <button
                    onClick={handleAddCustomProvider}
                    disabled={busy || !newProvider.name.trim() || !newProvider.apiUrl.trim()}
                    className="px-4 py-2 text-xs font-semibold rounded-lg bg-cyan-500 text-slate-950 hover:bg-cyan-400 disabled:opacity-40 whitespace-nowrap"
                  >
                    Create & Check
                  </button>
                </div>
              </div>
            </div>
          )}

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
                    {p.lastErrorCode ? ` [${p.lastErrorCode}]` : ''}
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
                    disabled={busy}
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
                  {!BUILTIN_PROVIDER_IDS.has(p.id) && (
                    <button
                      onClick={() => handleDeleteProvider(p)}
                      disabled={busy}
                      title="Remove custom provider"
                      className="inline-flex items-center gap-1 px-2 py-1.5 text-xs border border-rose-800/70 rounded-lg text-rose-300 hover:bg-rose-500/10"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-4 gap-3 text-xs">
                <div className="md:col-span-2">
                  <label className="block text-slate-400 mb-1">Endpoint URL</label>
                  <input
                    value={p.apiUrl}
                    disabled={p.providerType === 'gemini'}
                    placeholder={
                      p.providerType === 'freellmapi'
                        ? 'http://127.0.0.1:31415/v1 or https://apifreellm.com/api/v1/chat'
                        : p.providerType === 'openai_compatible'
                          ? 'http://127.0.0.1:1234/v1 or http://127.0.0.1:8000/v1'
                          : 'http://127.0.0.1:11434'
                    }
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
                    placeholder="auto"
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
{`# Windows 10/11 (recommended .cmd wrappers — no script-signing errors)
.\\scripts\\install.cmd
.\\scripts\\start.cmd
.\\scripts\\check-health.cmd
.\\scripts\\backup.cmd
.\\scripts\\stop.cmd

# Linux / Cloud Node.js 22.13+
npm ci && npm run build
NODE_ENV=production PORT=3000 npm start`}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
};
