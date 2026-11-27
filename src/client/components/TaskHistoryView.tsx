import React, { useEffect, useState } from 'react';
import { RefreshCw, Pause, Play, XCircle, Terminal } from 'lucide-react';
import { apiRequest, formatShortDate } from '../api.ts';
import type { AgentTaskRecord } from '../../shared/types.ts';

interface TaskLogEntry {
  id: string;
  level: string;
  message: string;
  created_at: string;
}

interface AuditLogEntry {
  id: string;
  action: string;
  actor: string;
  resourceType: string;
  resourceId: string | null;
  severity: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export const TaskHistoryView: React.FC = () => {
  const [tab, setTab] = useState<'tasks' | 'audit'>('tasks');
  const [tasks, setTasks] = useState<AgentTaskRecord[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [statusFilter, setStatusFilter] = useState('all');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [taskLogs, setTaskLogs] = useState<TaskLogEntry[]>([]);

  const loadData = async () => {
    const [tRes, aRes] = await Promise.all([
      apiRequest<{ tasks: AgentTaskRecord[] }>(
        statusFilter === 'all' ? '/api/tasks' : `/api/tasks?status=${encodeURIComponent(statusFilter)}`,
      ),
      apiRequest<{ logs: AuditLogEntry[] }>('/api/audit-logs'),
    ]);
    setTasks(tRes.tasks);
    setAuditLogs(aRes.logs);
  };

  useEffect(() => {
    void loadData();
  }, [statusFilter]);

  const loadTaskLogs = async (taskId: string) => {
    setSelectedTaskId(taskId);
    const res = await apiRequest<{ logs: TaskLogEntry[] }>(`/api/tasks/${taskId}/logs`);
    setTaskLogs(res.logs);
  };

  const handleAction = async (taskId: string, action: 'pause' | 'resume' | 'cancel') => {
    await apiRequest(`/api/tasks/${taskId}/${action}`, { method: 'POST' });
    await loadData();
    if (selectedTaskId === taskId) {
      await loadTaskLogs(taskId);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-white tracking-tight">Task History & Audit Logs</h1>
          <p className="text-sm text-slate-400 mt-1">
            Persistent SQLite task queue with real pipeline cancellation, pause/resume controls, restart recovery, and security audit trail.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 p-1 bg-[#0B1221] border border-slate-800 rounded-lg">
            <button
              onClick={() => setTab('tasks')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md ${
                tab === 'tasks' ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-400 hover:text-white'
              }`}
            >
              Background Tasks ({tasks.length})
            </button>
            <button
              onClick={() => setTab('audit')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md ${
                tab === 'audit' ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-400 hover:text-white'
              }`}
            >
              Security Audit Log ({auditLogs.length})
            </button>
          </div>
          <button
            onClick={loadData}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs rounded-lg bg-[#0B1221] border border-slate-700 text-slate-300 hover:text-white"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {tab === 'tasks' ? (
        <>
          <div className="flex flex-wrap items-center gap-1 p-1 bg-[#0B1221] border border-slate-800 rounded-lg w-fit">
            {['all', 'queued', 'running', 'paused', 'completed', 'failed', 'cancelled'].map((st) => (
              <button
                key={st}
                onClick={() => setStatusFilter(st)}
                className={`px-3 py-1 text-xs font-medium rounded capitalize ${
                  statusFilter === st ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-400 hover:text-white'
                }`}
              >
                {st}
              </button>
            ))}
          </div>

          <div className="bg-[#0B1221] border border-slate-800/90 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-800 text-slate-400">
                    <th className="py-3 px-4 font-medium">Task</th>
                    <th className="py-3 px-4 font-medium">Agent</th>
                    <th className="py-3 px-4 font-medium">Status</th>
                    <th className="py-3 px-4 font-medium text-right">Progress</th>
                    <th className="py-3 px-4 font-medium text-right">Retries</th>
                    <th className="py-3 px-4 font-medium">Created</th>
                    <th className="py-3 px-4 font-medium text-right">Controls</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {tasks.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-8 text-center text-slate-500">
                        No background tasks recorded for this filter.
                      </td>
                    </tr>
                  ) : (
                    tasks.map((t) => (
                      <tr key={t.id} className="hover:bg-slate-800/30">
                        <td className="py-3 px-4">
                          <p className="font-mono text-slate-100">{t.taskType}</p>
                          <p className="text-slate-500 font-mono">{t.id}</p>
                          {t.errorMessage && <p className="text-rose-400 mt-0.5">{t.errorMessage}</p>}
                        </td>
                        <td className="py-3 px-4 font-mono text-slate-300">{t.agentType}</td>
                        <td className="py-3 px-4 capitalize">
                          <span
                            className={
                              t.status === 'completed'
                                ? 'text-emerald-400'
                                : t.status === 'running'
                                  ? 'text-cyan-400'
                                  : t.status === 'failed' || t.status === 'cancelled'
                                    ? 'text-rose-400'
                                    : 'text-amber-300'
                            }
                          >
                            {t.status}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-200">{t.progress}%</td>
                        <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-400">
                          {t.retries}/{t.maxRetries}
                        </td>
                        <td className="py-3 px-4 font-mono tabular-nums text-slate-400">{formatShortDate(t.createdAt)}</td>
                        <td className="py-3 px-4 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              onClick={() => loadTaskLogs(t.id)}
                              className="inline-flex items-center gap-1 px-2 py-1 border border-slate-700 rounded text-slate-300 hover:text-cyan-300"
                            >
                              <Terminal className="w-3 h-3" />
                              <span>Logs</span>
                            </button>
                            {t.status === 'queued' && (
                              <button
                                onClick={() => handleAction(t.id, 'pause')}
                                className="p-1.5 border border-slate-700 rounded text-amber-300 hover:bg-amber-500/10"
                                title="Pause task"
                              >
                                <Pause className="w-3 h-3" />
                              </button>
                            )}
                            {t.status === 'paused' && (
                              <button
                                onClick={() => handleAction(t.id, 'resume')}
                                className="p-1.5 border border-slate-700 rounded text-emerald-400 hover:bg-emerald-500/10"
                                title="Resume task"
                              >
                                <Play className="w-3 h-3" />
                              </button>
                            )}
                            {['queued', 'pending', 'running', 'paused'].includes(t.status) && (
                              <button
                                onClick={() => handleAction(t.id, 'cancel')}
                                className="p-1.5 border border-rose-500/30 rounded text-rose-400 hover:bg-rose-500/10"
                                title="Cancel task & halt pipeline"
                              >
                                <XCircle className="w-3 h-3" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {selectedTaskId && (
            <div className="bg-[#0B1221] border border-cyan-500/30 rounded-xl p-5 space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-mono font-semibold text-cyan-300">Execution Logs — {selectedTaskId}</h3>
                <button onClick={() => setSelectedTaskId(null)} className="text-xs text-slate-400 hover:text-white">
                  Close
                </button>
              </div>
              <div className="bg-[#060A14] border border-slate-800 rounded-lg p-3.5 font-mono text-xs space-y-1 max-h-64 overflow-y-auto">
                {taskLogs.length === 0 ? (
                  <p className="text-slate-500">No log lines recorded.</p>
                ) : (
                  taskLogs.map((l) => (
                    <div key={l.id} className="flex gap-3">
                      <span className="text-slate-500 shrink-0">{formatShortDate(l.created_at)}</span>
                      <span
                        className={
                          l.level === 'error'
                            ? 'text-rose-400'
                            : l.level === 'warning'
                              ? 'text-amber-300'
                              : 'text-slate-200'
                        }
                      >
                        {l.message}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="bg-[#0B1221] border border-slate-800/90 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400">
                  <th className="py-3 px-4 font-medium">Timestamp</th>
                  <th className="py-3 px-4 font-medium">Action</th>
                  <th className="py-3 px-4 font-medium">Resource</th>
                  <th className="py-3 px-4 font-medium">Severity</th>
                  <th className="py-3 px-4 font-medium">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {auditLogs.map((log) => (
                  <tr key={log.id}>
                    <td className="py-2.5 px-4 font-mono tabular-nums text-slate-400 whitespace-nowrap">
                      {formatShortDate(log.createdAt)}
                    </td>
                    <td className="py-2.5 px-4 font-mono text-slate-100 whitespace-nowrap">{log.action}</td>
                    <td className="py-2.5 px-4 text-slate-300 whitespace-nowrap">
                      {log.resourceType} {log.resourceId ? `(${log.resourceId})` : ''}
                    </td>
                    <td className="py-2.5 px-4 capitalize">
                      <span
                        className={
                          log.severity === 'error'
                            ? 'text-rose-400'
                            : log.severity === 'warning'
                              ? 'text-amber-300'
                              : 'text-slate-300'
                        }
                      >
                        {log.severity}
                      </span>
                    </td>
                    <td className="py-2.5 px-4 font-mono text-slate-400 max-w-md truncate">
                      {JSON.stringify(log.details)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
