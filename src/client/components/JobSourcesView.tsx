import React, { useEffect, useState } from 'react';
import { RefreshCw, Search, ShieldCheck } from 'lucide-react';
import { apiRequest, formatShortDate } from '../api.ts';
import type { JobSourceRecord } from '../../shared/types.ts';

interface SearchHistoryRow {
  id: string;
  source_id: string;
  query: string;
  jobs_found: number;
  jobs_imported: number;
  duplicates_skipped: number;
  status: string;
  error_message: string | null;
  started_at: string;
}

export const JobSourcesView: React.FC<{ onNavigateDiscovery: () => void }> = ({ onNavigateDiscovery }) => {
  const [sources, setSources] = useState<JobSourceRecord[]>([]);
  const [history, setHistory] = useState<SearchHistoryRow[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const loadSources = async () => {
    const res = await apiRequest<{ sources: JobSourceRecord[]; searchHistory: SearchHistoryRow[] }>('/api/sources');
    setSources(res.sources);
    setHistory(res.searchHistory);
  };

  useEffect(() => {
    void loadSources();
  }, []);

  const handleToggleEnabled = async (source: JobSourceRecord) => {
    setBusyId(source.id);
    try {
      await apiRequest(`/api/sources/${source.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: !source.enabled }),
      });
      await loadSources();
    } finally {
      setBusyId(null);
    }
  };

  const handleSearchSource = async (source: JobSourceRecord) => {
    setBusyId(source.id);
    setFeedback(null);
    try {
      const res = await apiRequest<{
        result: { jobsFound: number; jobsImported: number; duplicatesSkipped: number; error?: string };
      }>(`/api/sources/${source.id}/search`, {
        method: 'POST',
        body: JSON.stringify({ query: '', limit: 12 }),
      });
      if (res.result.error) {
        setFeedback(`${source.name}: ${res.result.error}`);
      } else {
        setFeedback(
          `${source.name}: found ${res.result.jobsFound}, imported ${res.result.jobsImported} new, skipped ${res.result.duplicatesSkipped} duplicates.`,
        );
      }
      await loadSources();
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-white tracking-tight">Job Sources & Connectors</h1>
          <p className="text-sm text-slate-400 mt-1">
            Official public API feeds run automatically within rate limits. Restricted platforms are transparently labeled as Manual Import Scaffolds to respect platform Terms of Service.
          </p>
        </div>
        <button
          onClick={loadSources}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-xs rounded-lg bg-[#0B1221] border border-slate-700 text-slate-300 hover:text-white self-start"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span>Refresh</span>
        </button>
      </div>

      {feedback && (
        <div className="text-xs text-cyan-200 bg-cyan-500/10 border border-cyan-500/30 rounded-lg px-4 py-2.5">
          {feedback}
        </div>
      )}

      <div className="bg-[#0B1221] border border-slate-800/90 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400">
                <th className="py-3 px-4 font-medium">Connector & Policy</th>
                <th className="py-3 px-4 font-medium">Status</th>
                <th className="py-3 px-4 font-medium text-right">Discovered</th>
                <th className="py-3 px-4 font-medium text-right">Rate Limit</th>
                <th className="py-3 px-4 font-medium">Last Search</th>
                <th className="py-3 px-4 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {sources.map((s) => (
                <tr key={s.id} className="hover:bg-slate-800/30">
                  <td className="py-3.5 px-4 max-w-md">
                    <p className="font-medium text-slate-100 text-sm">{s.name}</p>
                    <p className="text-slate-400 mt-0.5 leading-snug">{s.policyNote}</p>
                    <p className="text-slate-500 font-mono mt-1">
                      Capabilities: {s.capabilities.join(' · ')}
                    </p>
                    {s.lastError && <p className="text-rose-400 mt-1">Last error: {s.lastError}</p>}
                  </td>
                  <td className="py-3.5 px-4 whitespace-nowrap">
                    <span
                      className={
                        s.implementationStatus === 'scaffold_manual_only'
                          ? 'text-amber-300'
                          : s.connectionStatus === 'error'
                            ? 'text-rose-400'
                            : s.enabled
                              ? 'text-emerald-400'
                              : 'text-slate-500'
                      }
                    >
                      {s.implementationStatus === 'scaffold_manual_only'
                        ? 'Scaffold (Manual Only)'
                        : s.connectionStatus}
                    </span>
                  </td>
                  <td className="py-3.5 px-4 text-right font-mono tabular-nums text-slate-200 whitespace-nowrap">
                    {s.jobsDiscovered} / {s.jobsImported} imp
                  </td>
                  <td className="py-3.5 px-4 text-right font-mono tabular-nums text-slate-400 whitespace-nowrap">
                    {s.rateLimitPerHour}/hr · {s.searchFrequencyMinutes}m
                  </td>
                  <td className="py-3.5 px-4 font-mono tabular-nums text-slate-400 whitespace-nowrap">
                    {formatShortDate(s.lastSuccessfulSearch)}
                  </td>
                  <td className="py-3.5 px-4 text-right whitespace-nowrap">
                    <div className="inline-flex items-center gap-2">
                      {s.implementationStatus === 'functional' && s.connectorType === 'public_api' ? (
                        <>
                          <button
                            onClick={() => handleToggleEnabled(s)}
                            disabled={busyId === s.id}
                            className="px-2.5 py-1 border border-slate-700 rounded text-slate-200 hover:border-cyan-400/50"
                          >
                            {s.enabled ? 'Disable' : 'Enable'}
                          </button>
                          <button
                            onClick={() => handleSearchSource(s)}
                            disabled={busyId === s.id || !s.enabled}
                            className="inline-flex items-center gap-1 px-2.5 py-1 bg-cyan-500 text-slate-950 font-semibold rounded hover:bg-cyan-400 disabled:opacity-40"
                          >
                            <Search className="w-3 h-3" />
                            <span>Search Now</span>
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={onNavigateDiscovery}
                          className="inline-flex items-center gap-1 px-2.5 py-1 border border-slate-700 rounded text-cyan-300 hover:border-cyan-500/40"
                        >
                          <ShieldCheck className="w-3 h-3" />
                          <span>Use Manual Import</span>
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Search History */}
      <div className="bg-[#0B1221] border border-slate-800/90 rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-800/80">
          <h2 className="text-sm font-semibold text-white">Recent Discovery Search History</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400">
                <th className="py-2.5 px-4 font-medium">Started</th>
                <th className="py-2.5 px-4 font-medium">Source</th>
                <th className="py-2.5 px-4 font-medium">Query</th>
                <th className="py-2.5 px-4 font-medium text-right">Found</th>
                <th className="py-2.5 px-4 font-medium text-right">Imported</th>
                <th className="py-2.5 px-4 font-medium text-right">Duplicates</th>
                <th className="py-2.5 px-4 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {history.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-6 text-center text-slate-500">
                    No connector searches executed yet.
                  </td>
                </tr>
              ) : (
                history.map((h) => (
                  <tr key={h.id}>
                    <td className="py-2.5 px-4 font-mono tabular-nums text-slate-400">{formatShortDate(h.started_at)}</td>
                    <td className="py-2.5 px-4 font-mono text-slate-200">{h.source_id}</td>
                    <td className="py-2.5 px-4 text-slate-300">{h.query || '(all)'}</td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-300">{h.jobs_found}</td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums text-emerald-400">{h.jobs_imported}</td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-400">{h.duplicates_skipped}</td>
                    <td className="py-2.5 px-4 capitalize text-slate-300">{h.status.replace(/_/g, ' ')}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
