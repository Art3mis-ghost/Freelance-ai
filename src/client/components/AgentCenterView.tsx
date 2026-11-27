import React, { useEffect, useState } from 'react';
import { Pause, Play, RefreshCw, ShieldAlert, Cpu, GlobeLock } from 'lucide-react';
import { apiRequest, formatShortDate } from '../api.ts';
import type { ResourceSnapshot } from '../../shared/types.ts';

interface AgentStatusRow {
  id: string;
  name: string;
  role: string;
  allowedTools: string[];
  running: number;
  queued: number;
  completed: number;
  failed: number;
  status: string;
}

interface ToolDef {
  name: string;
  purpose: string;
  permissions: string[];
  timeoutMs: number;
  resourceLimitMb: number;
  riskLevel: 'low' | 'medium' | 'high';
  requiresApproval: boolean;
  authorized: boolean;
}

interface BrowserSession {
  id: string;
  connectorId: string;
  url: string;
  status: string;
  requiresHumanVerification: boolean;
  verificationNote: string | null;
  logs: string[];
  updatedAt: string;
}

export const AgentCenterView: React.FC = () => {
  const [agents, setAgents] = useState<AgentStatusRow[]>([]);
  const [tools, setTools] = useState<ToolDef[]>([]);
  const [resources, setResources] = useState<ResourceSnapshot | null>(null);
  const [sessions, setSessions] = useState<BrowserSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<string | null>(null);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [agentRes, sessRes] = await Promise.all([
        apiRequest<{ agents: AgentStatusRow[]; tools: ToolDef[]; resources: ResourceSnapshot }>('/api/agents'),
        apiRequest<{ sessions: BrowserSession[] }>('/api/browser-sessions'),
      ]);
      setAgents(agentRes.agents);
      setTools(agentRes.tools);
      setResources(agentRes.resources);
      setSessions(sessRes.sessions);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Failed to load agent telemetry');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAll();
  }, []);

  const toggleScheduler = async () => {
    if (!resources) return;
    const ep = resources.schedulerPaused ? '/api/scheduler/resume' : '/api/scheduler/pause';
    const res = await apiRequest<{ resources: ResourceSnapshot }>(ep, { method: 'POST' });
    setResources(res.resources);
    setFeedback(res.resources.schedulerPaused ? 'Background scheduler paused.' : 'Background scheduler resumed.');
  };

  const resumeBrowserSession = async (id: string) => {
    await apiRequest(`/api/browser-sessions/${id}/resume`, { method: 'POST' });
    await loadAll();
    setFeedback('Marked manual verification complete and resumed session.');
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-white tracking-tight">AI Agent Center</h1>
          <p className="text-sm text-slate-400 mt-1">
            Resource-aware orchestration for all 13 specialized agents, tool permissions, and policy-bound browser sessions.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {resources && (
            <button
              onClick={toggleScheduler}
              className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap ${
                resources.schedulerPaused
                  ? 'bg-emerald-500 text-slate-950 hover:bg-emerald-400'
                  : 'bg-amber-500/20 border border-amber-500/40 text-amber-200 hover:bg-amber-500/30'
              }`}
            >
              {resources.schedulerPaused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
              <span>{resources.schedulerPaused ? 'Resume Scheduler' : 'Pause Scheduler'}</span>
            </button>
          )}
          <button
            onClick={loadAll}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-[#0B1221] border border-slate-700 text-slate-300 hover:text-white"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {feedback && (
        <div className="text-xs text-cyan-200 bg-cyan-500/10 border border-cyan-500/30 rounded-lg px-4 py-2.5">
          {feedback}
        </div>
      )}

      {/* Resource-Aware Scheduler Panel */}
      {resources && (
        <div className="bg-[#0B1221] border border-slate-800/90 rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Cpu className="w-4 h-4 text-cyan-400" />
              <h2 className="text-sm font-semibold text-white">Resource-Aware Scheduler Telemetry</h2>
            </div>
            <span className="text-xs font-mono text-slate-400">
              {resources.platform} · Node {resources.nodeVersion}
            </span>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-xs">
            <div>
              <span className="text-slate-400 block">RAM Usage</span>
              <span className="font-mono tabular-nums text-lg font-semibold text-cyan-300">
                {resources.memoryUsedPercent}%
              </span>
              <span className="block text-slate-500 font-mono">
                {resources.memoryUsedMb} / {resources.memoryTotalMb} MB
              </span>
            </div>
            <div>
              <span className="text-slate-400 block">CPU Load</span>
              <span className="font-mono tabular-nums text-lg font-semibold text-blue-300">
                {resources.cpuLoadPercent}%
              </span>
              <span className="block text-slate-500">{resources.cpuCores} logical cores</span>
            </div>
            <div>
              <span className="text-slate-400 block">Disk Free</span>
              <span className="font-mono tabular-nums text-lg font-semibold text-slate-100">
                {resources.diskFreeGb !== null ? `${resources.diskFreeGb} GB` : '—'}
              </span>
              <span className="block text-slate-500">
                {resources.diskTotalGb !== null ? `of ${resources.diskTotalGb} GB` : 'Not reported'}
              </span>
            </div>
            <div>
              <span className="text-slate-400 block">Concurrency</span>
              <span className="font-mono tabular-nums text-lg font-semibold text-emerald-400">
                {resources.runningTasks}/{resources.maxConcurrentAgents}
              </span>
              <span className="block text-slate-500 font-mono">
                {resources.queuedTasks} queued · {resources.pausedTasks} paused
              </span>
            </div>
            <div>
              <span className="text-slate-400 block">Active Model</span>
              <span className="font-mono text-sm font-semibold text-white block truncate mt-1">
                {resources.activeModel || 'None loaded'}
              </span>
              <span className="block text-slate-500 capitalize">State: {resources.modelLoadingStatus}</span>
            </div>
          </div>
        </div>
      )}

      {/* 13 Specialized Agents Roster */}
      <div className="bg-[#0B1221] border border-slate-800/90 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-800/80">
          <h2 className="text-sm font-semibold text-white">Specialized Agent Roster (13 Agents)</h2>
          <p className="text-xs text-slate-400">Sequential-first execution prevents RAM exhaustion on modest Windows machines.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-800 text-xs text-slate-400">
                <th className="py-2.5 px-4 font-medium">Agent</th>
                <th className="py-2.5 px-4 font-medium">Responsibility</th>
                <th className="py-2.5 px-4 font-medium">Authorized Tools</th>
                <th className="py-2.5 px-4 font-medium text-right">Completed</th>
                <th className="py-2.5 px-4 font-medium text-right">Failed</th>
                <th className="py-2.5 px-4 font-medium">State</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70 text-xs">
              {loading ? (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-slate-500">
                    Loading agent roster...
                  </td>
                </tr>
              ) : (
                agents.map((a) => (
                  <tr key={a.id} className="hover:bg-slate-800/30">
                    <td className="py-3 px-4 font-medium text-slate-100 whitespace-nowrap">{a.name}</td>
                    <td className="py-3 px-4 text-slate-300">{a.role}</td>
                    <td className="py-3 px-4 font-mono text-slate-400">{a.allowedTools.join(', ')}</td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-emerald-400">{a.completed}</td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-rose-400">{a.failed}</td>
                    <td className="py-3 px-4 capitalize">
                      <span
                        className={
                          a.status === 'running'
                            ? 'text-cyan-400 font-medium'
                            : a.status === 'queued'
                              ? 'text-amber-300'
                              : 'text-slate-400'
                        }
                      >
                        {a.status}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Tool Permission Registry & Restricted Browser Policy */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-[#0B1221] border border-slate-800/90 rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-cyan-400" />
            <h2 className="text-sm font-semibold text-white">Sandbox Tool Permission Registry</h2>
          </div>
          <div className="divide-y divide-slate-800/70 max-h-80 overflow-y-auto pr-1 text-xs">
            {tools.map((t) => (
              <div key={t.name} className="py-2.5 flex items-start justify-between gap-3">
                <div>
                  <span className="font-mono font-medium text-slate-100">{t.name}</span>
                  <span className="text-slate-500"> · {t.riskLevel} risk · {t.timeoutMs / 1000}s cap</span>
                  <p className="text-slate-400 mt-0.5">{t.purpose}</p>
                </div>
                <span className={`shrink-0 font-medium ${t.authorized ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {t.authorized ? 'Authorized' : 'Blocked'}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-[#0B1221] border border-slate-800/90 rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2">
            <GlobeLock className="w-4 h-4 text-cyan-400" />
            <h2 className="text-sm font-semibold text-white">Restricted Browser Automation Policy</h2>
          </div>
          <p className="text-xs text-slate-400 leading-relaxed">
            Playwright / browser automation is disabled by default on prohibited freelance platforms. CAPTCHA bypass, anti-bot stealth, and authentication circumvention are permanently prohibited. If a permitted public page triggers human verification, tasks pause automatically for manual completion.
          </p>
          <div className="divide-y divide-slate-800/70 max-h-60 overflow-y-auto text-xs">
            {sessions.length === 0 ? (
              <p className="text-slate-500 py-4">No browser inspection sessions recorded.</p>
            ) : (
              sessions.map((s) => (
                <div key={s.id} className="py-2.5 space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-slate-200 truncate">{s.url}</span>
                    <span className="capitalize text-cyan-300 shrink-0">{s.status.replace(/_/g, ' ')}</span>
                  </div>
                  <p className="text-slate-500">{formatShortDate(s.updatedAt)}</p>
                  {s.requiresHumanVerification && (
                    <div className="flex items-center justify-between gap-2 pt-1">
                      <span className="text-amber-300">{s.verificationNote}</span>
                      <button
                        onClick={() => resumeBrowserSession(s.id)}
                        className="px-2.5 py-1 bg-amber-500/20 text-amber-200 border border-amber-500/40 rounded whitespace-nowrap"
                      >
                        Resume After Manual Check
                      </button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
