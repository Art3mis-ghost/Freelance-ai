import React, { useEffect, useState } from 'react';
import { Search, Plus, Upload, Globe, FileText, Sparkles, RotateCcw } from 'lucide-react';
import { apiRequest, formatMoney, formatShortDate } from '../api.ts';
import type { JobRecord, JobSourceRecord } from '../../shared/types.ts';

interface JobDiscoveryViewProps {
  onSelectJob: (jobId: string) => void;
  onJobsChanged: () => void;
}

export const JobDiscoveryView: React.FC<JobDiscoveryViewProps> = ({ onSelectJob, onJobsChanged }) => {
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [sources, setSources] = useState<JobSourceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [showRejected, setShowRejected] = useState(true);

  // Live Discovery Search state
  const [discoveryKeyword, setDiscoveryKeyword] = useState('');
  const [selectedSourceId, setSelectedSourceId] = useState('');
  const [searchingSources, setSearchingSources] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'info' | 'error'; text: string } | null>(null);

  // Import panel tabs
  const [importTab, setImportTab] = useState<'none' | 'manual' | 'url' | 'csv' | 'json'>('none');
  const [manualForm, setManualForm] = useState({
    title: '',
    sourceName: 'Upwork',
    jobUrl: '',
    budget: '',
    currency: 'USD',
    paymentType: 'fixed' as 'fixed' | 'hourly' | 'unknown',
    deadline: '',
    skills: '',
    description: '',
  });
  const [urlInput, setUrlInput] = useState('');
  const [urlPlatform, setUrlPlatform] = useState('Manual URL');
  const [csvText, setCsvText] = useState(
    'title,description,budget,currency,platform,skills\n"Excel Sales Dashboard Cleanup","Deduplicate 1500 rows, build summary formulas in XLSX and export clean CSV.",280,USD,Upwork,"Excel;Data Cleaning"',
  );
  const [jsonText, setJsonText] = useState(
    JSON.stringify(
      [
        {
          title: 'Python CSV Data Normalization Script',
          description: 'Write a clean Python or Node script to normalize vendor CSV files and output a PDF summary report.',
          budget: 320,
          currency: 'USD',
          sourceName: 'Freelancer.com',
          skills: ['Python', 'Data Cleaning', 'Automation'],
        },
      ],
      null,
      2,
    ),
  );
  const [busyAction, setBusyAction] = useState(false);

  const loadData = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (searchQuery.trim()) params.set('q', searchQuery.trim());
      params.set('includeRejected', String(showRejected));
      const [jobsRes, srcRes] = await Promise.all([
        apiRequest<{ jobs: JobRecord[] }>(`/api/jobs?${params.toString()}`),
        apiRequest<{ sources: JobSourceRecord[] }>('/api/sources'),
      ]);
      setJobs(jobsRes.jobs);
      setSources(srcRes.sources);
    } catch (err) {
      setFeedback({ type: 'error', text: err instanceof Error ? err.message : 'Failed to load jobs' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, [statusFilter, showRejected]);

  const handleRunDiscovery = async (e: React.FormEvent) => {
    e.preventDefault();
    setSearchingSources(true);
    setFeedback(null);
    try {
      const res = await apiRequest<{
        results: Array<{ sourceId: string; jobsFound: number; jobsImported: number; duplicatesSkipped: number; error?: string }>;
      }>('/api/jobs/search', {
        method: 'POST',
        body: JSON.stringify({
          sourceId: selectedSourceId || undefined,
          query: discoveryKeyword,
          limit: 15,
        }),
      });
      const totalImported = res.results.reduce((s, r) => s + r.jobsImported, 0);
      const totalDupes = res.results.reduce((s, r) => s + r.duplicatesSkipped, 0);
      const errs = res.results.filter((r) => r.error).map((r) => r.error);
      setFeedback({
        type: errs.length > 0 && totalImported === 0 ? 'error' : 'info',
        text:
          errs.length > 0 && totalImported === 0
            ? errs.join(' | ')
            : `Discovery finished: ${totalImported} new job(s) imported, ${totalDupes} duplicate(s) skipped.`,
      });
      await loadData();
      onJobsChanged();
    } catch (err) {
      setFeedback({ type: 'error', text: err instanceof Error ? err.message : 'Discovery search failed' });
    } finally {
      setSearchingSources(false);
    }
  };

  const handleManualImport = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusyAction(true);
    setFeedback(null);
    try {
      const res = await apiRequest<{ imported: boolean; duplicate: boolean; job: JobRecord }>('/api/jobs/import/manual', {
        method: 'POST',
        body: JSON.stringify({
          title: manualForm.title,
          description: manualForm.description,
          sourceName: manualForm.sourceName,
          jobUrl: manualForm.jobUrl || '',
          budget: manualForm.budget ? Number(manualForm.budget) : null,
          currency: manualForm.currency,
          paymentType: manualForm.paymentType,
          deadline: manualForm.deadline || null,
          skills: manualForm.skills
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          autoAnalyze: true,
        }),
      });
      setFeedback({
        type: 'info',
        text: res.duplicate
          ? 'Duplicate listing detected — existing job preserved.'
          : `Imported & analyzed "${res.job.title}" (Score: ${res.job.jobScore ?? '—'}/100, Status: ${res.job.status}).`,
      });
      setManualForm({ ...manualForm, title: '', jobUrl: '', budget: '', skills: '', description: '' });
      setImportTab('none');
      await loadData();
      onJobsChanged();
    } catch (err) {
      setFeedback({ type: 'error', text: err instanceof Error ? err.message : 'Manual import failed' });
    } finally {
      setBusyAction(false);
    }
  };

  const handleUrlImport = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusyAction(true);
    setFeedback(null);
    try {
      const res = await apiRequest<{ imported: boolean; duplicate: boolean; warning?: string; job: JobRecord }>(
        '/api/jobs/import/url',
        {
          method: 'POST',
          body: JSON.stringify({ url: urlInput, platformLabel: urlPlatform, autoAnalyze: true }),
        },
      );
      setFeedback({
        type: 'info',
        text: res.warning || (res.duplicate ? 'Duplicate URL already stored.' : `Imported "${res.job.title}".`),
      });
      setUrlInput('');
      setImportTab('none');
      await loadData();
      onJobsChanged();
    } catch (err) {
      setFeedback({ type: 'error', text: err instanceof Error ? err.message : 'URL import failed' });
    } finally {
      setBusyAction(false);
    }
  };

  const handleCsvImport = async () => {
    setBusyAction(true);
    setFeedback(null);
    try {
      const res = await apiRequest<{ imported: number; duplicates: number; totalParsed: number }>(
        '/api/jobs/import/csv',
        {
          method: 'POST',
          body: JSON.stringify({ csv: csvText, autoAnalyze: true }),
        },
      );
      setFeedback({
        type: 'info',
        text: `CSV parsed ${res.totalParsed} row(s): ${res.imported} imported, ${res.duplicates} duplicate(s) skipped.`,
      });
      setImportTab('none');
      await loadData();
      onJobsChanged();
    } catch (err) {
      setFeedback({ type: 'error', text: err instanceof Error ? err.message : 'CSV import failed' });
    } finally {
      setBusyAction(false);
    }
  };

  const handleJsonImport = async () => {
    setBusyAction(true);
    setFeedback(null);
    try {
      const parsed = JSON.parse(jsonText);
      const jobsArray = Array.isArray(parsed) ? parsed : parsed.jobs;
      const res = await apiRequest<{ imported: number; duplicates: number; totalParsed: number }>(
        '/api/jobs/import/json',
        {
          method: 'POST',
          body: JSON.stringify({ jobs: jobsArray, autoAnalyze: true }),
        },
      );
      setFeedback({
        type: 'info',
        text: `JSON parsed ${res.totalParsed} listing(s): ${res.imported} imported, ${res.duplicates} duplicate(s) skipped.`,
      });
      setImportTab('none');
      await loadData();
      onJobsChanged();
    } catch (err) {
      setFeedback({ type: 'error', text: err instanceof Error ? err.message : 'Invalid JSON format' });
    } finally {
      setBusyAction(false);
    }
  };

  const handleAnalyze = async (jobId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setBusyAction(true);
    try {
      await apiRequest(`/api/jobs/${jobId}/analyze`, { method: 'POST', body: JSON.stringify({ useAi: true }) });
      await loadData();
      onJobsChanged();
    } catch (err) {
      setFeedback({ type: 'error', text: err instanceof Error ? err.message : 'Analysis failed' });
    } finally {
      setBusyAction(false);
    }
  };

  const handleOverride = async (jobId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setBusyAction(true);
    try {
      await apiRequest(`/api/jobs/${jobId}/override-rejection`, { method: 'POST' });
      await loadData();
      onJobsChanged();
    } catch (err) {
      setFeedback({ type: 'error', text: err instanceof Error ? err.message : 'Override failed' });
    } finally {
      setBusyAction(false);
    }
  };

  const searchableSources = sources.filter((s) => s.implementationStatus === 'functional' && s.connectorType === 'public_api');

  return (
    <div className="space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-white tracking-tight">Job Discovery</h1>
          <p className="text-sm text-slate-400 mt-1">
            Search permitted public job APIs or import freelance briefs manually. Graphic design jobs are excluded by default.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setImportTab(importTab === 'manual' ? 'none' : 'manual')}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg bg-cyan-500 text-slate-950 hover:bg-cyan-400 transition-colors whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Manual Brief</span>
          </button>
          <button
            onClick={() => setImportTab(importTab === 'url' ? 'none' : 'url')}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-[#0B1221] border border-slate-700 text-slate-200 hover:border-cyan-400/50 transition-colors whitespace-nowrap"
          >
            <Globe className="w-3.5 h-3.5" />
            <span>Import URL</span>
          </button>
          <button
            onClick={() => setImportTab(importTab === 'csv' ? 'none' : 'csv')}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-[#0B1221] border border-slate-700 text-slate-200 hover:border-cyan-400/50 transition-colors whitespace-nowrap"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>CSV Import</span>
          </button>
          <button
            onClick={() => setImportTab(importTab === 'json' ? 'none' : 'json')}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-[#0B1221] border border-slate-700 text-slate-200 hover:border-cyan-400/50 transition-colors whitespace-nowrap"
          >
            <FileText className="w-3.5 h-3.5" />
            <span>JSON Import</span>
          </button>
        </div>
      </div>

      {/* Live Public Feed Discovery Bar */}
      <form
        onSubmit={handleRunDiscovery}
        className="bg-[#0B1221] border border-slate-800/90 rounded-xl p-4 flex flex-col md:flex-row items-stretch md:items-center gap-3"
      >
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={discoveryKeyword}
            onChange={(e) => setDiscoveryKeyword(e.target.value)}
            placeholder="Keyword for permitted public APIs (e.g. python, excel, technical writer, automation)"
            className="w-full bg-[#060A14] border border-slate-700/80 rounded-lg pl-10 pr-3.5 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-cyan-400"
          />
        </div>
        <select
          value={selectedSourceId}
          onChange={(e) => setSelectedSourceId(e.target.value)}
          className="bg-[#060A14] border border-slate-700/80 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-cyan-400"
        >
          <option value="">All Enabled Permitted APIs</option>
          {searchableSources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={searchingSources}
          className="px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white transition-colors whitespace-nowrap"
        >
          {searchingSources ? 'Searching Live Feeds...' : 'Run Job Scout Search'}
        </button>
      </form>

      {feedback && (
        <div
          className={`text-xs rounded-lg px-4 py-3 border ${
            feedback.type === 'error'
              ? 'bg-rose-500/10 border-rose-500/30 text-rose-200'
              : 'bg-cyan-500/10 border-cyan-500/30 text-cyan-100'
          }`}
        >
          {feedback.text}
        </div>
      )}

      {/* Import Panels */}
      {importTab === 'manual' && (
        <form onSubmit={handleManualImport} className="bg-[#0B1221] border border-cyan-500/30 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white">Manual Job Brief Import</h2>
            <button type="button" onClick={() => setImportTab('none')} className="text-xs text-slate-400 hover:text-white">
              Close
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <input
              required
              placeholder="Job title *"
              value={manualForm.title}
              onChange={(e) => setManualForm({ ...manualForm, title: e.target.value })}
              className="md:col-span-2 bg-[#060A14] border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
            />
            <input
              placeholder="Platform (e.g. Upwork, Fiverr)"
              value={manualForm.sourceName}
              onChange={(e) => setManualForm({ ...manualForm, sourceName: e.target.value })}
              className="bg-[#060A14] border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
            />
            <input
              type="url"
              placeholder="Original Job URL (optional)"
              value={manualForm.jobUrl}
              onChange={(e) => setManualForm({ ...manualForm, jobUrl: e.target.value })}
              className="bg-[#060A14] border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
            />
            <div className="flex gap-2">
              <input
                type="number"
                placeholder="Budget"
                value={manualForm.budget}
                onChange={(e) => setManualForm({ ...manualForm, budget: e.target.value })}
                className="w-full bg-[#060A14] border border-slate-700 rounded-lg px-3 py-2 text-sm text-white font-mono"
              />
              <select
                value={manualForm.paymentType}
                onChange={(e) => setManualForm({ ...manualForm, paymentType: e.target.value as 'fixed' | 'hourly' | 'unknown' })}
                className="bg-[#060A14] border border-slate-700 rounded-lg px-2.5 py-2 text-sm text-slate-200"
              >
                <option value="fixed">Fixed</option>
                <option value="hourly">Hourly</option>
                <option value="unknown">Unknown</option>
              </select>
            </div>
            <input
              placeholder="Skills (comma-separated)"
              value={manualForm.skills}
              onChange={(e) => setManualForm({ ...manualForm, skills: e.target.value })}
              className="bg-[#060A14] border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
            />
          </div>
          <textarea
            required
            rows={4}
            placeholder="Paste full job description & client deliverables *"
            value={manualForm.description}
            onChange={(e) => setManualForm({ ...manualForm, description: e.target.value })}
            className="w-full bg-[#060A14] border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
          />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setImportTab('none')} className="px-4 py-2 text-xs text-slate-400 hover:text-white">
              Cancel
            </button>
            <button
              type="submit"
              disabled={busyAction}
              className="px-4 py-2 text-xs font-semibold rounded-lg bg-cyan-500 text-slate-950 hover:bg-cyan-400 disabled:opacity-50"
            >
              {busyAction ? 'Importing...' : 'Import & Analyze'}
            </button>
          </div>
        </form>
      )}

      {importTab === 'url' && (
        <form onSubmit={handleUrlImport} className="bg-[#0B1221] border border-cyan-500/30 rounded-xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white">Import Job by Public URL</h2>
            <button type="button" onClick={() => setImportTab('none')} className="text-xs text-slate-400 hover:text-white">
              Close
            </button>
          </div>
          <div className="flex flex-col md:flex-row gap-3">
            <input
              required
              type="url"
              placeholder="https://example.com/jobs/..."
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              className="flex-1 bg-[#060A14] border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
            />
            <input
              placeholder="Platform label"
              value={urlPlatform}
              onChange={(e) => setUrlPlatform(e.target.value)}
              className="md:w-48 bg-[#060A14] border border-slate-700 rounded-lg px-3 py-2 text-sm text-white"
            />
            <button
              type="submit"
              disabled={busyAction}
              className="px-4 py-2 text-xs font-semibold rounded-lg bg-cyan-500 text-slate-950 hover:bg-cyan-400 whitespace-nowrap"
            >
              Import URL
            </button>
          </div>
        </form>
      )}

      {importTab === 'csv' && (
        <div className="bg-[#0B1221] border border-cyan-500/30 rounded-xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white">Bulk CSV Import</h2>
            <button onClick={() => setImportTab('none')} className="text-xs text-slate-400 hover:text-white">
              Close
            </button>
          </div>
          <textarea
            rows={5}
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
            className="w-full bg-[#060A14] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-200"
          />
          <div className="flex justify-end">
            <button
              onClick={handleCsvImport}
              disabled={busyAction}
              className="px-4 py-2 text-xs font-semibold rounded-lg bg-cyan-500 text-slate-950 hover:bg-cyan-400"
            >
              Import CSV Rows
            </button>
          </div>
        </div>
      )}

      {importTab === 'json' && (
        <div className="bg-[#0B1221] border border-cyan-500/30 rounded-xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white">Bulk JSON Import</h2>
            <button onClick={() => setImportTab('none')} className="text-xs text-slate-400 hover:text-white">
              Close
            </button>
          </div>
          <textarea
            rows={7}
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
            className="w-full bg-[#060A14] border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-200"
          />
          <div className="flex justify-end">
            <button
              onClick={handleJsonImport}
              disabled={busyAction}
              className="px-4 py-2 text-xs font-semibold rounded-lg bg-cyan-500 text-slate-950 hover:bg-cyan-400"
            >
              Import JSON Array
            </button>
          </div>
        </div>
      )}

      {/* Filter & Local Search Bar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1 p-1 bg-[#0B1221] border border-slate-800 rounded-lg">
          {['all', 'shortlisted', 'analyzed', 'new', 'proposal_drafted', 'approved', 'rejected'].map((st) => (
            <button
              key={st}
              onClick={() => setStatusFilter(st)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap capitalize ${
                statusFilter === st ? 'bg-cyan-500/20 text-cyan-300' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {st.replace(/_/g, ' ')}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-3">
          <label className="inline-flex items-center gap-2 text-xs text-slate-400 cursor-pointer whitespace-nowrap">
            <input
              type="checkbox"
              checked={showRejected}
              onChange={(e) => setShowRejected(e.target.checked)}
              className="rounded border-slate-700 bg-[#060A14] text-cyan-500"
            />
            <span>Show excluded / rejected</span>
          </label>
          <input
            type="text"
            placeholder="Filter stored jobs..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void loadData()}
            className="bg-[#0B1221] border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-cyan-400"
          />
        </div>
      </div>

      {/* Jobs High-Density Data Table */}
      <div className="bg-[#0B1221] border border-slate-800/90 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-800 text-xs text-slate-400">
                <th className="py-3 px-4 font-medium">Job Title & Source</th>
                <th className="py-3 px-4 font-medium">Category</th>
                <th className="py-3 px-4 font-medium text-right">Budget</th>
                <th className="py-3 px-4 font-medium text-right">Score</th>
                <th className="py-3 px-4 font-medium text-right">Risk</th>
                <th className="py-3 px-4 font-medium">Status</th>
                <th className="py-3 px-4 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70 text-sm">
              {loading ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-xs text-slate-500">
                    Loading stored jobs...
                  </td>
                </tr>
              ) : jobs.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-xs text-slate-400">
                    No jobs match this view. Run a permitted public API search or use Manual Brief / CSV / JSON import above.
                  </td>
                </tr>
              ) : (
                jobs.map((job) => (
                  <tr
                    key={job.id}
                    onClick={() => onSelectJob(job.id)}
                    className="hover:bg-slate-800/40 cursor-pointer transition-colors"
                  >
                    <td className="py-3 px-4 max-w-md">
                      <p className="font-medium text-slate-100 truncate">{job.title}</p>
                      <p className="text-xs text-slate-400 mt-0.5">
                        {job.sourceName} · {formatShortDate(job.dateImported)}
                        {job.estimatedHours ? ` · ~${job.estimatedHours}h` : ''}
                      </p>
                      {job.rejectionReason && (
                        <p className="text-xs text-rose-400/90 mt-1 truncate">{job.rejectionReason}</p>
                      )}
                    </td>
                    <td className="py-3 px-4 text-xs text-slate-300 whitespace-nowrap">{job.category}</td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-xs text-slate-200 whitespace-nowrap">
                      {formatMoney(job.budget, job.currency)}
                      {job.paymentType === 'hourly' ? '/hr' : ''}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-xs font-semibold whitespace-nowrap">
                      <span
                        className={
                          (job.jobScore ?? 0) >= 75
                            ? 'text-emerald-400'
                            : (job.jobScore ?? 0) >= 55
                              ? 'text-cyan-300'
                              : 'text-slate-400'
                        }
                      >
                        {job.jobScore !== null ? `${job.jobScore}/100` : '—'}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-xs whitespace-nowrap">
                      <span className={(job.riskScore ?? 0) >= 50 ? 'text-rose-400' : 'text-slate-400'}>
                        {job.riskScore !== null ? `${job.riskScore}` : '—'}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-xs whitespace-nowrap capitalize">
                      <span
                        className={
                          job.status === 'rejected'
                            ? 'text-rose-400'
                            : job.status === 'shortlisted' || job.status === 'ready_for_submission'
                              ? 'text-emerald-400'
                              : job.status === 'approved' || job.status === 'in_progress'
                                ? 'text-cyan-400'
                                : 'text-slate-300'
                        }
                      >
                        {job.status.replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-2">
                        <button
                          onClick={(e) => handleAnalyze(job.id, e)}
                          disabled={busyAction}
                          title="Re-analyze job"
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs text-cyan-300 hover:text-cyan-200 border border-slate-700 rounded hover:border-cyan-500/40"
                        >
                          <Sparkles className="w-3 h-3" />
                          <span>Analyze</span>
                        </button>
                        {job.status === 'rejected' && (
                          <button
                            onClick={(e) => handleOverride(job.id, e)}
                            disabled={busyAction}
                            title="Override rejection"
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs text-amber-300 hover:text-amber-200 border border-amber-500/30 rounded"
                          >
                            <RotateCcw className="w-3 h-3" />
                            <span>Override</span>
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
    </div>
  );
};
