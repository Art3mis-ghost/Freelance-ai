import React, { useEffect, useState } from 'react';
import { Sparkles, Save, Copy, Check, Send, Play } from 'lucide-react';
import { apiRequest, formatMoney, formatShortDate } from '../api.ts';
import type { JobRecord, ProjectRecord, ProposalRecord } from '../../shared/types.ts';

interface ProposalStudioViewProps {
  initialJobId: string | null;
  onOpenProjectWorkspace: (projectId: string) => void;
  onChanged: () => void;
}

export const ProposalStudioView: React.FC<ProposalStudioViewProps> = ({
  initialJobId,
  onOpenProjectWorkspace,
  onChanged,
}) => {
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string>(initialJobId || '');
  const [proposals, setProposals] = useState<ProposalRecord[]>([]);
  const [activeProposal, setActiveProposal] = useState<ProposalRecord | null>(null);
  const [customNotes, setCustomNotes] = useState('');
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const loadJobsAndProposals = async (targetJobId?: string) => {
    const [jobsRes, propsRes] = await Promise.all([
      apiRequest<{ jobs: JobRecord[] }>('/api/jobs?includeRejected=false'),
      apiRequest<{ proposals: ProposalRecord[] }>(
        targetJobId ? `/api/proposals?jobId=${encodeURIComponent(targetJobId)}` : '/api/proposals',
      ),
    ]);
    setJobs(jobsRes.jobs);
    setProposals(propsRes.proposals);
    if (!targetJobId && jobsRes.jobs.length > 0 && !selectedJobId) {
      setSelectedJobId(jobsRes.jobs[0].id);
    }
    if (propsRes.proposals.length > 0) {
      setActiveProposal((prev) => propsRes.proposals.find((p) => p.id === prev?.id) || propsRes.proposals[0]);
    } else {
      setActiveProposal(null);
    }
  };

  useEffect(() => {
    if (initialJobId) setSelectedJobId(initialJobId);
  }, [initialJobId]);

  useEffect(() => {
    void loadJobsAndProposals(selectedJobId || undefined);
  }, [selectedJobId]);

  const handleGenerate = async () => {
    if (!selectedJobId) return;
    setGenerating(true);
    setFeedback(null);
    try {
      const res = await apiRequest<{ proposal: ProposalRecord }>('/api/proposals/generate', {
        method: 'POST',
        body: JSON.stringify({ jobId: selectedJobId, customNotes }),
      });
      setActiveProposal(res.proposal);
      await loadJobsAndProposals(selectedJobId);
      onChanged();
      setFeedback(`Generated Proposal v${res.proposal.version} via ${res.proposal.generatedBy}. Review before copying to the platform.`);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Proposal generation failed');
    } finally {
      setGenerating(false);
    }
  };

  const handleSave = async (nextStatus?: ProposalRecord['status']) => {
    if (!activeProposal) return;
    setSaving(true);
    setFeedback(null);
    try {
      const res = await apiRequest<{ proposal: ProposalRecord }>(`/api/proposals/${activeProposal.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          introduction: activeProposal.introduction,
          approach: activeProposal.approach,
          timeline: activeProposal.timeline,
          fullProposal: activeProposal.fullProposal,
          suggestedBid: activeProposal.suggestedBid ?? undefined,
          pricingExplanation: activeProposal.pricingExplanation,
          questions: activeProposal.questions,
          status: nextStatus || activeProposal.status,
        }),
      });
      setActiveProposal(res.proposal);
      await loadJobsAndProposals(selectedJobId || undefined);
      onChanged();
      setFeedback(
        nextStatus === 'submitted_manually'
          ? 'Marked as submitted manually. Proposals are never sent automatically.'
          : 'Proposal edits saved to SQLite version history.',
      );
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleCopy = async () => {
    if (!activeProposal) return;
    await navigator.clipboard.writeText(activeProposal.fullProposal);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const handleApproveContract = async () => {
    if (!activeProposal) return;
    setSaving(true);
    try {
      const res = await apiRequest<{ project: ProjectRecord }>('/api/projects/approve', {
        method: 'POST',
        body: JSON.stringify({ jobId: activeProposal.jobId, proposalId: activeProposal.id }),
      });
      onChanged();
      onOpenProjectWorkspace(res.project.id);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Approval failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-white tracking-tight">Proposal Studio</h1>
        <p className="text-sm text-slate-400 mt-1">
          Generate honest, tailored proposals with version history. Proposals are never auto-submitted to clients.
        </p>
      </div>

      {/* Generator Bar */}
      <div className="bg-[#0B1221] border border-slate-800/90 rounded-xl p-4 grid grid-cols-1 lg:grid-cols-12 gap-3 items-end">
        <div className="lg:col-span-5">
          <label className="block text-xs text-slate-400 mb-1">Target Job</label>
          <select
            value={selectedJobId}
            onChange={(e) => setSelectedJobId(e.target.value)}
            className="w-full bg-[#060A14] border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
          >
            <option value="">All Proposals (select a job to draft)</option>
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>
                [{j.jobScore ?? '—'}] {j.title.slice(0, 72)}
              </option>
            ))}
          </select>
        </div>
        <div className="lg:col-span-5">
          <label className="block text-xs text-slate-400 mb-1">Optional Operator Emphasis Notes</label>
          <input
            type="text"
            value={customNotes}
            onChange={(e) => setCustomNotes(e.target.value)}
            placeholder="e.g. Emphasize clean Excel formulas and 48-hour turnaround"
            className="w-full bg-[#060A14] border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500"
          />
        </div>
        <div className="lg:col-span-2">
          <button
            onClick={handleGenerate}
            disabled={!selectedJobId || generating}
            className="w-full inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-cyan-500 text-slate-950 hover:bg-cyan-400 disabled:opacity-40 whitespace-nowrap"
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>{generating ? 'Drafting...' : 'Generate Draft'}</span>
          </button>
        </div>
      </div>

      {feedback && (
        <div className="text-xs text-cyan-200 bg-cyan-500/10 border border-cyan-500/30 rounded-lg px-4 py-2.5">
          {feedback}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Version History Sidebar */}
        <div className="lg:col-span-4 bg-[#0B1221] border border-slate-800/90 rounded-xl p-4 space-y-2">
          <h2 className="text-sm font-semibold text-white mb-2">Proposal History ({proposals.length})</h2>
          {proposals.length === 0 ? (
            <p className="text-xs text-slate-500 py-6 text-center">
              No proposals drafted yet. Choose a job above and click Generate Draft.
            </p>
          ) : (
            <div className="divide-y divide-slate-800/70 max-h-[540px] overflow-y-auto">
              {proposals.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setActiveProposal(p)}
                  className={`w-full text-left py-3 px-2.5 rounded-lg transition-colors ${
                    activeProposal?.id === p.id ? 'bg-cyan-500/10 text-white' : 'hover:bg-slate-800/40 text-slate-300'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-mono font-semibold text-cyan-300">v{p.version}</span>
                    <span className="capitalize text-slate-400">{p.status.replace(/_/g, ' ')}</span>
                  </div>
                  <p className="text-xs font-medium text-slate-100 truncate mt-1">{p.jobTitle || p.jobId}</p>
                  <p className="text-xs text-slate-500 font-mono tabular-nums mt-0.5">
                    Bid: {formatMoney(p.suggestedBid, p.currency)} · {formatShortDate(p.updatedAt)}
                  </p>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Editor */}
        <div className="lg:col-span-8 bg-[#0B1221] border border-slate-800/90 rounded-xl p-5 space-y-4">
          {!activeProposal ? (
            <div className="py-16 text-center text-xs text-slate-400">
              Select a saved proposal or generate a new draft to edit and copy it for manual submission.
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-800/80">
                <div>
                  <h2 className="text-base font-semibold text-white">
                    {activeProposal.jobTitle || activeProposal.jobId} (v{activeProposal.version})
                  </h2>
                  <p className="text-xs text-slate-400">
                    Generated by: {activeProposal.generatedBy} · Status: {activeProposal.status.replace(/_/g, ' ')}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={handleCopy}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-700 text-slate-200 hover:border-cyan-400/50"
                  >
                    {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copied ? 'Copied' : 'Copy Text'}</span>
                  </button>
                  <button
                    onClick={() => handleSave()}
                    disabled={saving}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-800 hover:bg-slate-700 text-white"
                  >
                    <Save className="w-3.5 h-3.5" />
                    <span>Save Edits</span>
                  </button>
                  <button
                    onClick={() => handleSave('submitted_manually')}
                    disabled={saving}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-500 text-white"
                  >
                    <Send className="w-3.5 h-3.5" />
                    <span>Mark Submitted Manually</span>
                  </button>
                  <button
                    onClick={handleApproveContract}
                    disabled={saving}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-cyan-500 text-slate-950 hover:bg-cyan-400"
                  >
                    <Play className="w-3.5 h-3.5" />
                    <span>Contract Awarded → Execute</span>
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Suggested Bid ({activeProposal.currency})</label>
                  <input
                    type="number"
                    value={activeProposal.suggestedBid ?? ''}
                    onChange={(e) =>
                      setActiveProposal({
                        ...activeProposal,
                        suggestedBid: e.target.value ? Number(e.target.value) : null,
                      })
                    }
                    className="w-full bg-[#060A14] border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-white"
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-xs text-slate-400 mb-1">Pricing Explanation</label>
                  <input
                    type="text"
                    value={activeProposal.pricingExplanation}
                    onChange={(e) => setActiveProposal({ ...activeProposal, pricingExplanation: e.target.value })}
                    className="w-full bg-[#060A14] border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1">Full Editable Proposal (Copy & Paste Manually to Client)</label>
                <textarea
                  rows={12}
                  value={activeProposal.fullProposal}
                  onChange={(e) => setActiveProposal({ ...activeProposal, fullProposal: e.target.value })}
                  className="w-full bg-[#060A14] border border-slate-700 rounded-lg px-3.5 py-2.5 text-sm text-slate-100 leading-relaxed font-sans"
                />
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1">Clarifying Questions for Client</label>
                <ul className="text-xs text-slate-300 space-y-1">
                  {activeProposal.questions.map((q, idx) => (
                    <li key={idx}>• {q}</li>
                  ))}
                </ul>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
