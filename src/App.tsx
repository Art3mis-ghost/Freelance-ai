import React, { useCallback, useEffect, useState } from 'react';
import {
  LayoutDashboard,
  Search,
  FileSearch,
  FileSignature,
  Bot,
  FolderKanban,
  ShieldCheck,
  Send,
  BarChart3,
  ListChecks,
  Radio,
  Settings,
  Bell,
  LogOut,
  Menu,
  X,
} from 'lucide-react';
import { apiRequest, formatShortDate, setAuthToken } from './client/api.ts';
import { AuthGate } from './client/components/AuthGate.tsx';
import { DashboardView } from './client/components/DashboardView.tsx';
import { JobDiscoveryView } from './client/components/JobDiscoveryView.tsx';
import { JobDetailsView } from './client/components/JobDetailsView.tsx';
import { ProposalStudioView } from './client/components/ProposalStudioView.tsx';
import { AgentCenterView } from './client/components/AgentCenterView.tsx';
import { ProjectWorkspaceView } from './client/components/ProjectWorkspaceView.tsx';
import { QualityControlView } from './client/components/QualityControlView.tsx';
import { SubmissionCenterView } from './client/components/SubmissionCenterView.tsx';
import { AnalyticsView } from './client/components/AnalyticsView.tsx';
import { TaskHistoryView } from './client/components/TaskHistoryView.tsx';
import { JobSourcesView } from './client/components/JobSourcesView.tsx';
import { SettingsView } from './client/components/SettingsView.tsx';
import type { DashboardData, NavSection, NotificationRecord } from './shared/types.ts';

const NAV_ITEMS: Array<{ id: NavSection; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'discovery', label: 'Job Discovery', icon: Search },
  { id: 'job-details', label: 'Job Details', icon: FileSearch },
  { id: 'proposals', label: 'Proposal Studio', icon: FileSignature },
  { id: 'agents', label: 'AI Agent Center', icon: Bot },
  { id: 'workspace', label: 'Project Workspace', icon: FolderKanban },
  { id: 'qa', label: 'Quality Control', icon: ShieldCheck },
  { id: 'submissions', label: 'Submission Center', icon: Send },
  { id: 'analytics', label: 'Earnings & Analytics', icon: BarChart3 },
  { id: 'tasks', label: 'Task History', icon: ListChecks },
  { id: 'sources', label: 'Job Sources', icon: Radio },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export default function App() {
  const [authStatus, setAuthStatus] = useState<{
    checked: boolean;
    claimed: boolean;
    envOverride: boolean;
    authenticated: boolean;
    requiresSetupToken: boolean;
    bootstrapAllowed: boolean;
  }>({
    checked: false,
    claimed: false,
    envOverride: false,
    authenticated: false,
    requiresSetupToken: false,
    bootstrapAllowed: true,
  });

  const [activeNav, setActiveNav] = useState<NavSection>('dashboard');
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [dashboardData, setDashboardData] = useState<DashboardData | null>(null);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [demoToggling, setDemoToggling] = useState(false);

  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);
  const [notifOpen, setNotifOpen] = useState(false);

  const checkAuth = useCallback(async () => {
    try {
      const res = await apiRequest<{
        claimed: boolean;
        envOverride: boolean;
        authenticated: boolean;
        requiresSetupToken?: boolean;
        bootstrapAllowed?: boolean;
      }>('/api/auth/status');
      setAuthStatus({
        checked: true,
        claimed: res.claimed,
        envOverride: res.envOverride,
        authenticated: res.authenticated,
        requiresSetupToken: Boolean(res.requiresSetupToken),
        bootstrapAllowed: res.bootstrapAllowed !== false,
      });
    } catch {
      setAuthStatus({
        checked: true,
        claimed: false,
        envOverride: false,
        authenticated: false,
        requiresSetupToken: false,
        bootstrapAllowed: true,
      });
    }
  }, []);

  const refreshDashboardAndNotifications = useCallback(async () => {
    setDashboardLoading(true);
    try {
      const [dash, notifRes] = await Promise.all([
        apiRequest<DashboardData>('/api/dashboard'),
        apiRequest<{ notifications: NotificationRecord[] }>('/api/notifications'),
      ]);
      setDashboardData(dash);
      setNotifications(notifRes.notifications);
    } catch {
      // ignore if session expired
    } finally {
      setDashboardLoading(false);
    }
  }, []);

  useEffect(() => {
    void checkAuth();
  }, [checkAuth]);

  useEffect(() => {
    if (authStatus.authenticated) {
      void refreshDashboardAndNotifications();
    }
  }, [authStatus.authenticated, refreshDashboardAndNotifications]);

  const handleToggleDemoMode = async (enable: boolean) => {
    setDemoToggling(true);
    try {
      await apiRequest('/api/settings/demo-mode', {
        method: 'POST',
        body: JSON.stringify({ enabled: enable }),
      });
      await refreshDashboardAndNotifications();
    } finally {
      setDemoToggling(false);
    }
  };

  const handleLogout = async () => {
    try {
      await apiRequest('/api/auth/logout', { method: 'POST' });
    } catch {
      // ignore
    }
    setAuthToken(null);
    setDashboardData(null);
    setAuthStatus((prev) => ({ ...prev, authenticated: false }));
  };

  const handleMarkAllRead = async () => {
    await apiRequest('/api/notifications/read-all', { method: 'POST' });
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  };

  if (!authStatus.checked) {
    return (
      <div className="min-h-screen bg-[#060A14] text-slate-400 flex items-center justify-center text-sm">
        Connecting to local Freelance AI Agent Hub server...
      </div>
    );
  }

  if (!authStatus.authenticated) {
    return (
      <AuthGate
        claimed={authStatus.claimed}
        envOverride={authStatus.envOverride}
        requiresSetupToken={authStatus.requiresSetupToken}
        bootstrapAllowed={authStatus.bootstrapAllowed}
        onAuthenticated={() => setAuthStatus((prev) => ({ ...prev, claimed: true, authenticated: true }))}
      />
    );
  }

  const unreadCount = notifications.filter((n) => !n.read).length;
  const activeNavLabel = NAV_ITEMS.find((i) => i.id === activeNav)?.label || 'Dashboard';

  const navigate = (section: NavSection) => {
    setActiveNav(section);
    setMobileMenuOpen(false);
    if (section === 'dashboard') {
      void refreshDashboardAndNotifications();
    }
  };

  return (
    <div className="min-h-screen bg-[#060A14] text-slate-100 flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex lg:flex-col w-64 shrink-0 bg-[#0B1221] border-r border-slate-800/80 sticky top-0 h-screen">
        <div className="px-5 py-5 border-b border-slate-800/80">
          <span className="text-base font-bold tracking-tight text-white block whitespace-nowrap">
            Freelance AI Agent Hub
          </span>
          <span className="text-xs text-slate-400 block mt-0.5">
            Local-First Operations Center
          </span>
        </div>

        <nav className="flex-1 overflow-y-auto py-3 px-3 space-y-0.5">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = activeNav === item.id;
            return (
              <button
                key={item.id}
                onClick={() => navigate(item.id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-cyan-500/15 text-cyan-300 font-medium'
                    : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800/40'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-800/80 flex items-center justify-between text-xs text-slate-400">
          <span>SQLite Local</span>
          <button
            onClick={handleLogout}
            className="inline-flex items-center gap-1.5 text-slate-400 hover:text-rose-300 transition-colors"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Lock</span>
          </button>
        </div>
      </aside>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div className="fixed inset-0 bg-black/70" onClick={() => setMobileMenuOpen(false)} />
          <aside className="relative w-64 bg-[#0B1221] border-r border-slate-800 h-full flex flex-col z-10">
            <div className="px-4 py-4 border-b border-slate-800 flex items-center justify-between">
              <span className="text-sm font-bold text-white">Freelance AI Agent Hub</span>
              <button onClick={() => setMobileMenuOpen(false)} className="text-slate-400 hover:text-white p-1">
                <X className="w-4 h-4" />
              </button>
            </div>
            <nav className="flex-1 overflow-y-auto p-3 space-y-0.5">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const active = activeNav === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => navigate(item.id)}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm whitespace-nowrap ${
                      active ? 'bg-cyan-500/15 text-cyan-300 font-medium' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
          </aside>
        </div>
      )}

      {/* Main Content Column */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Clean Contextual Top Bar */}
        <header className="h-14 border-b border-slate-800/80 bg-[#060A14]/95 backdrop-blur px-4 lg:px-8 flex items-center justify-between gap-4 sticky top-0 z-30">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-1.5 text-slate-400 hover:text-white rounded-lg border border-slate-800"
              aria-label="Open navigation"
            >
              <Menu className="w-4 h-4" />
            </button>
            <div className="flex items-center gap-2 text-xs text-slate-400 truncate">
              <span className="hidden sm:inline">Command Center</span>
              <span className="hidden sm:inline text-slate-600">/</span>
              <span className="text-slate-100 font-medium truncate">{activeNavLabel}</span>
              {dashboardData?.demoMode && (
                <>
                  <span className="text-slate-600">·</span>
                  <span className="text-amber-300 font-medium whitespace-nowrap">Demo Mode Active</span>
                </>
              )}
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0 relative">
            <button
              onClick={() => setNotifOpen((v) => !v)}
              className="relative inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-slate-300 hover:text-white border border-slate-800 rounded-lg hover:border-slate-700 whitespace-nowrap"
            >
              <Bell className="w-3.5 h-3.5" />
              <span>Alerts</span>
              {unreadCount > 0 && (
                <span className="font-mono tabular-nums text-cyan-400 font-semibold">({unreadCount})</span>
              )}
            </button>

            <button
              onClick={() => navigate('discovery')}
              className="px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-cyan-500 text-slate-950 hover:bg-cyan-400 transition-colors whitespace-nowrap shrink-0"
            >
              Import Job
            </button>

            {/* Notifications Popover */}
            {notifOpen && (
              <div className="absolute right-0 top-11 w-80 sm:w-96 bg-[#0B1221] border border-slate-700 rounded-xl shadow-2xl z-40 overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
                  <span className="text-xs font-semibold text-white">Notifications</span>
                  <div className="flex items-center gap-3 text-xs">
                    {unreadCount > 0 && (
                      <button onClick={handleMarkAllRead} className="text-cyan-400 hover:text-cyan-300">
                        Mark all read
                      </button>
                    )}
                    <button onClick={() => setNotifOpen(false)} className="text-slate-400 hover:text-white">
                      Close
                    </button>
                  </div>
                </div>
                <div className="divide-y divide-slate-800/70 max-h-80 overflow-y-auto">
                  {notifications.length === 0 ? (
                    <p className="text-xs text-slate-500 p-6 text-center">No notifications yet.</p>
                  ) : (
                    notifications.slice(0, 20).map((n) => (
                      <div key={n.id} className={`p-3.5 text-xs ${n.read ? 'opacity-65' : ''}`}>
                        <div className="flex items-center justify-between gap-2">
                          <span
                            className={`font-medium ${
                              n.severity === 'error'
                                ? 'text-rose-300'
                                : n.severity === 'warning'
                                  ? 'text-amber-300'
                                  : n.severity === 'success'
                                    ? 'text-emerald-300'
                                    : 'text-slate-100'
                            }`}
                          >
                            {n.title}
                          </span>
                          <span className="text-slate-500 font-mono shrink-0">{formatShortDate(n.createdAt)}</span>
                        </div>
                        <p className="text-slate-400 mt-1 leading-snug">{n.message}</p>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </header>

        {/* Active View Viewport */}
        <main className="flex-1 p-4 lg:p-8 max-w-[1600px] w-full mx-auto">
          {activeNav === 'dashboard' && (
            <DashboardView
              data={dashboardData}
              loading={dashboardLoading}
              onRefresh={refreshDashboardAndNotifications}
              onNavigate={navigate}
              onToggleDemoMode={handleToggleDemoMode}
              demoToggling={demoToggling}
            />
          )}

          {activeNav === 'discovery' && (
            <JobDiscoveryView
              onSelectJob={(id) => {
                setSelectedJobId(id);
                navigate('job-details');
              }}
              onJobsChanged={refreshDashboardAndNotifications}
            />
          )}

          {activeNav === 'job-details' && (
            <JobDetailsView
              jobId={selectedJobId}
              onBack={() => navigate('discovery')}
              onOpenProposalStudio={(jobId) => {
                setSelectedJobId(jobId);
                navigate('proposals');
              }}
              onOpenProjectWorkspace={(projectId) => {
                setSelectedProjectId(projectId);
                navigate('workspace');
              }}
              onChanged={refreshDashboardAndNotifications}
            />
          )}

          {activeNav === 'proposals' && (
            <ProposalStudioView
              initialJobId={selectedJobId}
              onOpenProjectWorkspace={(projectId) => {
                setSelectedProjectId(projectId);
                navigate('workspace');
              }}
              onChanged={refreshDashboardAndNotifications}
            />
          )}

          {activeNav === 'agents' && <AgentCenterView />}

          {activeNav === 'workspace' && (
            <ProjectWorkspaceView
              initialProjectId={selectedProjectId}
              onNavigateSubmissions={() => navigate('submissions')}
              onChanged={refreshDashboardAndNotifications}
            />
          )}

          {activeNav === 'qa' && <QualityControlView />}

          {activeNav === 'submissions' && <SubmissionCenterView onChanged={refreshDashboardAndNotifications} />}

          {activeNav === 'analytics' && <AnalyticsView />}

          {activeNav === 'tasks' && <TaskHistoryView />}

          {activeNav === 'sources' && <JobSourcesView onNavigateDiscovery={() => navigate('discovery')} />}

          {activeNav === 'settings' && <SettingsView onSettingsChanged={refreshDashboardAndNotifications} />}
        </main>
      </div>
    </div>
  );
}
