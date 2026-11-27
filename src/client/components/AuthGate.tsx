import React, { useState } from 'react';
import { Lock, ShieldCheck, KeyRound, ArrowRight, ShieldAlert } from 'lucide-react';
import { apiRequest, setAuthToken } from '../api.ts';

interface AuthGateProps {
  claimed: boolean;
  envOverride: boolean;
  requiresSetupToken?: boolean;
  bootstrapAllowed?: boolean;
  onAuthenticated: () => void;
}

export const AuthGate: React.FC<AuthGateProps> = ({
  claimed,
  envOverride,
  requiresSetupToken = false,
  bootstrapAllowed = true,
  onAuthenticated,
}) => {
  const [passcode, setPasscode] = useState('');
  const [confirmPasscode, setConfirmPasscode] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!claimed) {
      if (!bootstrapAllowed) {
        setError('First-run setup is restricted to localhost. Connect from 127.0.0.1 or set HUB_ADMIN_PASSCODE on the server.');
        return;
      }
      if (requiresSetupToken && !setupToken.trim()) {
        setError('First-run setup token is required.');
        return;
      }
      if (passcode.length < 6) {
        setError('Passcode must be at least 6 characters.');
        return;
      }
      if (passcode !== confirmPasscode) {
        setError('Passcodes do not match.');
        return;
      }
    }

    setSubmitting(true);
    try {
      const endpoint = claimed ? '/api/auth/login' : '/api/auth/bootstrap';
      const payload = claimed
        ? { passcode }
        : { passcode, ...(requiresSetupToken ? { setupToken: setupToken.trim() } : {}) };
      const data = await apiRequest<{ token: string }>(endpoint, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setAuthToken(data.token);
      onAuthenticated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#060A14] text-slate-100 flex items-center justify-center p-6">
      <div className="w-full max-w-md bg-[#0B1221] border border-cyan-500/20 rounded-xl p-8 shadow-2xl shadow-cyan-950/30">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-lg bg-cyan-500/10 border border-cyan-400/25 flex items-center justify-center text-cyan-400">
            {claimed ? <Lock className="w-5 h-5" /> : <ShieldCheck className="w-5 h-5" />}
          </div>
          <div>
            <h1 className="text-xl font-semibold text-white tracking-tight">Freelance AI Agent Hub</h1>
            <p className="text-xs text-slate-400">
              {claimed ? 'Local Operator Session Unlock' : 'First-Run Local Security Setup'}
            </p>
          </div>
        </div>

        <p className="text-sm text-slate-300 leading-relaxed mb-6">
          {claimed
            ? envOverride
              ? 'Sign in using the HUB_ADMIN_PASSCODE configured in your server environment.'
              : 'Enter your local operator passcode to unlock the SQLite workspace, agent orchestrator, and AI routing controls.'
            : 'Create your local admin passcode. First-run setup is restricted to localhost, hashed on the server with scrypt, and rate-limited against brute-force attempts.'}
        </p>

        {!claimed && !bootstrapAllowed ? (
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4 text-xs text-amber-200 space-y-2">
            <div className="flex items-center gap-2 font-semibold text-amber-300">
              <ShieldAlert className="w-4 h-4 shrink-0" />
              <span>Remote First-Run Setup Blocked</span>
            </div>
            <p className="leading-relaxed">
              For security, claiming the initial admin passcode is only permitted from localhost (<code>127.0.0.1</code>).
              For remote or cloud servers, set <code>HUB_ADMIN_PASSCODE</code> in your server environment variables and restart.
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {!claimed && requiresSetupToken && (
              <div>
                <label htmlFor="hub-setup-token" className="block text-xs font-medium text-slate-300 mb-1.5">
                  First-Run Setup Token (from .env / Windows Installer)
                </label>
                <input
                  id="hub-setup-token"
                  type="password"
                  value={setupToken}
                  onChange={(e) => setSetupToken(e.target.value)}
                  required
                  autoFocus
                  placeholder="Paste HUB_SETUP_TOKEN"
                  className="w-full bg-[#060A14] border border-slate-700/80 rounded-lg px-3.5 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-cyan-400"
                />
              </div>
            )}

            <div>
              <label htmlFor="hub-passcode" className="block text-xs font-medium text-slate-300 mb-1.5">
                {claimed ? 'Operator Passcode' : 'Create Admin Passcode (min. 6 characters)'}
              </label>
              <div className="relative">
                <KeyRound className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  id="hub-passcode"
                  type="password"
                  value={passcode}
                  onChange={(e) => setPasscode(e.target.value)}
                  required
                  autoFocus={claimed || !requiresSetupToken}
                  placeholder="Enter passcode"
                  className="w-full bg-[#060A14] border border-slate-700/80 rounded-lg pl-10 pr-3.5 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-cyan-400"
                />
              </div>
            </div>

            {!claimed && (
              <div>
                <label htmlFor="hub-passcode-confirm" className="block text-xs font-medium text-slate-300 mb-1.5">
                  Confirm Admin Passcode
                </label>
                <input
                  id="hub-passcode-confirm"
                  type="password"
                  value={confirmPasscode}
                  onChange={(e) => setConfirmPasscode(e.target.value)}
                  required
                  placeholder="Re-enter passcode"
                  className="w-full bg-[#060A14] border border-slate-700/80 rounded-lg px-3.5 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-cyan-400"
                />
              </div>
            )}

            {error && (
              <div className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/25 rounded-lg px-3.5 py-2.5">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full flex items-center justify-center gap-2 bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-slate-950 font-semibold text-sm py-2.5 px-4 rounded-lg transition-colors whitespace-nowrap"
            >
              <span>{submitting ? 'Verifying...' : claimed ? 'Unlock Command Center' : 'Claim Admin Access'}</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </form>
        )}

        <div className="mt-6 pt-5 border-t border-slate-800/80 text-xs text-slate-500 space-y-1">
          <p>Session tokens are stored strictly in memory and cleared when you sign out or reload.</p>
          <p>Runs natively on Windows 10/11 (127.0.0.1 default) or Cloud Node.js 22+ servers.</p>
        </div>
      </div>
    </div>
  );
};
