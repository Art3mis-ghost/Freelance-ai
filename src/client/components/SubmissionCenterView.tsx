import React, { useEffect, useState } from 'react';
import { Download, Package, ExternalLink, Copy, Check, CheckCircle2, DollarSign, Save } from 'lucide-react';
import { apiRequest, buildDownloadUrl, formatBytes, formatMoney, formatShortDate, isSafeHttpUrl } from '../api.ts';
import type { DeliverableRecord, ProjectRecord, QaReportRecord } from '../../shared/types.ts';

interface SubmissionItem extends ProjectRecord {
  deliverables: DeliverableRecord[];
  latestQa: QaReportRecord | null;
}

interface SubmissionCenterViewProps {
  onChanged: () => void;
}

export const SubmissionCenterView: React.FC<SubmissionCenterViewProps> = ({ onChanged }) => {
  const [items, setItems] = useState<SubmissionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [editingMessages, setEditingMessages] = useState<Record<string, string>>({});
  const [paymentForms, setPaymentForms] = useState<
    Record<string, { open: boolean; amount: string; currency: string; platformFee: string; notes: string }>
  >({});
  const [feedback, setFeedback] = useState<string | null>(null);

  const loadSubmissions = async () => {
    setLoading(true);
    try {
      const res = await apiRequest<{ submissions: SubmissionItem[] }>('/api/submissions');
      setItems(res.submissions);
      const msgs: Record<string, string> = {};
      for (const s of res.submissions) {
        msgs[s.id] = s.submissionMessage || '';
      }
      setEditingMessages(msgs);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadSubmissions();
  }, []);

  const handleSaveMessage = async (projectId: string) => {
    await apiRequest(`/api/projects/${projectId}/submission-message`, {
      method: 'PATCH',
      body: JSON.stringify({ submissionMessage: editingMessages[projectId] || '' }),
    });
    setFeedback('Saved submission_message.md to project workspace.');
  };

  const handleCopyMessage = async (projectId: string) => {
    await navigator.clipboard.writeText(editingMessages[projectId] || '');
    setCopiedId(projectId);
    setTimeout(() => setCopiedId(null), 1800);
  };

  const handleMarkSubmitted = async (projectId: string) => {
    await apiRequest(`/api/projects/${projectId}/submit`, {
      method: 'POST',
      body: JSON.stringify({ submittedAt: new Date().toISOString() }),
    });
    setFeedback('Project marked as manually submitted.');
    await loadSubmissions();
    onChanged();
  };

  const openPaymentForm = (item: SubmissionItem) => {
    setPaymentForms((prev) => ({
      ...prev,
      [item.id]: {
        open: true,
        amount: String(item.estimatedEarnings || item.budget || ''),
        currency: item.currency || 'USD',
        platformFee: '0',
        notes: '',
      },
    }));
  };

  const handleRecordPayment = async (projectId: string, e: React.FormEvent) => {
    e.preventDefault();
    const form = paymentForms[projectId];
    if (!form) return;
    try {
      await apiRequest(`/api/projects/${projectId}/payment`, {
        method: 'POST',
        body: JSON.stringify({
          amount: Number(form.amount),
          currency: form.currency,
          platformFee: Number(form.platformFee || 0),
          notes: form.notes,
        }),
      });
      setPaymentForms((prev) => ({ ...prev, [projectId]: { ...prev[projectId], open: false } }));
      setFeedback('Actual paid earnings recorded in SQLite ledger.');
      await loadSubmissions();
      onChanged();
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Payment recording failed');
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-white tracking-tight">Submission Center</h1>
        <p className="text-sm text-slate-400 mt-1">
          Review QA-verified deliverables, download individual files or ZIP bundles, copy your submission note, and submit manually to the client.
        </p>
      </div>

      {feedback && (
        <div className="text-xs text-cyan-200 bg-cyan-500/10 border border-cyan-500/30 rounded-lg px-4 py-2.5">
          {feedback}
        </div>
      )}

      {loading ? (
        <div className="text-xs text-slate-400">Loading submission-ready projects...</div>
      ) : items.length === 0 ? (
        <div className="bg-[#0B1221] border border-slate-800 rounded-xl p-10 text-center text-xs text-slate-400">
          No completed projects are awaiting manual submission yet. Execute a project in Project Workspace first.
        </div>
      ) : (
        <div className="space-y-5">
          {items.map((item) => {
            const zipFile = item.deliverables.find((d) => d.fileType.toUpperCase() === 'ZIP');
            const otherFiles = item.deliverables.filter((d) => d.fileType.toUpperCase() !== 'ZIP');
            const payForm = paymentForms[item.id];

            return (
              <div key={item.id} className="bg-[#0B1221] border border-slate-800/90 rounded-xl p-6 space-y-5">
                <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4 pb-4 border-b border-slate-800/80">
                  <div className="space-y-1">
                    <h2 className="text-lg font-semibold text-white">{item.title}</h2>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                      <span>{item.sourceName || 'Manual'}</span>
                      <span>·</span>
                      <span className="font-mono tabular-nums text-slate-200">
                        Estimated: {formatMoney(item.estimatedEarnings || item.budget, item.currency)}
                      </span>
                      <span>·</span>
                      <span>
                        QA:{' '}
                        <span className="font-mono tabular-nums text-emerald-400 font-semibold">
                          {item.qaScore !== null ? `${item.qaScore}/100` : '—'}
                        </span>
                      </span>
                      <span>·</span>
                      <span className="capitalize text-cyan-300">{item.status.replace(/_/g, ' ')}</span>
                      <span>·</span>
                      <span>Updated {formatShortDate(item.updatedAt)}</span>
                      {isSafeHttpUrl(item.jobUrl) && (
                        <>
                          <span>·</span>
                          <a
                            href={item.jobUrl!}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-cyan-400 hover:underline"
                          >
                            <span>Open Job Link</span>
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    {zipFile && (
                      <a
                        href={buildDownloadUrl(item.id, zipFile.relativePath)}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg bg-cyan-500 text-slate-950 hover:bg-cyan-400 whitespace-nowrap"
                      >
                        <Package className="w-3.5 h-3.5" />
                        <span>Download ZIP ({formatBytes(zipFile.sizeBytes)})</span>
                      </a>
                    )}
                    {item.status !== 'submitted' && item.status !== 'paid' && (
                      <button
                        onClick={() => handleMarkSubmitted(item.id)}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-500 text-white whitespace-nowrap"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>Mark Submitted</span>
                      </button>
                    )}
                    {item.status !== 'paid' && (
                      <button
                        onClick={() => openPaymentForm(item)}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10 whitespace-nowrap"
                      >
                        <DollarSign className="w-3.5 h-3.5" />
                        <span>Record Paid</span>
                      </button>
                    )}
                  </div>
                </div>

                {/* Record Payment Inline Form */}
                {payForm?.open && (
                  <form
                    onSubmit={(e) => handleRecordPayment(item.id, e)}
                    className="bg-[#060A14] border border-emerald-500/30 rounded-lg p-4 grid grid-cols-1 md:grid-cols-5 gap-3 items-end"
                  >
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">Gross Paid Amount *</label>
                      <input
                        required
                        type="number"
                        step="0.01"
                        value={payForm.amount}
                        onChange={(e) =>
                          setPaymentForms({ ...paymentForms, [item.id]: { ...payForm, amount: e.target.value } })
                        }
                        className="w-full bg-[#0B1221] border border-slate-700 rounded px-3 py-1.5 text-sm font-mono text-white"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">Currency</label>
                      <input
                        value={payForm.currency}
                        onChange={(e) =>
                          setPaymentForms({ ...paymentForms, [item.id]: { ...payForm, currency: e.target.value } })
                        }
                        className="w-full bg-[#0B1221] border border-slate-700 rounded px-3 py-1.5 text-sm text-white"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">Platform Fees</label>
                      <input
                        type="number"
                        step="0.01"
                        value={payForm.platformFee}
                        onChange={(e) =>
                          setPaymentForms({ ...paymentForms, [item.id]: { ...payForm, platformFee: e.target.value } })
                        }
                        className="w-full bg-[#0B1221] border border-slate-700 rounded px-3 py-1.5 text-sm font-mono text-white"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">Notes</label>
                      <input
                        placeholder="Invoice / milestone ref"
                        value={payForm.notes}
                        onChange={(e) =>
                          setPaymentForms({ ...paymentForms, [item.id]: { ...payForm, notes: e.target.value } })
                        }
                        className="w-full bg-[#0B1221] border border-slate-700 rounded px-3 py-1.5 text-sm text-white"
                      />
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="submit"
                        className="flex-1 px-3 py-1.5 text-xs font-semibold rounded bg-emerald-500 text-slate-950 hover:bg-emerald-400"
                      >
                        Save Payment
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setPaymentForms({ ...paymentForms, [item.id]: { ...payForm, open: false } })
                        }
                        className="px-2.5 py-1.5 text-xs text-slate-400 hover:text-white"
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                )}

                <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
                  {/* Individual Deliverables */}
                  <div className="lg:col-span-5 space-y-2">
                    <h3 className="text-xs font-semibold text-slate-300">Verified Deliverable Files</h3>
                    <div className="divide-y divide-slate-800/70 border border-slate-800/80 rounded-lg px-3">
                      {otherFiles.map((d) => (
                        <div key={d.id} className="py-2.5 flex items-center justify-between gap-2 text-xs">
                          <div className="min-w-0">
                            <p className="font-mono text-slate-200 truncate">{d.filename}</p>
                            <p className="text-slate-500 font-mono">
                              {d.fileType} · {formatBytes(d.sizeBytes)}
                            </p>
                          </div>
                          <a
                            href={buildDownloadUrl(item.id, d.relativePath)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-100 shrink-0"
                          >
                            <Download className="w-3 h-3" />
                            <span>File</span>
                          </a>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Editable Submission Message */}
                  <div className="lg:col-span-7 space-y-2">
                    <div className="flex items-center justify-between">
                      <h3 className="text-xs font-semibold text-slate-300">Client Submission Message (Manual Handoff)</h3>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleSaveMessage(item.id)}
                          className="inline-flex items-center gap-1 text-xs text-slate-300 hover:text-white"
                        >
                          <Save className="w-3 h-3" />
                          <span>Save</span>
                        </button>
                        <button
                          onClick={() => handleCopyMessage(item.id)}
                          className="inline-flex items-center gap-1 text-xs text-cyan-400 hover:text-cyan-300"
                        >
                          {copiedId === item.id ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                          <span>{copiedId === item.id ? 'Copied' : 'Copy Message'}</span>
                        </button>
                      </div>
                    </div>
                    <textarea
                      rows={6}
                      value={editingMessages[item.id] ?? ''}
                      onChange={(e) => setEditingMessages({ ...editingMessages, [item.id]: e.target.value })}
                      className="w-full bg-[#060A14] border border-slate-800 rounded-lg px-3.5 py-2.5 text-xs text-slate-200 leading-relaxed"
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
