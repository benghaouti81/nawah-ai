import { useEffect, useState, type FormEvent } from 'react';
import { Check, Copy, Download, Play } from 'lucide-react';
import { api, ApiError, type SessionInfo } from '../lib/api';
import type { AgentDto } from '../shared/types';

interface DeployViewProps {
  session: SessionInfo;
}

export function DeployView({ session }: DeployViewProps) {
  const [originUrl, setOriginUrl] = useState('');
  const [files, setFiles] = useState<
    Array<{ name: string; category: string; content: string }>
  >([]);
  const [selectedFile, setSelectedFile] = useState('docker-compose.yml');
  const [agents, setAgents] = useState<AgentDto[]>([]);
  const [copied, setCopied] = useState(false);
  const [downloadingZip, setDownloadingZip] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Live Webhook Runner state
  const [webhookMode, setWebhookMode] = useState<'git-pr' | 'slack'>('git-pr');
  const [agentSlug, setAgentSlug] = useState('');
  const [repo, setRepo] = useState('acme/backend-core');
  const [prNumber, setPrNumber] = useState('42');
  const [prTitle, setPrTitle] = useState('Harden SQLite connection lifecycle');
  const [diffText, setDiffText] = useState('');
  const [slackChannel, setSlackChannel] = useState('#platform-eng');
  const [slackText, setSlackText] = useState('');
  const [runningWebhook, setRunningWebhook] = useState(false);
  const [webhookOutput, setWebhookOutput] = useState<{
    content: string;
    usage: {
      inputTokens: number | null;
      outputTokens: number | null;
      calculatedCostUsd: number | null;
      costBasis: string;
      latencyMs: number;
    };
  } | null>(null);

  useEffect(() => {
    Promise.all([api.getDeployFiles(), api.getAgents()])
      .then(([deployRes, ags]) => {
        setOriginUrl(deployRes.originUrl);
        setFiles(deployRes.files);
        if (deployRes.files.length > 0) {
          setSelectedFile(deployRes.files[0].name);
        }
        const active = ags.filter((a) => a.isActive);
        setAgents(active);
        if (active.length > 0) {
          setAgentSlug(active[0].slug);
        }
      })
      .catch((err) => {
        setError(
          err instanceof ApiError ? err.message : 'Failed to load deploy files',
        );
      });
  }, []);

  const currentFile = files.find((f) => f.name === selectedFile);

  function handleCopy() {
    if (!currentFile) return;
    navigator.clipboard.writeText(currentFile.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleDownloadSingle() {
    if (!currentFile) return;
    const blob = new Blob([currentFile.content], {
      type: 'text/plain;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = currentFile.name.split('/').pop() || currentFile.name;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleDownloadBundle() {
    setDownloadingZip(true);
    setError(null);
    try {
      const blob = await api.downloadDeployBundle();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'nawah-deploy-kit.zip';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to download bundle');
    } finally {
      setDownloadingZip(false);
    }
  }

  async function handleRunWebhook(e: FormEvent) {
    e.preventDefault();
    if (!agentSlug) return;
    setRunningWebhook(true);
    setError(null);
    setWebhookOutput(null);
    try {
      if (webhookMode === 'git-pr') {
        const res = await api.testGitPrWebhook({
          agentSlug,
          repository: repo,
          prNumber,
          title: prTitle,
          diff: diffText,
        });
        setWebhookOutput({ content: res.reviewMarkdown, usage: res.usage });
      } else {
        const res = await api.testSlackWebhook({
          agentSlug,
          channel: slackChannel,
          userName: 'engineer',
          text: slackText,
        });
        setWebhookOutput({ content: res.text, usage: res.usage });
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Webhook execution failed');
    } finally {
      setRunningWebhook(false);
    }
  }

  return (
    <div className="space-y-10">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">
            Docker Packaging &amp; Tool Integrations
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Self-host with identical SQLite + Drizzle migrations or connect Continue.dev, Git PR webhooks, and Slack to{' '}
            <code className="font-mono text-xs text-slate-900">{originUrl || '/v1'}</code>.
          </p>
        </div>

        {session.role !== 'member' && (
          <button
            type="button"
            disabled={downloadingZip}
            onClick={handleDownloadBundle}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-60 whitespace-nowrap"
          >
            <Download className="w-3.5 h-3.5" />
            {downloadingZip ? 'Packaging...' : 'Download Deploy Kit (.zip)'}
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Recipe & Docker File Explorer */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-4 rounded-xl border border-slate-200 bg-white overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
            Docker &amp; Integration Files
          </div>
          <div className="divide-y divide-slate-100">
            {files.map((f) => (
              <button
                key={f.name}
                type="button"
                onClick={() => setSelectedFile(f.name)}
                className={`w-full text-left px-4 py-3 text-xs transition-colors ${
                  selectedFile === f.name
                    ? 'bg-blue-50/70 text-blue-700 font-medium'
                    : 'text-slate-700 hover:bg-slate-50'
                }`}
              >
                <div className="font-mono">{f.name}</div>
                <div className="text-[11px] text-slate-500 mt-0.5 capitalize">
                  {f.category}
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="lg:col-span-8 rounded-xl border border-slate-200 bg-white overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between gap-3">
            <span className="font-mono text-xs font-semibold text-slate-900">
              {currentFile?.name || 'Loading...'}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleCopy}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
              <button
                type="button"
                onClick={handleDownloadSingle}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                <Download className="w-3.5 h-3.5" />
                Download
              </button>
            </div>
          </div>
          <pre className="p-5 max-h-[420px] overflow-auto bg-slate-50 font-mono text-xs text-slate-800 whitespace-pre">
            {currentFile?.content || ''}
          </pre>
        </div>
      </div>

      {/* Live Webhook Executor */}
      <div className="rounded-xl border border-slate-200 bg-white p-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h3 className="text-base font-semibold text-slate-900">
              Execute Live Webhook Adapter
            </h3>
            <p className="text-xs text-slate-600 mt-0.5">
              Invokes /api/webhooks/git-pr or /api/webhooks/slack against a real configured agent and logs actual post-execution usage.
            </p>
          </div>

          <div className="flex items-center gap-1 p-1 bg-slate-100 border border-slate-200 rounded-lg">
            <button
              type="button"
              onClick={() => setWebhookMode('git-pr')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap ${
                webhookMode === 'git-pr'
                  ? 'bg-white text-slate-900 border border-slate-200'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Git PR Review
            </button>
            <button
              type="button"
              onClick={() => setWebhookMode('slack')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap ${
                webhookMode === 'slack'
                  ? 'bg-white text-slate-900 border border-slate-200'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Slack Adapter
            </button>
          </div>
        </div>

        <form onSubmit={handleRunWebhook} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Target Agent
              </label>
              <select
                required
                value={agentSlug}
                onChange={(e) => setAgentSlug(e.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs"
              >
                {agents.length === 0 ? (
                  <option value="">No active agents</option>
                ) : (
                  agents.map((a) => (
                    <option key={a.id} value={a.slug}>
                      agent/{a.slug}
                    </option>
                  ))
                )}
              </select>
            </div>

            {webhookMode === 'git-pr' ? (
              <>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Repository
                  </label>
                  <input
                    type="text"
                    required
                    value={repo}
                    onChange={(e) => setRepo(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs"
                  />
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      PR #
                    </label>
                    <input
                      type="text"
                      required
                      value={prNumber}
                      onChange={(e) => setPrNumber(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs"
                    />
                  </div>
                  <div className="col-span-2">
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      PR Title
                    </label>
                    <input
                      type="text"
                      required
                      value={prTitle}
                      onChange={(e) => setPrTitle(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
                    />
                  </div>
                </div>
              </>
            ) : (
              <div className="md:col-span-2">
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Slack Channel
                </label>
                <input
                  type="text"
                  required
                  value={slackChannel}
                  onChange={(e) => setSlackChannel(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs"
                />
              </div>
            )}
          </div>

          {webhookMode === 'git-pr' ? (
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Git Unified Diff
              </label>
              <textarea
                rows={5}
                required
                value={diffText}
                onChange={(e) => setDiffText(e.target.value)}
                placeholder="Paste unified git diff..."
                className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs"
              />
            </div>
          ) : (
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Slack Message Text
              </label>
              <textarea
                rows={4}
                required
                value={slackText}
                onChange={(e) => setSlackText(e.target.value)}
                placeholder="Ask the specialized agent a question from Slack..."
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs"
              />
            </div>
          )}

          <button
            type="submit"
            disabled={runningWebhook || !agentSlug}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap"
          >
            <Play className="w-3.5 h-3.5" />
            {runningWebhook ? 'Executing...' : 'Execute Webhook'}
          </button>
        </form>

        {webhookOutput && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-2">
            <div className="text-xs font-mono tabular-nums text-slate-500">
              {webhookOutput.usage.inputTokens === null || webhookOutput.usage.outputTokens === null
                ? 'usage unavailable'
                : `${webhookOutput.usage.inputTokens} in / ${webhookOutput.usage.outputTokens} out`}{' '}
              ·{' '}
              {webhookOutput.usage.calculatedCostUsd === null
                ? 'cost unavailable'
                : `calc. $${webhookOutput.usage.calculatedCostUsd.toFixed(6)}`}{' '}
              · {webhookOutput.usage.latencyMs} ms
            </div>
            <pre className="text-xs text-slate-900 whitespace-pre-wrap leading-relaxed">
              {webhookOutput.content}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
