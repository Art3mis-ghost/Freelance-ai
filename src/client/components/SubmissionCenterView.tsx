import React, { useCallback, useEffect, useState } from 'react';
import {
  Send,
  Download,
  Copy,
  CheckCircle2,
  ExternalLink,
  DollarSign,
  PackageCheck,
  FileText,
  ShieldCheck,
  AlertTriangle,
  Search,
  RefreshCw,
} from 'lucide-react';
import { apiRequest, buildDownloadUrl, formatBytes, formatMoney, formatShortDate, isSafeHttpUrl } from '../api.ts';
import type {
  DeliveryRecord,
  DeliveryReport,
  DeliveryStatus,
  SubmissionMethod,
} from '../../shared/types.ts';

interface SubmissionCenterViewProps {
  onOpenProject: (projectId: string) => void;
  onNavigateAutomation?: () => void;
}

const STATUS_COLOR: Record<DeliveryStatus, string> = {
  not_ready: 'text-slate-400',
  preparing: 'text-cyan-400',
  qa_pending: 'text-amber-400',
  ready_for_delivery: 'text-emerald-400',
  awaiting_approval: 'text-amber-400',
  delivery_in_progress: 'text-cyan-400',
  submitted: 'text-emerald-400',
  submission_unverified: 'text-amber-300',
  delivered: 'text-emerald-300',
  failed: 'text-rose-400',
  needs_manual_action: 'text-amber-400',
};

export const SubmissionCenterView: React.FC<SubmissionCenterViewProps> = ({
  onOpenProject,
  onNavigateAutomation,
}) => {
  const [deliveries, setDeliveries] = useState<DeliveryRecord[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [report, setReport] = useState<DeliveryReport | null>(null);
  const [reportMarkdown, setReportMarkdown] = useState<string>('');
  const [showReport, setShowReport] = useState(false);

  const [messageDraft, setMessageDraft] = useState('');
  const [methodDraft, setMethodDraft] = useState<SubmissionMethod>('manual_upload');
  const [externalRef, setExternalRef] = useState('');
  const [confirmationNote, setConfirmationNote] = useState('');

  const [paymentForm, setPaymentForm] = useState({ amount: '', currency: 'USD', platformFee: '0', notes: '' });
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const loadDeliveries = useCallback(async () => {
    setBusy(true);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set('search', search.trim());
      if (statusFilter !== 'all') params.set('status', statusFilter);
      const res = await apiRequest<{ deliveries: DeliveryRecord[] }>(`/api/deliveries?${params.toString()}`);
      setDeliveries(res.deliveries);
      setSelectedProjectId((prev) => prev || res.deliveries[0]?.projectId || null);
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Failed to load deliveries' });
    } finally {
      setBusy(false);
    }
  }, [search, statusFilter]);

  useEffect(() => {
    void loadDeliveries();
  }, [loadDeliveries]);

  const selected = deliveries.find((d) => d.projectId === selectedProjectId) || deliveries[0] || null;

  useEffect(() => {
    if (!selected) return;
    setMessageDraft(selected.submissionMessage || '');
    setMethodDraft(selected.submissionMethod);
    setExternalRef(selected.externalReference || '');
    setConfirmationNote(selected.confirmationNote || '');
    setShowReport(false);
    setReport(null);
  }, [selected?.projectId]);

  const handlePreparePackage = async () => {
    if (!selected) return;
    setBusy(true);
    setFeedback(null);
    try {
      const res = await apiRequest<{ delivery: DeliveryRecord }>(`/api/deliveries/${selected.projectId}/prepare`, {
        method: 'POST',
        body: JSON.stringify({
          submissionMethod: methodDraft,
          submissionMessage: messageDraft.trim() || undefined,
        }),
      });
      setDeliveries((prev) => prev.map((d) => (d.projectId === selected.projectId ? res.delivery : d)));
      setFeedback({
        type: 'ok',
        text: `Delivery package prepared (${res.delivery.manifest?.totalFiles || 0} client file(s), internal logs excluded). Status: ${res.delivery.status.replace(/_/g, ' ')}.`,
      });
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Package preparation failed' });
    } finally {
      setBusy(false);
    }
  };

  const handleSaveMessage = async () => {
    if (!selected || !messageDraft.trim()) return;
    setBusy(true);
    setFeedback(null);
    try {
      const res = await apiRequest<{ delivery: DeliveryRecord }>(`/api/deliveries/${selected.projectId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          submissionMessage: messageDraft,
          submissionMethod: methodDraft,
          externalReference: externalRef.trim() || null,
          confirmationNote: confirmationNote.trim() || null,
        }),
      });
      setDeliveries((prev) => prev.map((d) => (d.projectId === selected.projectId ? res.delivery : d)));
      setFeedback({ type: 'ok', text: 'Saved delivery notes and submission message.' });
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Save failed' });
    } finally {
      setBusy(false);
    }
  };

  const handleSubmitDelivery = async (markDelivered = false) => {
    if (!selected) return;
    setBusy(true);
    setFeedback(null);
    try {
      const res = await apiRequest<{ ok: boolean; message: string; delivery: DeliveryRecord }>(
        `/api/deliveries/${selected.projectId}/submit`,
        {
          method: 'POST',
          body: JSON.stringify({
            submissionMethod: methodDraft,
            externalReference: externalRef.trim() || undefined,
            confirmationNote: confirmationNote.trim() || undefined,
            confirmedManualUpload: true,
            markDelivered,
          }),
        },
      );
      setDeliveries((prev) => prev.map((d) => (d.projectId === selected.projectId ? res.delivery : d)));
      setFeedback({ type: res.ok ? 'ok' : 'err', text: res.message });
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Delivery submission failed' });
    } finally {
      setBusy(false);
    }
  };

  const handleLoadReport = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const res = await apiRequest<{ report: DeliveryReport; markdown: string }>(
        `/api/deliveries/${selected.projectId}/report`,
      );
      setReport(res.report);
      setReportMarkdown(res.markdown);
      setShowReport(true);
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Failed to load delivery report' });
    } finally {
      setBusy(false);
    }
  };

  const handleExportReport = async (format: 'markdown' | 'json') => {
    if (!selected) return;
    try {
      const res = await apiRequest<{ report: DeliveryReport; markdown: string }>(
        `/api/deliveries/${selected.projectId}/report`,
      );
      const content = format === 'json' ? JSON.stringify(res.report, null, 2) : res.markdown;
      const mime = format === 'json' ? 'application/json' : 'text/markdown';
      const ext = format === 'json' ? 'json' : 'md';
      const blob = new Blob([content], { type: `${mime};charset=utf-8` });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `delivery_report_${selected.projectId}.${ext}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Export failed' });
    }
  };

  const handleRecordPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    const amt = Number(paymentForm.amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setFeedback({ type: 'err', text: 'Enter a valid positive payment amount.' });
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      await apiRequest(`/api/projects/${selected.projectId}/payment`, {
        method: 'POST',
        body: JSON.stringify({
          amount: amt,
          currency: paymentForm.currency,
          platformFee: Number(paymentForm.platformFee || 0),
          notes: paymentForm.notes.trim() || undefined,
        }),
      });
      await apiRequest(`/api/deliveries/${selected.projectId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'delivered' }),
      });
      setPaymentForm({ amount: '', currency: 'USD', platformFee: '0', notes: '' });
      setFeedback({ type: 'ok', text: `Recorded payment of ${formatMoney(amt, paymentForm.currency)} and marked delivered.` });
      await loadDeliveries();
    } catch (err) {
      setFeedback({ type: 'err', text: err instanceof Error ? err.message : 'Payment recording failed' });
    } finally {
      setBusy(false);
    }
  };

  const copyMessage = async () => {
    if (!messageDraft.trim()) return;
    try {
      await navigator.clipboard.writeText(messageDraft);
      setFeedback({ type: 'ok', text: 'Submission message copied to clipboard.' });
    } catch {
      setFeedback({ type: 'err', text: 'Clipboard write blocked by browser.' });
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800/80 pb-4">
        <div>
          <h2 className="text-lg font-semibold text-white">Delivery Center & Submission Reports</h2>
          <p className="text-sm text-slate-400 mt-0.5">
            Build clean client packages, verify QA & secrets hygiene, enforce human approval gates, and export delivery reports.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search deliveries..."
              className="bg-slate-950 border border-slate-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-white w-48"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200"
          >
            <option value="all">All Statuses</option>
            <option value="ready_for_delivery">Ready for Delivery</option>
            <option value="awaiting_approval">Awaiting Approval</option>
            <option value="qa_pending">QA Pending</option>
            <option value="needs_manual_action">Needs Manual Action</option>
            <option value="submitted">Submitted</option>
            <option value="delivered">Delivered</option>
          </select>
          <button
            onClick={() => void loadDeliveries()}
            className="p-2 text-slate-400 hover:text-white bg-slate-900 border border-slate-800 rounded-lg"
            title="Refresh deliveries"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {feedback && (
        <div
          className={`px-4 py-3 rounded-lg border text-sm flex items-center gap-2 ${
            feedback.type === 'ok'
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
              : 'bg-rose-500/10 border-rose-500/30 text-rose-300'
          }`}
        >
          {feedback.type === 'ok' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertTriangle className="w-4 h-4 shrink-0" />}
          <span>{feedback.text}</span>
        </div>
      )}

      {deliveries.length === 0 ? (
        <div className="bg-[#0B1221] border border-slate-800/80 rounded-xl p-10 text-center text-sm text-slate-400">
          No delivery records yet. Approve a job into a project and run execution + QA to prepare deliverables here.
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
          {/* Delivery Queue List */}
          <div className="xl:col-span-4 bg-[#0B1221] border border-slate-800/80 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-800/80 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Delivery Queue
              </span>
              <span className="text-xs text-slate-500 tabular-nums">{deliveries.length} projects</span>
            </div>
            <div className="divide-y divide-slate-800/60 max-h-[680px] overflow-y-auto">
              {deliveries.map((d) => {
                const active = selected?.projectId === d.projectId;
                return (
                  <button
                    key={d.id}
                    onClick={() => setSelectedProjectId(d.projectId)}
                    className={`w-full text-left px-4 py-3.5 transition-colors ${
                      active ? 'bg-cyan-500/10' : 'hover:bg-slate-900/60'
                    }`}
                  >
                    <div className="text-sm font-medium text-white truncate">{d.projectTitle}</div>
                    <div className="flex items-center justify-between text-xs mt-1">
                      <span className="text-slate-400">{d.platformName}</span>
                      <span className={`font-medium ${STATUS_COLOR[d.status]}`}>
                        {d.status.replace(/_/g, ' ')}
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-500 mt-1 tabular-nums">
                      Updated {formatShortDate(d.updatedAt)}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Delivery Detail Workspace */}
          {selected && (
            <div className="xl:col-span-8 space-y-5">
              {/* Top Action & Status Card */}
              <div className="bg-[#0B1221] border border-slate-800/80 rounded-xl p-5 space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-800/80 pb-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-base font-semibold text-white">{selected.projectTitle}</h3>
                      <span className={`text-xs font-medium ${STATUS_COLOR[selected.status]}`}>
                        · {selected.status.replace(/_/g, ' ')}
                      </span>
                    </div>
                    <div className="text-xs text-slate-400 mt-1 flex flex-wrap items-center gap-3">
                      <span>Platform: {selected.platformName}</span>
                      <span>Approval: {selected.approvalStatus || 'pending check'}</span>
                      {selected.submittedAt && (
                        <span className="tabular-nums">Submitted: {formatShortDate(selected.submittedAt)}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      onClick={() => onOpenProject(selected.projectId)}
                      className="px-3 py-1.5 text-xs font-medium text-slate-300 bg-slate-900 hover:bg-slate-800 border border-slate-700 rounded-lg whitespace-nowrap"
                    >
                      Open Workspace
                    </button>
                    {isSafeHttpUrl(selected.jobUrl) && (
                      <a
                        href={selected.jobUrl!}
                        target="_blank"
                        rel="noreferrer"
                        className="px-3 py-1.5 text-xs font-medium text-cyan-300 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 rounded-lg flex items-center gap-1 whitespace-nowrap"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                        Client Listing
                      </a>
                    )}
                    <button
                      onClick={() => void handleLoadReport()}
                      className="px-3 py-1.5 text-xs font-medium text-slate-200 bg-slate-900 hover:bg-slate-800 border border-slate-700 rounded-lg flex items-center gap-1 whitespace-nowrap"
                    >
                      <FileText className="w-3.5 h-3.5" />
                      Delivery Report
                    </button>
                  </div>
                </div>

                {selected.status === 'awaiting_approval' && onNavigateAutomation && (
                  <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-4 py-3 flex items-center justify-between gap-3 text-xs text-amber-200">
                    <span>Final delivery requires explicit operator approval before submission.</span>
                    <button
                      onClick={onNavigateAutomation}
                      className="px-3 py-1.5 bg-amber-500/20 hover:bg-amber-500/30 text-amber-100 rounded-md font-medium whitespace-nowrap"
                    >
                      Review in Approval Queue
                    </button>
                  </div>
                )}

                {selected.lastError && (
                  <div className="bg-rose-500/10 border border-rose-500/30 rounded-lg px-4 py-2.5 text-xs text-rose-300">
                    {selected.lastError}
                  </div>
                )}

                {/* Package Manifest & Preparation */}
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                      Clean Delivery Package & Manifest
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => void handlePreparePackage()}
                        disabled={busy}
                        className="px-3 py-1.5 text-xs font-medium bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg flex items-center gap-1.5 whitespace-nowrap"
                      >
                        <PackageCheck className="w-3.5 h-3.5" />
                        Prepare & Verify Package
                      </button>
                      {selected.packageZipPath && (
                        <a
                          href={buildDownloadUrl(selected.projectId, selected.packageZipPath)}
                          className="px-3 py-1.5 text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg flex items-center gap-1.5 whitespace-nowrap"
                        >
                          <Download className="w-3.5 h-3.5" />
                          Download ZIP
                        </a>
                      )}
                    </div>
                  </div>

                  {selected.manifest ? (
                    <div className="bg-slate-950/70 border border-slate-800/70 rounded-lg p-3.5 space-y-2.5 text-xs">
                      <div className="flex flex-wrap items-center gap-4 text-slate-300 tabular-nums">
                        <span>Client Files: {selected.manifest.totalFiles}</span>
                        <span>Size: {formatBytes(selected.manifest.totalBytes)}</span>
                        <span>QA Score: {selected.manifest.qaScore !== null ? `${selected.manifest.qaScore}/100` : 'Pending'}</span>
                        <span className={selected.manifest.secretsScanPassed ? 'text-emerald-400' : 'text-rose-400'}>
                          <ShieldCheck className="w-3.5 h-3.5 inline mr-1" />
                          {selected.manifest.secretsScanPassed ? 'Secrets Scan Passed · Internal Logs Excluded' : 'Secrets Warning'}
                        </span>
                      </div>
                      {selected.manifest.includedFiles.length > 0 && (
                        <div className="divide-y divide-slate-800/60">
                          {selected.manifest.includedFiles.map((f) => (
                            <div key={f.relativePath} className="py-1.5 flex items-center justify-between gap-2">
                              <span className="text-slate-200 font-mono text-[11px] truncate">{f.relativePath}</span>
                              <div className="flex items-center gap-3 shrink-0">
                                <span className="text-slate-500 tabular-nums">{formatBytes(f.sizeBytes)}</span>
                                <a
                                  href={buildDownloadUrl(selected.projectId, f.relativePath)}
                                  className="text-cyan-400 hover:text-cyan-300"
                                >
                                  Download
                                </a>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                      {selected.manifest.excludedInternalFiles.length > 0 && (
                        <div className="text-[11px] text-slate-500 pt-1">
                          Excluded internal files ({selected.manifest.excludedInternalFiles.length}):{' '}
                          {selected.manifest.excludedInternalFiles.slice(0, 6).join(', ')}
                        </div>
                      )}
                    </div>
                  ) : (
                    <p className="text-xs text-slate-500">
                      Click "Prepare & Verify Package" to scan deliverables, exclude internal AI logs, build the verified ZIP bundle, and run approval checks.
                    </p>
                  )}
                </div>

                {/* Submission Adapter & Message */}
                <div className="space-y-3 pt-2 border-t border-slate-800/80">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs text-slate-400 block mb-1">Submission Adapter</label>
                      <select
                        value={methodDraft}
                        onChange={(e) => setMethodDraft(e.target.value as SubmissionMethod)}
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white"
                      >
                        <option value="manual_upload">Guided Manual Upload (Recommended)</option>
                        <option value="guided_browser_workflow">Guided Browser Handoff (User Completes)</option>
                        <option value="official_api">Official Platform API (If Permitted)</option>
                        <option value="authorized_upload">Authorized Upload Endpoint (If Permitted)</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-xs text-slate-400 block mb-1">
                        Platform Confirmation ID / Reference
                      </label>
                      <input
                        value={externalRef}
                        onChange={(e) => setExternalRef(e.target.value)}
                        placeholder="e.g. Order #FO318A29 or Ticket ID"
                        className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white"
                      />
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs text-slate-400">Client Delivery Message</label>
                      <button
                        type="button"
                        onClick={() => void copyMessage()}
                        className="text-xs text-cyan-400 hover:text-cyan-300 flex items-center gap-1"
                      >
                        <Copy className="w-3 h-3" />
                        Copy Message
                      </button>
                    </div>
                    <textarea
                      rows={5}
                      value={messageDraft}
                      onChange={(e) => setMessageDraft(e.target.value)}
                      placeholder="Write a clear, concise summary of deliverables and next steps for the client..."
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-100 leading-relaxed"
                    />
                  </div>

                  <div>
                    <label className="text-xs text-slate-400 block mb-1">Operator Confirmation Note</label>
                    <input
                      value={confirmationNote}
                      onChange={(e) => setConfirmationNote(e.target.value)}
                      placeholder="e.g. Uploaded ZIP via Upwork milestone #2 and verified receipt"
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white"
                    />
                  </div>

                  <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                    <button
                      onClick={() => void handleSaveMessage()}
                      disabled={busy}
                      className="px-3 py-2 text-xs font-medium text-slate-200 bg-slate-900 hover:bg-slate-800 border border-slate-700 rounded-lg"
                    >
                      Save Draft
                    </button>
                    <button
                      onClick={() => void handleSubmitDelivery(false)}
                      disabled={busy}
                      className="px-4 py-2 text-xs font-medium bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg flex items-center gap-1.5"
                    >
                      <Send className="w-3.5 h-3.5" />
                      Submit / Record Submission
                    </button>
                    <button
                      onClick={() => void handleSubmitDelivery(true)}
                      disabled={busy}
                      className="px-4 py-2 text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg flex items-center gap-1.5"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Confirm Delivered
                    </button>
                  </div>
                </div>
              </div>

              {/* Delivery Report Viewer & Export */}
              {showReport && report && (
                <div className="bg-[#0B1221] border border-slate-800/80 rounded-xl p-5 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/80 pb-3">
                    <div>
                      <h4 className="text-sm font-semibold text-white">Delivery Report</h4>
                      <p className="text-xs text-slate-400">
                        Generated {formatShortDate(report.generatedAt)} · Delivery ID {report.deliveryId}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => void handleExportReport('markdown')}
                        className="px-3 py-1.5 text-xs font-medium text-cyan-300 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 rounded-lg"
                      >
                        Export Markdown
                      </button>
                      <button
                        onClick={() => void handleExportReport('json')}
                        className="px-3 py-1.5 text-xs font-medium text-slate-200 bg-slate-900 hover:bg-slate-800 border border-slate-700 rounded-lg"
                      >
                        Export JSON
                      </button>
                    </div>
                  </div>
                  <pre className="bg-slate-950 border border-slate-800/70 rounded-lg p-4 text-xs text-slate-300 overflow-x-auto whitespace-pre-wrap font-mono">
                    {reportMarkdown}
                  </pre>
                </div>
              )}

              {/* Record Actual Payment */}
              <form
                onSubmit={handleRecordPayment}
                className="bg-[#0B1221] border border-slate-800/80 rounded-xl p-5 space-y-3"
              >
                <div className="flex items-center gap-2">
                  <DollarSign className="w-4 h-4 text-emerald-400" />
                  <h4 className="text-sm font-semibold text-white">Record Verified Client Payment</h4>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={paymentForm.amount}
                    onChange={(e) => setPaymentForm({ ...paymentForm, amount: e.target.value })}
                    placeholder="Gross amount"
                    className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white tabular-nums"
                  />
                  <select
                    value={paymentForm.currency}
                    onChange={(e) => setPaymentForm({ ...paymentForm, currency: e.target.value })}
                    className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white"
                  >
                    <option value="USD">USD</option>
                    <option value="EUR">EUR</option>
                    <option value="GBP">GBP</option>
                  </select>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={paymentForm.platformFee}
                    onChange={(e) => setPaymentForm({ ...paymentForm, platformFee: e.target.value })}
                    placeholder="Platform fee"
                    className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white tabular-nums"
                  />
                  <input
                    value={paymentForm.notes}
                    onChange={(e) => setPaymentForm({ ...paymentForm, notes: e.target.value })}
                    placeholder="Invoice / payout note"
                    className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white"
                  />
                </div>
                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={busy}
                    className="px-4 py-2 text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg"
                  >
                    Record Payment
                  </button>
                </div>
              </form>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
