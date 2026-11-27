import React from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { RefreshCw, Search, PlayCircle, FlaskConical } from 'lucide-react';
import { formatMoney, formatShortDate } from '../api.ts';
import type { DashboardData, NavSection } from '../../shared/types.ts';

interface DashboardViewProps {
  data: DashboardData | null;
  loading: boolean;
  onRefresh: () => void;
  onNavigate: (section: NavSection) => void;
  onToggleDemoMode: (enable: boolean) => Promise<void>;
  demoToggling: boolean;
}

const CHART_COLORS = ['#22D3EE', '#3B82F6', '#60A5FA', '#10B981', '#F59E0B', '#A78BFA', '#F43F5E'];

export const DashboardView: React.FC<DashboardViewProps> = ({
  data,
  loading,
  onRefresh,
  onNavigate,
  onToggleDemoMode,
  demoToggling,
}) => {
  if (loading && !data) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
          {Array.from({ length: 14 }).map((_, i) => (
            <div key={i} className="h-20 rounded-lg bg-[#0B1221] border border-slate-800/80 animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="bg-[#0B1221] border border-slate-800 rounded-xl p-8 text-center">
        <p className="text-slate-300 text-sm mb-4">Unable to load dashboard metrics from the local SQLite database.</p>
        <button
          onClick={onRefresh}
          className="px-4 py-2 bg-cyan-500 text-slate-950 font-medium text-sm rounded-lg hover:bg-cyan-400 transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  const { kpis, charts, activityFeed, resources } = data;
  const isEmpty = kpis.totalJobsDiscovered === 0 && kpis.activeProjects === 0;

  const kpiCards = [
    { label: 'Total Discovered', value: kpis.totalJobsDiscovered, accent: 'text-white' },
    { label: 'New Jobs', value: kpis.newJobs, accent: 'text-cyan-400' },
    { label: 'Suitable Jobs', value: kpis.suitableJobs, accent: 'text-blue-400' },
    { label: 'High-Match (75+)', value: kpis.highMatchJobs, accent: 'text-emerald-400' },
    { label: 'Awaiting Approval', value: kpis.jobsAwaitingApproval, accent: 'text-amber-400' },
    { label: 'Active Projects', value: kpis.activeProjects, accent: 'text-cyan-300' },
    { label: 'Agents Running', value: kpis.agentsRunning, accent: 'text-emerald-400' },
    { label: 'Agents Queued', value: kpis.agentsQueued, accent: 'text-slate-200' },
    { label: 'Tasks Completed', value: kpis.tasksCompleted, accent: 'text-slate-100' },
    { label: 'Tasks Failed', value: kpis.tasksFailed, accent: kpis.tasksFailed > 0 ? 'text-rose-400' : 'text-slate-400' },
    { label: 'Ready to Submit', value: kpis.jobsReadyForSubmission, accent: 'text-cyan-400' },
    { label: 'Payments Logged', value: kpis.earningsRecordedCount, accent: 'text-slate-200' },
    { label: 'Estimated Pipeline', value: formatMoney(kpis.estimatedPotentialEarnings), accent: 'text-blue-300' },
    { label: 'Actual Paid', value: formatMoney(kpis.actualPaidEarnings), accent: 'text-emerald-400' },
  ];

  return (
    <div className="space-y-6">
      {/* Header & Real-Data Notice */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-white tracking-tight">Operations Dashboard</h1>
          <p className="text-sm text-slate-400 mt-1">
            Live SQLite telemetry across job discovery, multi-agent pipelines, QA verification, and recorded earnings.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <button
            onClick={() => onToggleDemoMode(!data.demoMode)}
            disabled={demoToggling}
            className={`inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 ${
              data.demoMode
                ? 'bg-amber-500/15 border-amber-400/40 text-amber-200 hover:bg-amber-500/25'
                : 'bg-[#0B1221] border-slate-700 text-slate-300 hover:border-cyan-400/40 hover:text-white'
            }`}
          >
            <FlaskConical className="w-3.5 h-3.5" />
            <span>{demoToggling ? 'Updating...' : data.demoMode ? 'Disable Demo Mode' : 'Enable Demo Mode'}</span>
          </button>
          <button
            onClick={() => onNavigate('discovery')}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium rounded-lg bg-cyan-500 text-slate-950 hover:bg-cyan-400 transition-colors whitespace-nowrap shrink-0"
          >
            <Search className="w-3.5 h-3.5" />
            <span>Discover or Import Jobs</span>
          </button>
          <button
            onClick={onRefresh}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg bg-[#0B1221] border border-slate-700/80 text-slate-300 hover:text-white hover:border-slate-600 transition-colors whitespace-nowrap shrink-0"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Empty State Banner (Production starts clean with zero fabricated stats) */}
      {isEmpty && (
        <div className="bg-[#0B1221] border border-cyan-500/25 rounded-xl p-6 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-white">Production Database Ready (Zero Fabricated Data)</h2>
            <p className="text-sm text-slate-400 max-w-2xl">
              Your local SQLite database starts completely clean. Run a live search on permitted public feeds (Remotive / Arbeitnow), import a real freelance brief via URL, text, CSV, or JSON, or toggle Demo Mode to inspect sample deliverables.
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <button
              onClick={() => onNavigate('discovery')}
              className="px-4 py-2 text-xs font-semibold rounded-lg bg-cyan-500 text-slate-950 hover:bg-cyan-400 transition-colors whitespace-nowrap"
            >
              Import First Job
            </button>
            <button
              onClick={() => onToggleDemoMode(true)}
              disabled={demoToggling}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg border border-slate-700 text-slate-200 hover:border-cyan-400/50 transition-colors whitespace-nowrap"
            >
              <PlayCircle className="w-3.5 h-3.5" />
              <span>Try Demo Mode</span>
            </button>
          </div>
        </div>
      )}

      {/* 14-Metric Operational Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-7 gap-3">
        {kpiCards.map((item) => (
          <div
            key={item.label}
            className="bg-[#0B1221] border border-slate-800/90 hover:border-cyan-500/30 rounded-lg px-3.5 py-3 transition-colors"
          >
            <p className="text-xs text-slate-400 truncate">{item.label}</p>
            <p className={`text-xl font-semibold font-mono tabular-nums mt-1 ${item.accent}`}>{item.value}</p>
          </div>
        ))}
      </div>

      {/* Live Host Resource Telemetry Strip */}
      <div className="bg-[#0B1221] border border-slate-800/90 rounded-xl px-5 py-3.5 flex flex-wrap items-center justify-between gap-4 text-xs">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-slate-300">
          <span className="font-medium text-white">Host Telemetry</span>
          <span className="text-slate-600">·</span>
          <span>
            RAM <span className="font-mono tabular-nums text-cyan-300">{resources.memoryUsedPercent}%</span>{' '}
            <span className="text-slate-500 font-mono tabular-nums">
              ({Math.round(resources.memoryUsedMb / 1024 * 10) / 10} / {Math.round(resources.memoryTotalMb / 1024 * 10) / 10} GB)
            </span>
          </span>
          <span className="text-slate-600">·</span>
          <span>
            CPU <span className="font-mono tabular-nums text-blue-300">{resources.cpuLoadPercent}%</span>{' '}
            <span className="text-slate-500">({resources.cpuCores} cores)</span>
          </span>
          {resources.diskFreeGb !== null && (
            <>
              <span className="text-slate-600">·</span>
              <span>
                Disk Free <span className="font-mono tabular-nums text-slate-200">{resources.diskFreeGb} GB</span>
              </span>
            </>
          )}
          <span className="text-slate-600">·</span>
          <span>
            Concurrency <span className="font-mono tabular-nums text-slate-200">{resources.runningTasks}/{resources.maxConcurrentAgents}</span>
          </span>
        </div>
        <div className="flex items-center gap-3 text-slate-400">
          <span>
            Active Model: <span className="text-slate-200 font-mono">{resources.activeModel || 'Idle'}</span>
          </span>
          <span className="text-slate-600">·</span>
          <span
            className={
              resources.resourcePressure === 'critical'
                ? 'text-rose-400 font-medium'
                : resources.resourcePressure === 'elevated'
                  ? 'text-amber-400 font-medium'
                  : 'text-emerald-400 font-medium'
            }
          >
            Pressure: {resources.resourcePressure}
          </span>
        </div>
      </div>

      {/* Charts Grid Row 1 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <ChartPanel title="Job Discovery Over Time" subtitle="Discovered vs shortlisted per day">
          {charts.discoveryOverTime.length === 0 ? (
            <EmptyChart message="Run job discovery or import jobs to populate timeline." />
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={charts.discoveryOverTime}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1E293B" />
                <XAxis dataKey="date" stroke="#64748B" fontSize={11} />
                <YAxis stroke="#64748B" fontSize={11} allowDecimals={false} />
                <Tooltip contentStyle={{ backgroundColor: '#0B1221', borderColor: '#1E293B', fontSize: 12 }} />
                <Area type="monotone" dataKey="discovered" stroke="#22D3EE" fill="#22D3EE" fillOpacity={0.18} name="Discovered" />
                <Area type="monotone" dataKey="shortlisted" stroke="#3B82F6" fill="#3B82F6" fillOpacity={0.18} name="Shortlisted" />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </ChartPanel>

        <ChartPanel title="Earnings History (Estimated vs Actual Paid)" subtitle="Only recorded payments count as actual paid earnings">
          {charts.earningsHistory.length === 0 ? (
            <EmptyChart message="Approve projects or record client payments to track earnings history." />
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={charts.earningsHistory}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1E293B" />
                <XAxis dataKey="month" stroke="#64748B" fontSize={11} />
                <YAxis stroke="#64748B" fontSize={11} />
                <Tooltip contentStyle={{ backgroundColor: '#0B1221', borderColor: '#1E293B', fontSize: 12 }} />
                <Bar dataKey="estimated" fill="#3B82F6" name="Estimated Pipeline" radius={[4, 4, 0, 0]} />
                <Bar dataKey="actualPaid" fill="#10B981" name="Actual Paid" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartPanel>
      </div>

      {/* Charts Grid Row 2 */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        <ChartPanel title="Jobs by Platform" subtitle="Source distribution">
          {charts.jobsByPlatform.length === 0 ? (
            <EmptyChart message="No platform data yet." />
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={charts.jobsByPlatform} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#1E293B" />
                <XAxis type="number" stroke="#64748B" fontSize={11} allowDecimals={false} />
                <YAxis dataKey="platform" type="category" stroke="#94A3B8" fontSize={11} width={96} />
                <Tooltip contentStyle={{ backgroundColor: '#0B1221', borderColor: '#1E293B', fontSize: 12 }} />
                <Bar dataKey="count" fill="#22D3EE" radius={[0, 4, 4, 0]} name="Jobs" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartPanel>

        <ChartPanel title="Jobs by Category" subtitle="Graphic design excluded by default">
          {charts.jobsByCategory.length === 0 ? (
            <EmptyChart message="No categorized jobs yet." />
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={charts.jobsByCategory} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#1E293B" />
                <XAxis type="number" stroke="#64748B" fontSize={11} allowDecimals={false} />
                <YAxis dataKey="category" type="category" stroke="#94A3B8" fontSize={11} width={115} />
                <Tooltip contentStyle={{ backgroundColor: '#0B1221', borderColor: '#1E293B', fontSize: 12 }} />
                <Bar dataKey="count" fill="#60A5FA" radius={[0, 4, 4, 0]} name="Jobs" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartPanel>

        <ChartPanel title="Job Match Score Distribution" subtitle="Weighted 0-100 suitability buckets">
          {charts.matchScoreDistribution.length === 0 ? (
            <EmptyChart message="Analyze jobs to view score buckets." />
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={charts.matchScoreDistribution}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1E293B" />
                <XAxis dataKey="bucket" stroke="#64748B" fontSize={11} />
                <YAxis stroke="#64748B" fontSize={11} allowDecimals={false} />
                <Tooltip contentStyle={{ backgroundColor: '#0B1221', borderColor: '#1E293B', fontSize: 12 }} />
                <Bar dataKey="count" fill="#10B981" radius={[4, 4, 0, 0]} name="Jobs" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartPanel>
      </div>

      {/* Charts Grid Row 3 + Activity Feed */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <ChartPanel title="Project Status Breakdown" subtitle="Active, QA, ready, submitted, paid">
          {charts.projectStatusBreakdown.length === 0 ? (
            <EmptyChart message="Approve a job to start tracking project status." />
          ) : (
            <ResponsiveContainer width="100%" height={210}>
              <PieChart>
                <Pie
                  data={charts.projectStatusBreakdown}
                  dataKey="count"
                  nameKey="status"
                  cx="50%"
                  cy="50%"
                  innerRadius={48}
                  outerRadius={78}
                  paddingAngle={3}
                >
                  {charts.projectStatusBreakdown.map((entry, idx) => (
                    <Cell key={entry.status} fill={CHART_COLORS[idx % CHART_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip contentStyle={{ backgroundColor: '#0B1221', borderColor: '#1E293B', fontSize: 12 }} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </ChartPanel>

        <ChartPanel title="Agent Performance" subtitle="Completed vs failed background tasks">
          {charts.agentPerformance.length === 0 ? (
            <EmptyChart message="No agent tasks executed yet." />
          ) : (
            <ResponsiveContainer width="100%" height={210}>
              <BarChart data={charts.agentPerformance}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1E293B" />
                <XAxis dataKey="agent" stroke="#64748B" fontSize={10} />
                <YAxis stroke="#64748B" fontSize={11} allowDecimals={false} />
                <Tooltip contentStyle={{ backgroundColor: '#0B1221', borderColor: '#1E293B', fontSize: 12 }} />
                <Bar dataKey="completed" fill="#22D3EE" name="Completed" radius={[4, 4, 0, 0]} />
                <Bar dataKey="failed" fill="#F43F5E" name="Failed" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartPanel>

        {/* Real Audit & Activity Timeline */}
        <div className="bg-[#0B1221] border border-slate-800/90 rounded-xl p-5 flex flex-col">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="text-sm font-semibold text-white">Activity Feed</h3>
              <p className="text-xs text-slate-400">Verified backend audit events</p>
            </div>
            <button
              onClick={() => onNavigate('tasks')}
              className="text-xs text-cyan-400 hover:text-cyan-300 transition-colors whitespace-nowrap"
            >
              View All
            </button>
          </div>
          <div className="divide-y divide-slate-800/80 overflow-y-auto max-h-[210px] pr-1">
            {activityFeed.length === 0 ? (
              <p className="text-xs text-slate-500 py-6 text-center">No operational events logged yet.</p>
            ) : (
              activityFeed.map((ev) => (
                <div key={ev.id} className="py-2.5">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-medium text-slate-200 capitalize truncate">{ev.title}</span>
                    <span className="text-slate-500 font-mono tabular-nums shrink-0">{formatShortDate(ev.createdAt)}</span>
                  </div>
                  {ev.detail && <p className="text-xs text-slate-400 truncate mt-0.5">{ev.detail}</p>}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

const ChartPanel: React.FC<{ title: string; subtitle: string; children: React.ReactNode }> = ({
  title,
  subtitle,
  children,
}) => (
  <div className="bg-[#0B1221] border border-slate-800/90 rounded-xl p-5">
    <div className="mb-3">
      <h3 className="text-sm font-semibold text-white">{title}</h3>
      <p className="text-xs text-slate-400">{subtitle}</p>
    </div>
    {children}
  </div>
);

const EmptyChart: React.FC<{ message: string }> = ({ message }) => (
  <div className="h-[200px] flex items-center justify-center text-center px-4">
    <p className="text-xs text-slate-500">{message}</p>
  </div>
);
