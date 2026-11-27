import React, { useEffect, useState } from 'react';
import { FolderOpen, Download, Package, ShieldCheck, Play, RefreshCw, Eye } from 'lucide-react';
import { apiRequest, buildDownloadUrl, formatBytes, formatShortDate } from '../api.ts';
import type { DeliverableRecord, JobRecord, ProjectRecord, ProjectTaskRecord, QaReportRecord } from '../../shared/types.ts';

interface WorkspaceFileItem {
  relativePath: string;
  filename: string;
  folder: string;
  sizeBytes: number;
  updatedAt: string;
  previewable: boolean;
}

interface ProjectWorkspaceViewProps {
  initialProjectId: string | null;
  onNavigateSubmissions: () => void;
  onChanged: () => void;
}

export const ProjectWorkspaceView: React.FC<ProjectWorkspaceViewProps> = ({
  initialProjectId,
  onNavigateSubmissions,
  onChanged,
}) => {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string>(initialProjectId || '');
  const [detail, setDetail] = useState<{
    project: ProjectRecord;
    job: JobRecord;
    subtasks: ProjectTaskRecord[];
    deliverables: DeliverableRecord[];
    files: WorkspaceFileItem[];
    qaReports: QaReportRecord[];
  } | null>(null);
  const [preview, setPreview] = useState<{ relativePath: string; filename: string; content: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const loadProjects = async () => {
    const res = await apiRequest<{ projects: ProjectRecord[] }>('/api/projects');
    setProjects(res.projects);
    if (!selectedId && res.projects.length > 0) {
      setSelectedId(res.projects[0].id);
    }
  };

  const loadProjectDetail = async (id: string) => {
    if (!id) return;
    const res = await apiRequest<{
      project: ProjectRecord;
      job: JobRecord;
      subtasks: ProjectTaskRecord[];
      deliverables: DeliverableRecord[];
      files: WorkspaceFileItem[];
      qaReports: QaReportRecord[];
    }>(`/api/projects/${id}`);
    setDetail(res);
  };

  useEffect(() => {
    if (initialProjectId) setSelectedId(initialProjectId);
  }, [initialProjectId]);

  useEffect(() => {
    void loadProjects();
  }, []);

  useEffect(() => {
    if (selectedId) {
      setPreview(null);
      void loadProjectDetail(selectedId);
    }
  }, [selectedId]);

  // Auto-poll while project is actively running
  useEffect(() => {
    if (!detail) return;
    if (!['planning', 'executing', 'qa_running', 'correcting'].includes(detail.project.status)) return;
    const timer = setInterval(() => {
      void loadProjectDetail(detail.project.id);
    }, 2000);
    return () => clearInterval(timer);
  }, [detail?.project.id, detail?.project.status]);

  const handlePreview = async (relPath: string) => {
    if (!selectedId) return;
    try {
      const res = await apiRequest<{ relativePath: string; filename: string; content: string }>(
        `/api/projects/${selectedId}/preview?path=${encodeURIComponent(relPath)}`,
      );
      setPreview(res);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Preview failed');
    }
  };

  const handlePackageZip = async () => {
    if (!selectedId) return;
    setBusy(true);
    setFeedback(null);
    try {
      const res = await apiRequest<{ deliverable: DeliverableRecord }>(`/api/projects/${selectedId}/package-zip`, {
        method: 'POST',
      });
      await loadProjectDetail(selectedId);
      setFeedback(`Packaged ${res.deliverable.filename} (${formatBytes(res.deliverable.sizeBytes)}).`);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'ZIP packaging failed');
    } finally {
      setBusy(false);
    }
  };

  const handleRunQa = async () => {
    if (!selectedId) return;
    setBusy(true);
    setFeedback(null);
    try {
      const res = await apiRequest<{ report: QaReportRecord }>(`/api/projects/${selectedId}/qa`, { method: 'POST' });
      await loadProjectDetail(selectedId);
      onChanged();
      setFeedback(`QA Agent completed attempt #${res.report.attemptNumber}: ${res.report.score}/100 (${res.report.status.replace(/_/g, ' ')}).`);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'QA run failed');
    } finally {
      setBusy(false);
    }
  };

  const handleReExecute = async () => {
    if (!selectedId) return;
    setBusy(true);
    setFeedback(null);
    try {
      await apiRequest(`/api/projects/${selectedId}/re-execute`, { method: 'POST' });
      await loadProjectDetail(selectedId);
      setFeedback('Queued fresh multi-agent execution pipeline.');
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Re-execution failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-white tracking-tight">Project Workspace</h1>
          <p className="text-sm text-slate-400 mt-1">
            Isolated per-project directories containing real DOCX, XLSX, CSV, PDF, PPTX, HTML, and ZIP deliverables.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            className="bg-[#0B1221] border border-slate-700 rounded-lg px-3 py-2 text-xs text-white min-w-[220px]"
          >
            {projects.length === 0 && <option value="">No approved projects yet</option>}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                [{p.status.replace(/_/g, ' ')}] {p.title.slice(0, 56)}
              </option>
            ))}
          </select>
          {selectedId && (
            <button
              onClick={() => loadProjectDetail(selectedId)}
              className="p-2 rounded-lg bg-[#0B1221] border border-slate-700 text-slate-300 hover:text-white"
              title="Refresh workspace"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {feedback && (
        <div className="text-xs text-cyan-200 bg-cyan-500/10 border border-cyan-500/30 rounded-lg px-4 py-2.5">
          {feedback}
        </div>
      )}

      {!detail ? (
        <div className="bg-[#0B1221] border border-slate-800 rounded-xl p-10 text-center text-xs text-slate-400">
          No approved project selected. Approve a shortlisted job from Job Details or Proposal Studio to create an isolated workspace and generate deliverables.
        </div>
      ) : (
        <>
          {/* Project Summary & Actions */}
          <div className="bg-[#0B1221] border border-slate-800/90 rounded-xl p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
            <div className="space-y-1">
              <h2 className="text-lg font-semibold text-white">{detail.project.title}</h2>
              <p className="text-xs text-slate-400">
                Status: <span className="text-cyan-300 capitalize">{detail.project.status.replace(/_/g, ' ')}</span>
                {' · '}QA Score:{' '}
                <span className="font-mono tabular-nums text-emerald-400">
                  {detail.project.qaScore !== null ? `${detail.project.qaScore}/100` : 'Pending'}
                </span>
                {' · '}Deliverables: <span className="font-mono tabular-nums text-slate-200">{detail.deliverables.length}</span>
              </p>
              <p className="text-xs font-mono text-slate-500 break-all">Isolated Root: {detail.project.workspacePath}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button
                onClick={handleReExecute}
                disabled={busy}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-700 text-slate-200 hover:border-cyan-400/50 whitespace-nowrap"
              >
                <Play className="w-3.5 h-3.5" />
                <span>Re-Run Agents</span>
              </button>
              <button
                onClick={handleRunQa}
                disabled={busy}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-700 text-slate-200 hover:border-cyan-400/50 whitespace-nowrap"
              >
                <ShieldCheck className="w-3.5 h-3.5" />
                <span>Run QA</span>
              </button>
              <button
                onClick={handlePackageZip}
                disabled={busy}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-500 text-white whitespace-nowrap"
              >
                <Package className="w-3.5 h-3.5" />
                <span>Package ZIP</span>
              </button>
              <button
                onClick={onNavigateSubmissions}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg bg-cyan-500 text-slate-950 hover:bg-cyan-400 whitespace-nowrap"
              >
                <span>Open Submission Center</span>
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* Subtasks Timeline */}
            <div className="lg:col-span-5 bg-[#0B1221] border border-slate-800/90 rounded-xl p-5 space-y-3">
              <h3 className="text-sm font-semibold text-white">Multi-Agent Execution Pipeline</h3>
              {detail.subtasks.length === 0 ? (
                <p className="text-xs text-slate-500">Execution subtasks will appear as soon as the queue dispatches.</p>
              ) : (
                <div className="divide-y divide-slate-800/70 text-xs">
                  {detail.subtasks.map((st) => (
                    <div key={st.id} className="py-3 space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-slate-100">{st.title}</span>
                        <span
                          className={`capitalize shrink-0 ${
                            st.status === 'completed'
                              ? 'text-emerald-400'
                              : st.status === 'running'
                                ? 'text-cyan-400'
                                : st.status === 'failed' || st.status === 'cancelled'
                                  ? 'text-rose-400'
                                  : 'text-slate-400'
                          }`}
                        >
                          {st.status}
                        </span>
                      </div>
                      <p className="text-slate-400 font-mono">
                        {st.agentType} {st.toolName ? `· ${st.toolName}` : ''}
                      </p>
                      {st.outputSummary && <p className="text-slate-300">{st.outputSummary}</p>}
                      {st.errorMessage && <p className="text-rose-400">{st.errorMessage}</p>}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Isolated Workspace Files & Preview */}
            <div className="lg:col-span-7 space-y-5">
              <div className="bg-[#0B1221] border border-slate-800/90 rounded-xl p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <FolderOpen className="w-4 h-4 text-cyan-400" />
                    <h3 className="text-sm font-semibold text-white">Workspace Files ({detail.files.length})</h3>
                  </div>
                  <span className="text-xs text-slate-500">Strictly confined to project directory</span>
                </div>

                <div className="divide-y divide-slate-800/70 max-h-72 overflow-y-auto text-xs">
                  {detail.files.map((f) => (
                    <div key={f.relativePath} className="py-2.5 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-mono text-slate-200 truncate">{f.relativePath}</p>
                        <p className="text-slate-500 font-mono tabular-nums">
                          {formatBytes(f.sizeBytes)} · {formatShortDate(f.updatedAt)}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          onClick={() => handlePreview(f.relativePath)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 border border-slate-700 rounded text-slate-300 hover:text-cyan-300 hover:border-cyan-500/40"
                        >
                          <Eye className="w-3 h-3" />
                          <span>Preview</span>
                        </button>
                        <a
                          href={buildDownloadUrl(detail.project.id, f.relativePath)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 bg-slate-800 hover:bg-slate-700 rounded text-slate-100"
                        >
                          <Download className="w-3 h-3" />
                          <span>Download</span>
                        </a>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {preview && (
                <div className="bg-[#0B1221] border border-cyan-500/30 rounded-xl p-5 space-y-2">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-mono font-semibold text-cyan-300">{preview.relativePath}</h3>
                    <button onClick={() => setPreview(null)} className="text-xs text-slate-400 hover:text-white">
                      Close Preview
                    </button>
                  </div>
                  <pre className="bg-[#060A14] border border-slate-800 rounded-lg p-3.5 text-xs font-mono text-slate-200 whitespace-pre-wrap max-h-80 overflow-y-auto">
                    {preview.content}
                  </pre>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
};
