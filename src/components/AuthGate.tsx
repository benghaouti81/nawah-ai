import { useState, type FormEvent } from 'react';
import { Check, Copy, Download, KeyRound, ShieldCheck } from 'lucide-react';
import { api, ApiError, type SessionInfo } from '../lib/api';

interface AuthGateProps {
  needsSetup: boolean;
  workspaceName: string;
  onAuthenticated: (token: string, session: SessionInfo) => void;
}

export function AuthGate({
  needsSetup,
  workspaceName,
  onAuthenticated,
}: AuthGateProps) {
  const [adminLabel, setAdminLabel] = useState('Platform Admin');
  const [issuedKey, setIssuedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [accessKeyInput, setAccessKeyInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSetupSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await api.setupFirstAdmin(adminLabel.trim());
      setIssuedKey(res.rawKey);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Failed to create initial global_admin key.',
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleContinueWithIssuedKey() {
    if (!issuedKey) return;
    setError(null);
    setLoading(true);
    try {
      const session = await api.getMe(issuedKey);
      onAuthenticated(issuedKey, session);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Unable to verify generated key.',
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleSignInSubmit(e: FormEvent) {
    e.preventDefault();
    const cleaned = accessKeyInput.trim();
    if (!cleaned) {
      setError('Enter your Nawah access key.');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const session = await api.getMe(cleaned);
      onAuthenticated(cleaned, session);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Authentication failed. Check your access key.',
      );
    } finally {
      setLoading(false);
    }
  }

  function handleCopyKey() {
    if (!issuedKey) return;
    navigator.clipboard.writeText(issuedKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleDownloadBackup() {
    if (!issuedKey) return;
    const content = [
      `Nawah AI — Initial Global Admin Access Key`,
      `Workspace: ${workspaceName}`,
      `Label: ${adminLabel}`,
      `Created: ${new Date().toISOString()}`,
      ``,
      `NAWAH_API_KEY=${issuedKey}`,
      ``,
      `Store this key in your password manager. It is stored hashed (SHA-256) on the server and cannot be retrieved again.`,
    ].join('\n');
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'nawah-global-admin-key.txt';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-center items-center px-6 py-12">
      <div className="w-full max-w-lg bg-white border border-slate-200 rounded-xl p-8">
        <div className="mb-8">
          <div className="text-xs font-medium text-slate-500 mb-2">
            {workspaceName} · Core v0.1
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            {needsSetup && !issuedKey
              ? 'Initialize Nawah AI Core'
              : issuedKey
                ? 'Save Your Global Admin Key'
                : 'Sign In to Nawah AI'}
          </h1>
          <p className="mt-2 text-sm text-slate-600 leading-relaxed">
            {needsSetup && !issuedKey
              ? 'No access keys exist yet. Mint the first global_admin Bearer key to unlock the workspace and lock initial setup permanently.'
              : issuedKey
                ? 'This key is hashed with SHA-256 on the server and will not be shown again. Store it securely before entering the workspace.'
                : 'Authenticate with an active Bearer access key issued for your account (global_admin, department_admin, or member).'}
          </p>
        </div>

        {error && (
          <div
            role="alert"
            className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
          >
            {error}
          </div>
        )}

        {needsSetup && !issuedKey && (
          <form onSubmit={handleSetupSubmit} className="space-y-5">
            <div>
              <label
                htmlFor="admin-label"
                className="block text-sm font-medium text-slate-700 mb-1.5"
              >
                Global Admin Label
              </label>
              <input
                id="admin-label"
                type="text"
                required
                value={adminLabel}
                onChange={(e) => setAdminLabel(e.target.value)}
                placeholder="e.g. platform@company.com"
                className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-blue-600"
              />
              <p className="mt-1.5 text-xs text-slate-500">
                Used strictly for access key identification and usage attribution.
              </p>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60 transition-colors whitespace-nowrap"
            >
              <ShieldCheck className="w-4 h-4" />
              {loading ? 'Generating Key...' : 'Create Global Admin Key'}
            </button>
          </form>
        )}

        {issuedKey && (
          <div className="space-y-5">
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
              <div className="text-xs font-medium text-slate-500 mb-1.5">
                One-Time Bearer Key · global_admin
              </div>
              <code className="block break-all font-mono text-xs text-slate-900 select-all">
                {issuedKey}
              </code>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={handleCopyKey}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap"
              >
                {copied ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
                {copied ? 'Copied' : 'Copy Key'}
              </button>
              <button
                type="button"
                onClick={handleDownloadBackup}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap"
              >
                <Download className="w-4 h-4" />
                Download Backup
              </button>
            </div>

            <div className="pt-2 border-t border-slate-200">
              <button
                type="button"
                onClick={handleContinueWithIssuedKey}
                disabled={loading}
                className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60 transition-colors whitespace-nowrap"
              >
                {loading ? 'Authenticating...' : 'Enter Nawah AI Console'}
              </button>
            </div>
          </div>
        )}

        {!needsSetup && !issuedKey && (
          <form onSubmit={handleSignInSubmit} className="space-y-5">
            <div>
              <label
                htmlFor="access-key"
                className="block text-sm font-medium text-slate-700 mb-1.5"
              >
                Access Key
              </label>
              <input
                id="access-key"
                type="password"
                required
                autoFocus
                value={accessKeyInput}
                onChange={(e) => setAccessKeyInput(e.target.value)}
                placeholder="nawah_gadm_..."
                className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 font-mono text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-blue-600"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60 transition-colors whitespace-nowrap"
            >
              <KeyRound className="w-4 h-4" />
              {loading ? 'Verifying Key...' : 'Sign In'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
