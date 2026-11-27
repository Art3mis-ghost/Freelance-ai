import React, { useEffect, useState } from 'react';
import { ShieldCheck, CheckCircle2, XCircle, RefreshCw } from 'lucide-react';
import { apiRequest, formatShortDate } from '../api.ts';
import type { ProjectRecord, QaReportRecord } from '../../shared/types.ts';

export const QualityControlView: React.FC = () => {
  const [reports, setReports] = useState<QaReportRecord[]>([]);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [selectedReport, setSelectedReport] = useState<QaReportRecord | null>(null);
  const [busy, setBusy] = useState(false);

  const loadData = async () => {
    const [qaRes, projRes] = await Promise.all([
      apiRequest<{ reports: QaReportRecord[] }>('/api/qa'),
      apiRequest<{ projects: ProjectRecord[] }>('/api/projects'),
    ]);
    setReports(qaRes.reports);
    setProjects(projRes.projects);
    setSelectedReport((prev) => qaRes.reports.find((r) => r.id === prev?.id) || qaRes.reports[0] || null);
  };

  useEffect(() => {
    void loadData();
  }, []);

  const projectTitle = (projectId: string) => projects.find((p) => p.id === projectId)?.title || projectId;

  const handleRerunQa = async (projectId: string) => {
    setBusy(true);
    try {
      await apiRequest(`/api/projects/${projectId}/qa`, { method: 'POST' });
      await loadData();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-white tracking-tight">Quality Control</h1>
          <p className="text-sm text-slate-400 mt-1">
            Independent QA verification reports checking file existence, binary headers, placeholders, and bounded correction retries.
          </p>
        </div>
        <div className="text-xs text-slate-400 font-mono">
          90-100 Ready for review · 75-89 Needs review · &lt;75 Needs correction
        </div>
      </div>

      {reports.length === 0 ? (
        <div className="bg-[#0B1221] border border-slate-800 rounded-xl p-10 text-center text-xs text-slate-400">
          No QA reports recorded yet. Approve and execute a project to trigger independent QA verification.
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <div className="lg:col-span-4 bg-[#0B1221] border border-slate-800/90 rounded-xl p-4 space-y-2">
            <h2 className="text-sm font-semibold text-white mb-2">QA Audit History ({reports.length})</h2>
            <div className="divide-y divide-slate-800/70 max-h-[560px] overflow-y-auto">
              {reports.map((r) => (
                <button
                  key={r.id}
                  onClick={() => setSelectedReport(r)}
                  className={`w-full text-left py-3 px-2.5 rounded-lg transition-colors ${
                    selectedReport?.id === r.id ? 'bg-cyan-500/10 text-white' : 'hover:bg-slate-800/40 text-slate-300'
                  }`}
                >
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-mono font-semibold text-cyan-300">Attempt #{r.attemptNumber}</span>
                    <span
                      className={`font-mono tabular-nums font-semibold ${
                        r.score >= 90 ? 'text-emerald-400' : r.score >= 75 ? 'text-amber-300' : 'text-rose-400'
                      }`}
                    >
                      {r.score}/100
                    </span>
                  </div>
                  <p className="text-xs font-medium text-slate-100 truncate mt-1">{projectTitle(r.projectId)}</p>
                  <p className="text-xs text-slate-500 mt-0.5 capitalize">
                    {r.status.replace(/_/g, ' ')} · {formatShortDate(r.createdAt)}
                  </p>
                </button>
              ))}
            </div>
          </div>

          <div className="lg:col-span-8 bg-[#0B1221] border border-slate-800/90 rounded-xl p-5 space-y-5">
            {selectedReport && (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-slate-800/80">
                  <div>
                    <h2 className="text-base font-semibold text-white">{projectTitle(selectedReport.projectId)}</h2>
                    <p className="text-xs text-slate-400">
                      Attempt #{selectedReport.attemptNumber} · {formatShortDate(selectedReport.createdAt)} · Status:{' '}
                      <span className="text-cyan-300 capitalize">{selectedReport.status.replace(/_/g, ' ')}</span>
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span
                      className={`text-2xl font-bold font-mono tabular-nums ${
                        selectedReport.score >= 90
                          ? 'text-emerald-400'
                          : selectedReport.score >= 75
                            ? 'text-amber-300'
                            : 'text-rose-400'
                      }`}
                    >
                      {selectedReport.score}/100
                    </span>
                    <button
                      onClick={() => handleRerunQa(selectedReport.projectId)}
                      disabled={busy}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-700 text-slate-200 hover:border-cyan-400/50"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      <span>Re-Run QA</span>
                    </button>
                  </div>
                </div>

                <div className="bg-slate-900/70 border border-slate-800 rounded-lg px-4 py-3 text-xs text-slate-300 flex items-start gap-2.5">
                  <ShieldCheck className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" />
                  <span>{selectedReport.disclaimer}</span>
                </div>

                <div className="divide-y divide-slate-800/70">
                  {selectedReport.checklist.map((item) => (
                    <div key={item.id} className="py-3 flex items-start justify-between gap-4 text-xs">
                      <div className="flex items-start gap-2.5">
                        {item.passed ? (
                          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                        ) : (
                          <XCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                        )}
                        <div>
                          <p className="font-medium text-slate-100">{item.label}</p>
                          <p className="text-slate-400 mt-0.5">{item.notes}</p>
                        </div>
                      </div>
                      <span className="text-slate-500 capitalize shrink-0">{item.severity}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
