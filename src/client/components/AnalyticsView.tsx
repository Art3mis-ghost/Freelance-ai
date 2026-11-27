import React, { useEffect, useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { apiRequest, formatMoney, formatShortDate } from '../api.ts';
import type { PaymentRecord } from '../../shared/types.ts';

interface AnalyticsPayload {
  demoMode: boolean;
  funnel: {
    jobsDiscovered: number;
    jobsAnalyzed: number;
    jobsShortlisted: number;
    proposalsDrafted: number;
    proposalsSubmittedManually: number;
    contractsAwarded: number;
    projectsCompleted: number;
    jobsSubmitted: number;
    jobsPaid: number;
  };
  financials: {
    estimatedPotentialEarnings: number;
    actualPaidEarnings: number;
    platformFees: number;
    netEarnings: number;
  };
  byPlatform: Array<{ platform: string; jobs: number; actualPaid: number; netPaid: number }>;
  byCategory: Array<{ category: string; jobs: number; actualPaid: number; netPaid: number }>;
  payments: PaymentRecord[];
}

export const AnalyticsView: React.FC = () => {
  const [report, setReport] = useState<AnalyticsPayload | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void apiRequest<AnalyticsPayload>('/api/analytics')
      .then(setReport)
      .finally(() => setLoading(false));
  }, []);

  if (loading || !report) {
    return <div className="text-xs text-slate-400 p-6">Loading analytics & earnings ledger...</div>;
  }

  const funnelSteps = [
    { stage: 'Discovered', count: report.funnel.jobsDiscovered },
    { stage: 'Analyzed', count: report.funnel.jobsAnalyzed },
    { stage: 'Shortlisted', count: report.funnel.jobsShortlisted },
    { stage: 'Drafted', count: report.funnel.proposalsDrafted },
    { stage: 'Submitted', count: report.funnel.proposalsSubmittedManually },
    { stage: 'Awarded', count: report.funnel.contractsAwarded },
    { stage: 'Completed', count: report.funnel.projectsCompleted },
    { stage: 'Delivered', count: report.funnel.jobsSubmitted },
    { stage: 'Paid', count: report.funnel.jobsPaid },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-white tracking-tight">Earnings & Analytics</h1>
        <p className="text-sm text-slate-400 mt-1">
          Strict accounting separation: Estimated Potential Earnings reflect active pipelines, while Actual Paid Earnings include only recorded client payments.
        </p>
      </div>

      {/* Financial Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-[#0B1221] border border-slate-800/90 rounded-xl p-5">
          <p className="text-xs text-slate-400">Estimated Potential Earnings</p>
          <p className="text-2xl font-bold font-mono tabular-nums text-blue-300 mt-1.5">
            {formatMoney(report.financials.estimatedPotentialEarnings)}
          </p>
          <p className="text-xs text-slate-500 mt-1">Unpaid pipeline estimates only</p>
        </div>
        <div className="bg-[#0B1221] border border-slate-800/90 rounded-xl p-5">
          <p className="text-xs text-slate-400">Actual Paid Earnings (Gross)</p>
          <p className="text-2xl font-bold font-mono tabular-nums text-emerald-400 mt-1.5">
            {formatMoney(report.financials.actualPaidEarnings)}
          </p>
          <p className="text-xs text-slate-500 mt-1">{report.payments.length} recorded payment(s)</p>
        </div>
        <div className="bg-[#0B1221] border border-slate-800/90 rounded-xl p-5">
          <p className="text-xs text-slate-400">Platform Fees</p>
          <p className="text-2xl font-bold font-mono tabular-nums text-amber-300 mt-1.5">
            {formatMoney(report.financials.platformFees)}
          </p>
          <p className="text-xs text-slate-500 mt-1">Logged fees deducted</p>
        </div>
        <div className="bg-[#0B1221] border border-slate-800/90 rounded-xl p-5">
          <p className="text-xs text-slate-400">Net Paid Earnings</p>
          <p className="text-2xl font-bold font-mono tabular-nums text-cyan-400 mt-1.5">
            {formatMoney(report.financials.netEarnings)}
          </p>
          <p className="text-xs text-slate-500 mt-1">Actual gross minus platform fees</p>
        </div>
      </div>

      {/* Productivity Conversion Funnel */}
      <div className="bg-[#0B1221] border border-slate-800/90 rounded-xl p-5">
        <div className="mb-4">
          <h2 className="text-sm font-semibold text-white">End-to-End Conversion Funnel</h2>
          <p className="text-xs text-slate-400">Real counts from discovery through recorded client payment</p>
        </div>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={funnelSteps}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1E293B" />
            <XAxis dataKey="stage" stroke="#94A3B8" fontSize={11} />
            <YAxis stroke="#64748B" fontSize={11} allowDecimals={false} />
            <Tooltip contentStyle={{ backgroundColor: '#0B1221', borderColor: '#1E293B', fontSize: 12 }} />
            <Bar dataKey="count" fill="#22D3EE" radius={[4, 4, 0, 0]} name="Count" />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Platform & Category Reports */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-[#0B1221] border border-slate-800/90 rounded-xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-800/80">
            <h3 className="text-sm font-semibold text-white">Platform Report</h3>
          </div>
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400">
                <th className="py-2.5 px-4 font-medium">Platform</th>
                <th className="py-2.5 px-4 font-medium text-right">Jobs</th>
                <th className="py-2.5 px-4 font-medium text-right">Actual Paid</th>
                <th className="py-2.5 px-4 font-medium text-right">Net Paid</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {report.byPlatform.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-6 text-center text-slate-500">
                    No platform records yet.
                  </td>
                </tr>
              ) : (
                report.byPlatform.map((row) => (
                  <tr key={row.platform}>
                    <td className="py-2.5 px-4 text-slate-200">{row.platform}</td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-300">{row.jobs}</td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums text-emerald-400">
                      {formatMoney(row.actualPaid)}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums text-cyan-300">
                      {formatMoney(row.netPaid)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="bg-[#0B1221] border border-slate-800/90 rounded-xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-800/80">
            <h3 className="text-sm font-semibold text-white">Category Report</h3>
          </div>
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400">
                <th className="py-2.5 px-4 font-medium">Category</th>
                <th className="py-2.5 px-4 font-medium text-right">Jobs</th>
                <th className="py-2.5 px-4 font-medium text-right">Actual Paid</th>
                <th className="py-2.5 px-4 font-medium text-right">Net Paid</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {report.byCategory.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-6 text-center text-slate-500">
                    No categorized jobs yet.
                  </td>
                </tr>
              ) : (
                report.byCategory.map((row) => (
                  <tr key={row.category}>
                    <td className="py-2.5 px-4 text-slate-200">{row.category}</td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-300">{row.jobs}</td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums text-emerald-400">
                      {formatMoney(row.actualPaid)}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums text-cyan-300">
                      {formatMoney(row.netPaid)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Recorded Payments Ledger */}
      <div className="bg-[#0B1221] border border-slate-800/90 rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-800/80">
          <h3 className="text-sm font-semibold text-white">Verified Payments Ledger</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400">
                <th className="py-2.5 px-4 font-medium">Project</th>
                <th className="py-2.5 px-4 font-medium">Platform</th>
                <th className="py-2.5 px-4 font-medium text-right">Gross</th>
                <th className="py-2.5 px-4 font-medium text-right">Fee</th>
                <th className="py-2.5 px-4 font-medium text-right">Net</th>
                <th className="py-2.5 px-4 font-medium">Paid At</th>
                <th className="py-2.5 px-4 font-medium">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {report.payments.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-slate-500">
                    No paid earnings recorded yet. Record received payments inside the Submission Center.
                  </td>
                </tr>
              ) : (
                report.payments.map((p) => (
                  <tr key={p.id}>
                    <td className="py-2.5 px-4 text-slate-100 font-medium">{p.projectTitle || p.projectId}</td>
                    <td className="py-2.5 px-4 text-slate-400">{p.sourceName || '—'}</td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-200">
                      {formatMoney(p.amount, p.currency)}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums text-amber-300">
                      {formatMoney(p.platformFee, p.currency)}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums text-emerald-400 font-semibold">
                      {formatMoney(p.netAmount, p.currency)}
                    </td>
                    <td className="py-2.5 px-4 font-mono tabular-nums text-slate-400">{formatShortDate(p.paidAt)}</td>
                    <td className="py-2.5 px-4 text-slate-400">{p.notes || '—'}</td>
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
