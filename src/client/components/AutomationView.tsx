import React, { useCallback, useEffect, useState } from 'react';
import { ShieldAlert, CheckCircle2, XCircle, RotateCcw, Save, Sliders, RefreshCw } from 'lucide-react';
import { apiRequest, formatMoney, formatShortDate } from '../api.ts';
import type { ApprovalRecord, AutonomyConfig, AutonomyLevel } from '../../shared/types.ts';

interface LevelMeta {
  name: string;
  summary: string;
  permittedScope: string;
  blockedScope: string;
}

export const AutomationView: React.FC<{ onApprovalChanged?: () => void }> = ({ onApprovalChanged }) => {
  const [config, setConfig] = useState<AutonomyConfig | null>(null);
  const [levels, setLevels] = useState<Record<string, LevelMeta>>({});
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [filter, setFilter] = useState<'pending' | 'all' | 'approved' | 'rejected'>('pending');
  const [noteById, setNoteById] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const loadAll = useCallback(async () => {
    setBusy(true);
    try {
      const [autoRes, apprRes] = await Promise.all([
        apiRequest<{ config: AutonomyConfig; levels: Record<string, LevelMeta> }>('/api/autonomy'),
        apiRequest<{ approvals: ApprovalRecord[] }>(`/api/approvals?status=${filter}`),
      ]);
      setConfig(autoRes.config);
      setLevels(autoRes.levels);
      setApprovals(apprRes.approvals);
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Failed to load automation settings' });
    } finally {
      setBusy(false);
    }
  }, [filter]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const handleSaveConfig = async () => {
    if (!config) return;
    setBusy(true);
    setFeedback(null);
    try {
      const res = await apiRequest<{ config: AutonomyConfig }>('/api/autonomy', {
        method: 'PUT',
        body: JSON.stringify(config),
      });
      setConfig(res.config);
      setFeedback({ type: 'ok', text: `Saved Autonomy Level ${res.config.level} and approval guardrails.` });
      onApprovalChanged?.();
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Failed to save autonomy rules' });
    } finally {
      setBusy(false);
    }
  };

  const handleDecision = async (id: string, decision: 'approved' | 'rejected' | 'revoked') => {
    setBusy(true);
    setFeedback(null);
    try {
      await apiRequest(`/api/approvals/${id}/decide`, {
        method: 'POST',
        body: JSON.stringify({ decision, decisionNote: noteById[id] || undefined }),
      });
      setFeedback({ type: 'ok', text: `Approval request marked as ${decision}.` });
      await loadAll();
      onApprovalChanged?.();
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Decision failed' });
    } finally {
      setBusy(false);
    }
  };

  const pendingCount = approvals.filter((a) => a.status === 'pending').length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800/80 pb-4">
        <div>
          <h2 className="text-lg font-semibold text-white">Autonomy & Human Approval Center</h2>
          <p className="text-sm text-slate-400 mt-0.5">
            Control agent autonomy levels (1–5), daily rate/spending caps, and approve or reject high-impact external actions.
          </p>
        </div>
        <button
          onClick={() => void loadAll()}
          className="px-3 py-2 text-xs font-medium text-slate-300 hover:text-white bg-slate-900 border border-slate-800 rounded-lg flex items-center gap-1.5"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {feedback && (
        <div
          className={`px-4 py-3 rounded-lg border text-sm ${
            feedback.type === 'ok'
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
              : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
          }`}
        >
          {feedback.text}
        </div>
      )}

      {/* Autonomy Level Selector (1-5) */}
      {config && (
        <div className="bg-[#0B1221] border border-slate-800/80 rounded-xl p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Sliders className="w-4 h-4 text-cyan-400" />
              <h3 className="text-sm font-semibold text-white">Autonomy Level</h3>
            </div>
            <span className="text-xs text-amber-300">
              Invariant: Autonomy can never override platform ToS, CAPTCHA/MFA, paid bids, or security boundaries.
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
            {([1, 2, 3, 4, 5] as AutonomyLevel[]).map((lvl) => {
              const info = levels[String(lvl)];
              const active = config.level === lvl;
              return (
                <button
                  key={lvl}
                  type="button"
                  onClick={() => setConfig({ ...config, level: lvl })}
                  className={`text-left p-3.5 rounded-lg border transition-colors ${
                    active
                      ? 'bg-cyan-500/15 border-cyan-500/60 text-white'
                      : 'bg-slate-950/70 border-slate-800/80 text-slate-300 hover:border-slate-700'
                  }`}
                >
                  <div className="text-xs font-semibold text-cyan-400 tabular-nums">LEVEL {lvl}</div>
                  <div className="text-xs font-medium text-white mt-1">
                    {info?.name.replace(/^Level \d — /, '') || `Level ${lvl}`}
                  </div>
                  <p className="text-[11px] text-slate-400 mt-1.5 leading-relaxed">
                    {info?.summary || ''}
                  </p>
                </button>
              );
            })}
          </div>

          {levels[String(config.level)] && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs bg-slate-950/60 border border-slate-800/70 rounded-lg p-3.5">
              <div>
                <div className="text-emerald-400 font-medium">Permitted at Level {config.level}</div>
                <p className="text-slate-300 mt-1">{levels[String(config.level)].permittedScope}</p>
              </div>
              <div>
                <div className="text-rose-400 font-medium">Blocked / Gated at Level {config.level}</div>
                <p className="text-slate-300 mt-1">{levels[String(config.level)].blockedScope}</p>
              </div>
            </div>
          )}

          {/* Limits & Approval Gates */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
            <div>
              <label className="text-xs text-slate-400 block mb-1">Max Daily Applications</label>
              <input
                type="number"
                min={0}
                max={200}
                value={config.maxDailyApplications}
                onChange={(e) => setConfig({ ...config, maxDailyApplications: Number(e.target.value) })}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white tabular-nums"
              />
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">Max Bid Amount (USD)</label>
              <input
                type="number"
                min={0}
                max={100000}
                value={config.maxBidAmountUsd}
                onChange={(e) => setConfig({ ...config, maxBidAmountUsd: Number(e.target.value) })}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white tabular-nums"
              />
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">Max Daily Spend Cap (USD)</label>
              <input
                type="number"
                min={0}
                max={10000}
                value={config.maxDailySpendUsd}
                onChange={(e) => setConfig({ ...config, maxDailySpendUsd: Number(e.target.value) })}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white tabular-nums"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5 pt-1 text-xs">
            <label className="flex items-center gap-2 text-slate-200 bg-slate-950/60 border border-slate-800/70 rounded-lg px-3 py-2">
              <input
                type="checkbox"
                checked={config.requireApprovalForFinalDelivery}
                onChange={(e) => setConfig({ ...config, requireApprovalForFinalDelivery: e.target.checked })}
                className="accent-cyan-500"
              />
              Require Approval for Final Delivery
            </label>
            <label className="flex items-center gap-2 text-slate-200 bg-slate-950/60 border border-slate-800/70 rounded-lg px-3 py-2">
              <input
                type="checkbox"
                checked={config.requireApprovalForClientMessages}
                onChange={(e) => setConfig({ ...config, requireApprovalForClientMessages: e.target.checked })}
                className="accent-cyan-500"
              />
              Require Approval for Client Messages
            </label>
            <label className="flex items-center gap-2 text-slate-200 bg-slate-950/60 border border-slate-800/70 rounded-lg px-3 py-2">
              <input
                type="checkbox"
                checked={config.requireApprovalForExternalUploads}
                onChange={(e) => setConfig({ ...config, requireApprovalForExternalUploads: e.target.checked })}
                className="accent-cyan-500"
              />
              Require Approval for External Uploads
            </label>
            <label className="flex items-center gap-2 text-slate-400 bg-slate-950/40 border border-slate-800/50 rounded-lg px-3 py-2">
              <input type="checkbox" checked disabled className="accent-cyan-500" />
              Paid Bids Approval (Always Enforced)
            </label>
            <label className="flex items-center gap-2 text-slate-400 bg-slate-950/40 border border-slate-800/50 rounded-lg px-3 py-2">
              <input type="checkbox" checked disabled className="accent-cyan-500" />
              Contract Acceptance (Always Enforced)
            </label>
            <label className="flex items-center gap-2 text-slate-400 bg-slate-950/40 border border-slate-800/50 rounded-lg px-3 py-2">
              <input type="checkbox" checked disabled className="accent-cyan-500" />
              Pause on CAPTCHA/MFA (Always Enforced)
            </label>
          </div>

          <div className="flex justify-end pt-2">
            <button
              onClick={() => void handleSaveConfig()}
              disabled={busy}
              className="px-4 py-2 text-xs font-medium bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg flex items-center gap-1.5 transition-colors"
            >
              <Save className="w-3.5 h-3.5" />
              Save Autonomy Policy
            </button>
          </div>
        </div>
      )}

      {/* Approval Queue */}
      <div className="bg-[#0B1221] border border-slate-800/80 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-800/80 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-amber-400" />
            <h3 className="text-sm font-semibold text-white">
              Approval Queue <span className="text-slate-400 font-normal tabular-nums">({pendingCount} pending)</span>
            </h3>
          </div>
          <div className="flex items-center gap-1.5 text-xs">
            {(['pending', 'approved', 'rejected', 'all'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setFilter(tab)}
                className={`px-2.5 py-1 rounded-md capitalize transition-colors ${
                  filter === tab ? 'bg-cyan-500/15 text-cyan-300 font-medium' : 'text-slate-400 hover:text-white'
                }`}
              >
                {tab}
              </button>
            ))}
          </div>
        </div>

        {approvals.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-400">
            No {filter === 'all' ? '' : filter} approval requests. High-impact deliveries and external actions will appear here for sign-off.
          </div>
        ) : (
          <div className="divide-y divide-slate-800/60">
            {approvals.map((item) => (
              <div key={item.id} className="p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                <div className="space-y-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-semibold text-white text-sm">{item.title}</span>
                    <span className="text-slate-500">· {item.actionType.replace(/_/g, ' ')}</span>
                    {item.platformKey && <span className="text-cyan-400">· {item.platformKey}</span>}
                    <span
                      className={`font-medium ${
                        item.status === 'approved'
                          ? 'text-emerald-400'
                          : item.status === 'pending'
                            ? 'text-amber-400'
                            : 'text-rose-400'
                      }`}
                    >
                      · {item.status}
                    </span>
                  </div>
                  <p className="text-xs text-slate-300">{item.description}</p>
                  <div className="text-[11px] text-slate-500 flex flex-wrap items-center gap-3 tabular-nums">
                    <span>Requested: {formatShortDate(item.createdAt)}</span>
                    {item.estimatedCostUsd !== null && (
                      <span>Estimated Cost: {formatMoney(item.estimatedCostUsd)}</span>
                    )}
                    {item.decidedAt && (
                      <span>
                        Decided: {formatShortDate(item.decidedAt)} ({item.decidedBy || 'operator'})
                      </span>
                    )}
                    {item.decisionNote && <span>Note: {item.decisionNote}</span>}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  {item.status === 'pending' && (
                    <>
                      <input
                        value={noteById[item.id] || ''}
                        onChange={(e) => setNoteById((prev) => ({ ...prev, [item.id]: e.target.value }))}
                        placeholder="Decision note (optional)"
                        className="bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-white w-48"
                      />
                      <button
                        onClick={() => void handleDecision(item.id, 'approved')}
                        disabled={busy}
                        className="px-3 py-1.5 text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg flex items-center gap-1"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        Approve
                      </button>
                      <button
                        onClick={() => void handleDecision(item.id, 'rejected')}
                        disabled={busy}
                        className="px-3 py-1.5 text-xs font-medium bg-rose-600/20 hover:bg-rose-600/30 text-rose-300 border border-rose-500/30 rounded-lg flex items-center gap-1"
                      >
                        <XCircle className="w-3.5 h-3.5" />
                        Reject
                      </button>
                    </>
                  )}
                  {item.status === 'approved' && (
                    <button
                      onClick={() => void handleDecision(item.id, 'revoked')}
                      disabled={busy}
                      className="px-3 py-1.5 text-xs font-medium text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 rounded-lg flex items-center gap-1"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      Revoke Approval
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
