import React, { useEffect, useState } from 'react';
import { ArrowLeft, ExternalLink, Sparkles, FileSignature, Play, RotateCcw, AlertTriangle } from 'lucide-react';
import { apiRequest, formatMoney, formatShortDate, isSafeHttpUrl } from '../api.ts';
import type { JobRecord, ProjectRecord, ProposalRecord } from '../../shared/types.ts';

interface JobDetailsViewProps {
  jobId: string | null;
  onBack: () => void;
  onOpenProposalStudio: (jobId: string) => void;
  onOpenProjectWorkspace: (projectId: string) => void;
  onChanged: () => void;
}

export const JobDetailsView: React.FC<JobDetailsViewProps> = ({
  jobId,
  onBack,
  onOpenProposalStudio,
  onOpenProjectWorkspace,
  onChanged,
}) => {
  const [job, setJob] = useState<JobRecord | null>(null);
  const [proposals, setProposals] = useState<ProposalRecord[]>([]);
  const [project, setProject] = useState<ProjectRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const loadJob = async (id: string) => {
    setLoading(true);
    try {
      const res = await apiRequest<{ job: JobRecord; proposals: ProposalRecord[]; project: ProjectRecord | null }>(
        `/api/jobs/${id}`,
      );
      setJob(res.job);
      setProposals(res.proposals);
      setProject(res.project);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Failed to load job');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (jobId) {
      void loadJob(jobId);
    }
  }, [jobId]);

  if (!jobId) {
    return (
      <div className="bg-[#0B1221] border border-slate-800 rounded-xl p-8 text-center space-y-3">
        <p className="text-sm text-slate-300">Select a job from Job Discovery to inspect its full scoring breakdown and requirements.</p>
        <button
          onClick={onBack}
          className="px-4 py-2 text-xs font-semibold rounded-lg bg-cyan-500 text-slate-950 hover:bg-cyan-400"
        >
          Go to Job Discovery
        </button>
      </div>
    );
  }

  if (loading || !job) {
    return <div className="text-sm text-slate-400 p-6">Loading job analysis...</div>;
  }

  const handleAnalyze = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await apiRequest(`/api/jobs/${job.id}/analyze`, { method: 'POST', body: JSON.stringify({ useAi: true }) });
      await loadJob(job.id);
      onChanged();
      setMessage('Job re-analyzed using current Settings weights and active AI provider.');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Analysis failed');
    } finally {
      setBusy(false);
    }
  };

  const handleOverride = async () => {
    setBusy(true);
    try {
      await apiRequest(`/api/jobs/${job.id}/override-rejection`, { method: 'POST' });
      await loadJob(job.id);
      onChanged();
      setMessage('Rejection policy overridden for this specific job.');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Override failed');
    } finally {
      setBusy(false);
    }
  };

  const handleApproveProject = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await apiRequest<{ project: ProjectRecord; alreadyExists: boolean }>('/api/projects/approve', {
        method: 'POST',
        body: JSON.stringify({ jobId: job.id, proposalId: proposals[0]?.id || null }),
      });
      onChanged();
      onOpenProjectWorkspace(res.project.id);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Failed to approve project');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
        <div className="space-y-1.5">
          <button
            onClick={onBack}
            className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-cyan-300 transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Back to Job Discovery</span>
          </button>
          <h1 className="text-2xl font-semibold text-white tracking-tight">{job.title}</h1>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span>{job.sourceName}</span>
            <span>·</span>
            <span>{job.category}</span>
            <span>·</span>
            <span className="font-mono tabular-nums text-slate-200">
              {formatMoney(job.budget, job.currency)} ({job.paymentType})
            </span>
            <span>·</span>
            <span className="capitalize text-cyan-300">{job.status.replace(/_/g, ' ')}</span>
            {isSafeHttpUrl(job.jobUrl) && (
              <>
                <span>·</span>
                <a
                  href={job.jobUrl!}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-cyan-400 hover:underline"
                >
                  <span>Original Listing</span>
                  <ExternalLink className="w-3 h-3" />
                </a>
              </>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            onClick={handleAnalyze}
            disabled={busy}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-[#0B1221] border border-slate-700 text-slate-200 hover:border-cyan-400/50 whitespace-nowrap"
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>Re-Analyze</span>
          </button>
          {job.status === 'rejected' && (
            <button
              onClick={handleOverride}
              disabled={busy}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-amber-500/40 text-amber-300 hover:bg-amber-500/10 whitespace-nowrap"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Override Rejection</span>
            </button>
          )}
          <button
            onClick={() => onOpenProposalStudio(job.id)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-500 text-white whitespace-nowrap"
          >
            <FileSignature className="w-3.5 h-3.5" />
            <span>Proposal Studio ({proposals.length})</span>
          </button>
          {project ? (
            <button
              onClick={() => onOpenProjectWorkspace(project.id)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg bg-emerald-500 text-slate-950 hover:bg-emerald-400 whitespace-nowrap"
            >
              <Play className="w-3.5 h-3.5" />
              <span>Open Project Workspace</span>
            </button>
          ) : (
            <button
              onClick={handleApproveProject}
              disabled={busy || job.status === 'rejected'}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg bg-cyan-500 text-slate-950 hover:bg-cyan-400 disabled:opacity-40 whitespace-nowrap"
            >
              <Play className="w-3.5 h-3.5" />
              <span>Approve & Execute Work</span>
            </button>
          )}
        </div>
      </div>

      {message && (
        <div className="text-xs text-cyan-200 bg-cyan-500/10 border border-cyan-500/30 rounded-lg px-4 py-2.5">
          {message}
        </div>
      )}

      {/* Warnings: Graphic Design Exclusion / Scam / Prompt Injection */}
      {(job.rejectionReason || (job.analysis && job.analysis.scamIndicators.length > 0)) && (
        <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-4 space-y-1.5">
          <div className="flex items-center gap-2 text-rose-300 text-sm font-semibold">
            <AlertTriangle className="w-4 h-4" />
            <span>Policy & Risk Warnings</span>
          </div>
          {job.rejectionReason && <p className="text-xs text-rose-200">{job.rejectionReason}</p>}
          {job.analysis?.scamIndicators.map((ind, idx) => (
            <p key={idx} className="text-xs text-rose-200">
              • {ind}
            </p>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left 2 Columns: Description + Analysis Summary */}
        <div className="lg:col-span-2 space-y-5">
          <div className="bg-[#0B1221] border border-slate-800/90 rounded-xl p-5 space-y-3">
            <h2 className="text-sm font-semibold text-white">Job Requirements & Untrusted Client Brief</h2>
            <p className="text-sm text-slate-300 whitespace-pre-wrap leading-relaxed">{job.description}</p>
            <div className="pt-3 border-t border-slate-800/80 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
              <span>Skills: {job.skills.length > 0 ? job.skills.join(', ') : 'None extracted'}</span>
              <span>·</span>
              <span>Discovered: {formatShortDate(job.dateDiscovered)}</span>
              <span>·</span>
              <span>Deadline: {job.deadline || 'Not specified'}</span>
            </div>
          </div>

          {job.analysis && (
            <div className="bg-[#0B1221] border border-slate-800/90 rounded-xl p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-white">Job Analyst Assessment</h2>
                <span className="text-xs text-slate-400">Engine: {job.analysis.analyzedBy}</span>
              </div>
              <p className="text-sm text-slate-300 leading-relaxed">{job.analysis.summary}</p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-2 border-t border-slate-800/80 text-xs">
                <div>
                  <span className="text-slate-400 block">Estimated Hours</span>
                  <span className="font-mono tabular-nums text-white text-sm font-semibold">
                    {job.analysis.estimatedHours}h
                  </span>
                </div>
                <div>
                  <span className="text-slate-400 block">Difficulty</span>
                  <span className="text-slate-100 text-sm font-semibold capitalize">{job.analysis.difficulty}</span>
                </div>
                <div>
                  <span className="text-slate-400 block">Feasibility</span>
                  <span className="text-cyan-300 text-sm font-semibold capitalize">{job.analysis.feasibility}</span>
                </div>
                <div>
                  <span className="text-slate-400 block">Effective Rate</span>
                  <span className="font-mono tabular-nums text-emerald-400 text-sm font-semibold">
                    {job.analysis.expectedHourlyRate ? `${formatMoney(job.analysis.expectedHourlyRate, job.currency)}/hr` : '—'}
                  </span>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2 border-t border-slate-800/80 text-xs">
                <div>
                  <span className="text-slate-400 font-medium block mb-1">Required Deliverables</span>
                  <p className="text-slate-200">{job.analysis.requiredDeliverables.join(' · ')}</p>
                </div>
                <div>
                  <span className="text-slate-400 font-medium block mb-1">Tools Needed</span>
                  <p className="font-mono text-slate-300">{job.analysis.toolsNeeded.join(' · ')}</p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Right Column: Transparent 100-Point Score Breakdown */}
        <div className="bg-[#0B1221] border border-slate-800/90 rounded-xl p-5 space-y-4">
          <div className="flex items-baseline justify-between border-b border-slate-800/80 pb-3">
            <div>
              <h2 className="text-sm font-semibold text-white">Suitability Score</h2>
              <p className="text-xs text-slate-400">Weighted 100-point rubric</p>
            </div>
            <div className="text-right">
              <span className="text-2xl font-bold font-mono tabular-nums text-cyan-400">
                {job.jobScore ?? '—'}
              </span>
              <span className="text-xs text-slate-500 font-mono">/100</span>
            </div>
          </div>

          {!job.scoreBreakdown ? (
            <p className="text-xs text-slate-400">Click Re-Analyze to compute the transparent scoring breakdown.</p>
          ) : (
            <div className="space-y-3.5">
              {job.scoreBreakdown.map((item) => {
                const pct = Math.min(100, Math.round((item.score / Math.max(1, item.maxScore)) * 100));
                return (
                  <div key={item.criterion} className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-slate-200">{item.label}</span>
                      <span className="font-mono tabular-nums text-cyan-300">
                        {item.score}/{item.maxScore}
                      </span>
                    </div>
                    <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                      <div className="h-full bg-cyan-400 rounded-full" style={{ width: `${pct}%` }} />
                    </div>
                    <p className="text-xs text-slate-400 leading-snug">{item.reasoning}</p>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
