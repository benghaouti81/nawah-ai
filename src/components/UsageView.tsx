import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, RefreshCw, Search, XCircle } from 'lucide-react';
import { api, ApiError, type SessionInfo } from '../lib/api';
import type {
  SpendingAlertDto,
  UsageLogDto,
  UsageSummaryDto,
} from '../shared/types';

interface UsageViewProps {
  session: SessionInfo;
  onNavigate: (tab: string) => void;
}

function formatUsd(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return 'Unavailable';
  if (amount === 0) return '$0.00';
  if (amount < 0.01) return `$${amount.toFixed(6)}`;
  return `$${amount.toFixed(4)}`;
}

function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return 'Unavailable';
  return n.toLocaleString('en-US');
}

export function UsageView({ session, onNavigate }: UsageViewProps) {
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<UsageSummaryDto | null>(null);
  const [logs, setLogs] = useState<UsageLogDto[]>([]);
  const [alerts, setAlerts] = useState<SpendingAlertDto[]>([]);

  const [statusFilter, setStatusFilter] = useState<'all' | 'success' | 'failed'>('all');
  const [search, setSearch] = useState('');

  async function loadUsage(windowDays = days) {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getUsage(windowDays);
      setSummary(data.summary);
      setLogs(data.logs);
      setAlerts(data.alerts);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load usage metrics');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadUsage(days);
  }, [days]);

  async function handleAcknowledge(alertId: string) {
    try {
      await api.acknowledgeAlert(alertId);
      setAlerts((prev) =>
        prev.map((a) => (a.id === alertId ? { ...a, acknowledged: true } : a)),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to acknowledge alert');
    }
  }

  const filteredLogs = logs.filter((log) => {
    if (statusFilter !== 'all' && log.status !== statusFilter) return false;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      return (
        log.userLabel.toLowerCase().includes(q) ||
        log.modelUsed.toLowerCase().includes(q) ||
        log.providerType.toLowerCase().includes(q) ||
        (log.agentSlug || '').toLowerCase().includes(q) ||
        (log.departmentName || '').toLowerCase().includes(q) ||
        (log.errorMessage || '').toLowerCase().includes(q)
      );
    }
    return true;
  });

  const canAckAlerts =
    session.role === 'global_admin' || session.role === 'department_admin';

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">
            Post-Execution Usage &amp; Calculated Cost Overview
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Provider-reported token consumption and costs calculated from configured model pricing (not provider billing invoices).
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 p-1 bg-slate-100 border border-slate-200 rounded-lg">
            {[7, 30, 90].map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDays(d)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                  days === d
                    ? 'bg-white text-slate-900 border border-slate-200'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Last {d}d
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => loadUsage(days)}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {alerts.filter((a) => !a.acknowledged).length > 0 && (
        <div className="space-y-3">
          {alerts
            .filter((a) => !a.acknowledged)
            .map((alert) => (
              <div
                key={alert.id}
                className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-amber-200 bg-amber-50 px-5 py-4"
              >
                <div className="flex items-start gap-3">
                  <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                  <div>
                    <div className="text-sm font-semibold text-slate-900">
                      Monthly Calculated Cost Threshold Reached · {alert.departmentName}
                    </div>
                    <p className="mt-0.5 text-xs text-slate-700 font-mono tabular-nums">
                      Period {alert.periodMonth} · Calculated {formatUsd(alert.calculatedSpentUsd)} / Threshold {formatUsd(alert.thresholdUsd)} (non-blocking)
                    </p>
                  </div>
                </div>
                {canAckAlerts && (
                  <button
                    type="button"
                    onClick={() => handleAcknowledge(alert.id)}
                    className="rounded-lg border border-amber-300 bg-white px-3.5 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-100 transition-colors whitespace-nowrap"
                  >
                    Acknowledge
                  </button>
                )}
              </div>
            ))}
        </div>
      )}

      {/* 4-Column Metric Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {loading && !summary ? (
          Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-24 rounded-xl border border-slate-200 bg-white p-5 animate-pulse"
            />
          ))
        ) : (
          <>
            <div className="rounded-xl border border-slate-200 bg-white p-5">
              <div className="text-xs font-medium text-slate-500">Calculated Cost</div>
              <div className="mt-2 text-2xl font-bold font-mono tabular-nums text-slate-900">
                {formatUsd(summary ? summary.totalCalculatedCostUsd : 0)}
              </div>
              <div className="mt-1 text-xs text-slate-500">
                From configured model pricing ({days}d)
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-5">
              <div className="text-xs font-medium text-slate-500">Requests</div>
              <div className="mt-2 text-2xl font-bold font-mono tabular-nums text-slate-900">
                {formatNumber(summary?.totalRequests ?? 0)}
              </div>
              <div className="mt-1 text-xs text-slate-600 font-mono tabular-nums">
                {formatNumber(summary?.successfulRequests ?? 0)} ok ·{' '}
                {formatNumber(summary?.failedRequests ?? 0)} failed
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-5">
              <div className="text-xs font-medium text-slate-500">Input Tokens</div>
              <div className="mt-2 text-2xl font-bold font-mono tabular-nums text-slate-900">
                {formatNumber(summary ? summary.totalInputTokens : 0)}
              </div>
              <div className="mt-1 text-xs text-slate-500">
                {(summary?.unavailableUsageRequests ?? 0) > 0
                  ? `${formatNumber(summary?.unavailableUsageRequests)} without usage data`
                  : 'Reported by upstream providers'}
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-5">
              <div className="text-xs font-medium text-slate-500">Output Tokens</div>
              <div className="mt-2 text-2xl font-bold font-mono tabular-nums text-slate-900">
                {formatNumber(summary ? summary.totalOutputTokens : 0)}
              </div>
              <div className="mt-1 text-xs text-slate-500">
                Generated completion tokens
              </div>
            </div>
          </>
        )}
      </div>

      {/* Breakdown Grids */}
      {summary && summary.totalRequests > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200">
              <h3 className="text-sm font-semibold text-slate-900">
                Usage by Department
              </h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
                    <th className="px-5 py-2.5">Department</th>
                    <th className="px-4 py-2.5 text-right">Requests</th>
                    <th className="px-4 py-2.5 text-right">Threshold</th>
                    <th className="px-5 py-2.5 text-right">Calculated Cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {summary.byDepartment.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-5 py-6 text-center text-xs text-slate-500">
                        No department usage recorded yet.
                      </td>
                    </tr>
                  ) : (
                    summary.byDepartment.map((d) => (
                      <tr key={d.departmentId} className="hover:bg-slate-50">
                        <td className="px-5 py-2.5 font-medium text-slate-900">
                          {d.departmentName}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-600">
                          {formatNumber(d.requests)}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-500">
                          {d.thresholdUsd > 0 ? formatUsd(d.thresholdUsd) : 'None'}
                        </td>
                        <td className="px-5 py-2.5 text-right font-mono tabular-nums font-medium text-slate-900">
                          {formatUsd(d.calculatedCostUsd)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200">
              <h3 className="text-sm font-semibold text-slate-900">
                Usage by Agent
              </h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
                    <th className="px-5 py-2.5">Agent</th>
                    <th className="px-4 py-2.5 text-right">Requests</th>
                    <th className="px-4 py-2.5 text-right">Tokens</th>
                    <th className="px-5 py-2.5 text-right">Calculated Cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {summary.byAgent.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-5 py-6 text-center text-xs text-slate-500">
                        No agent invocations recorded yet.
                      </td>
                    </tr>
                  ) : (
                    summary.byAgent.map((a) => (
                      <tr key={a.agentId} className="hover:bg-slate-50">
                        <td className="px-5 py-2.5">
                          <div className="font-medium text-slate-900">{a.agentName}</div>
                          <div className="text-xs font-mono text-slate-500">
                            agent/{a.agentSlug}
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-600">
                          {formatNumber(a.requests)}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-600">
                          {formatNumber(a.tokens)}
                        </td>
                        <td className="px-5 py-2.5 text-right font-mono tabular-nums font-medium text-slate-900">
                          {formatUsd(a.calculatedCostUsd)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200">
              <h3 className="text-sm font-semibold text-slate-900">
                Usage by Provider
              </h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
                    <th className="px-5 py-2.5">Provider</th>
                    <th className="px-4 py-2.5 text-right">Requests</th>
                    <th className="px-4 py-2.5 text-right">In / Out Tokens</th>
                    <th className="px-5 py-2.5 text-right">Calculated Cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {summary.byProvider.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-5 py-6 text-center text-xs text-slate-500">
                        No provider usage recorded yet.
                      </td>
                    </tr>
                  ) : (
                    summary.byProvider.map((p) => (
                      <tr key={p.providerType} className="hover:bg-slate-50">
                        <td className="px-5 py-2.5 font-mono text-xs font-medium text-slate-900">
                          {p.providerType}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-600">
                          {formatNumber(p.requests)}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-600 whitespace-nowrap">
                          {p.inputTokens === null || p.outputTokens === null
                            ? 'Unavailable'
                            : `${formatNumber(p.inputTokens)} / ${formatNumber(p.outputTokens)}`}
                        </td>
                        <td className="px-5 py-2.5 text-right font-mono tabular-nums font-medium text-slate-900">
                          {formatUsd(p.calculatedCostUsd)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200">
              <h3 className="text-sm font-semibold text-slate-900">
                Usage by Model
              </h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
                    <th className="px-5 py-2.5">Provider · Model</th>
                    <th className="px-4 py-2.5 text-right">Requests</th>
                    <th className="px-4 py-2.5 text-right">In / Out Tokens</th>
                    <th className="px-5 py-2.5 text-right">Calculated Cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {summary.byModel.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-5 py-6 text-center text-xs text-slate-500">
                        No model usage recorded yet.
                      </td>
                    </tr>
                  ) : (
                    summary.byModel.map((m) => (
                      <tr key={`${m.providerType}:${m.modelUsed}`} className="hover:bg-slate-50">
                        <td className="px-5 py-2.5">
                          <div className="font-mono text-xs font-medium text-slate-900">
                            {m.modelUsed}
                          </div>
                          <div className="text-xs font-mono text-slate-500">
                            {m.providerType}
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-600">
                          {formatNumber(m.requests)}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-600 whitespace-nowrap">
                          {m.inputTokens === null || m.outputTokens === null
                            ? 'Unavailable'
                            : `${formatNumber(m.inputTokens)} / ${formatNumber(m.outputTokens)}`}
                        </td>
                        <td className="px-5 py-2.5 text-right font-mono tabular-nums font-medium text-slate-900">
                          {formatUsd(m.calculatedCostUsd)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white overflow-hidden lg:col-span-2">
            <div className="px-5 py-4 border-b border-slate-200">
              <h3 className="text-sm font-semibold text-slate-900">
                Usage by User
              </h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
                    <th className="px-5 py-2.5">User</th>
                    <th className="px-4 py-2.5 text-right">Requests</th>
                    <th className="px-4 py-2.5 text-right">Tokens</th>
                    <th className="px-5 py-2.5 text-right">Calculated Cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {summary.byUser.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-5 py-6 text-center text-xs text-slate-500">
                        No user usage recorded yet.
                      </td>
                    </tr>
                  ) : (
                    summary.byUser.map((u) => (
                      <tr key={u.userLabel} className="hover:bg-slate-50">
                        <td className="px-5 py-2.5 font-medium text-slate-900">
                          {u.userLabel}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-600">
                          {formatNumber(u.requests)}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-600">
                          {formatNumber(u.tokens)}
                        </td>
                        <td className="px-5 py-2.5 text-right font-mono tabular-nums font-medium text-slate-900">
                          {formatUsd(u.calculatedCostUsd)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Execution Logs Table */}
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">
              Execution Ledger
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Immutable post-execution log of model calls, provider-reported token counts, and failures.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter by user, agent, model..."
                className="pl-8 pr-3 py-1.5 rounded-lg border border-slate-200 bg-slate-50 text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:bg-white w-56"
              />
            </div>

            <div className="flex items-center gap-1 p-1 bg-slate-100 border border-slate-200 rounded-lg">
              {(['all', 'success', 'failed'] as const).map((st) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => setStatusFilter(st)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md capitalize transition-colors whitespace-nowrap ${
                    statusFilter === st
                      ? 'bg-white text-slate-900 border border-slate-200'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {st}
                </button>
              ))}
            </div>
          </div>
        </div>

        {!loading && filteredLogs.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <h4 className="text-sm font-semibold text-slate-900">
              No Execution Records Yet
            </h4>
            <p className="mt-1.5 text-sm text-slate-600 max-w-md mx-auto">
              This workspace starts clean with zero simulated metrics. Configure an external provider, install a department agent, and run a live prompt to see real accounting here.
            </p>
            <div className="mt-5 flex items-center justify-center gap-3">
              {session.role === 'global_admin' && (
                <button
                  type="button"
                  onClick={() => onNavigate('providers')}
                  className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap"
                >
                  Configure Providers
                </button>
              )}
              <button
                type="button"
                onClick={() => onNavigate('chat')}
                className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-700 transition-colors whitespace-nowrap"
              >
                Open Test Chat
              </button>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 font-medium text-slate-500">
                  <th className="px-5 py-2.5">Timestamp</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5">User · Department</th>
                  <th className="px-4 py-2.5">Agent · Upstream Model</th>
                  <th className="px-4 py-2.5 text-right">In / Out Tokens</th>
                  <th className="px-4 py-2.5 text-right">Latency</th>
                  <th className="px-5 py-2.5 text-right">Calculated Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-slate-50 align-top">
                    <td className="px-5 py-3 font-mono tabular-nums text-slate-500 whitespace-nowrap">
                      {new Date(log.createdAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {log.status === 'success' ? (
                        <span className="inline-flex items-center gap-1.5 font-medium text-emerald-700">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          Success
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 font-medium text-red-700">
                          <XCircle className="w-3.5 h-3.5" />
                          Failed
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-900">{log.userLabel}</div>
                      <div className="text-slate-500">
                        {log.departmentName || 'Unassigned'}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-mono text-slate-900">
                        {log.agentSlug ? `agent/${log.agentSlug}` : 'Unknown'}
                      </div>
                      <div className="text-slate-500 font-mono">
                        {log.providerType} · {log.modelUsed}
                      </div>
                      {log.errorMessage && (
                        <div className="mt-1 text-red-600 max-w-md break-words">
                          {log.errorCode ? `[${log.errorCode}] ` : ''}
                          {log.errorMessage}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-700 whitespace-nowrap">
                      {log.inputTokens === null || log.outputTokens === null
                        ? 'Unavailable'
                        : `${formatNumber(log.inputTokens)} / ${formatNumber(log.outputTokens)}`}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-600 whitespace-nowrap">
                      {formatNumber(log.latencyMs)} ms
                    </td>
                    <td className="px-5 py-3 text-right font-mono tabular-nums font-medium text-slate-900 whitespace-nowrap">
                      {formatUsd(log.calculatedCostUsd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
