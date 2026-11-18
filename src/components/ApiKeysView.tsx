import { useEffect, useState, type FormEvent } from 'react';
import { Check, Copy, Plus, Trash2, X } from 'lucide-react';
import { api, ApiError, type SessionInfo } from '../lib/api';
import { ROLES, type AgentDto, type ApiKeyDto, type DepartmentDto, type Role } from '../shared/types';

interface ApiKeysViewProps {
  session: SessionInfo;
}

export function ApiKeysView({ session }: ApiKeysViewProps) {
  const [keys, setKeys] = useState<ApiKeyDto[]>([]);
  const [departments, setDepartments] = useState<DepartmentDto[]>([]);
  const [agents, setAgents] = useState<AgentDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [showCreate, setShowCreate] = useState(false);
  const [userLabel, setUserLabel] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [departmentId, setDepartmentId] = useState('');
  const [allowedAgentIds, setAllowedAgentIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  async function loadAll() {
    setLoading(true);
    setError(null);
    try {
      const [ks, depts, ags] = await Promise.all([
        api.getApiKeys(),
        api.getDepartments(),
        api.getAgents(),
      ]);
      setKeys(ks);
      setDepartments(depts);
      setAgents(ags);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load access keys');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadAll();
  }, []);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.createApiKey({
        userLabel: userLabel.trim(),
        role,
        departmentId: departmentId || null,
        allowedAgentIds,
      });
      setRevealedKey(res.rawKey);
      setShowCreate(false);
      setUserLabel('');
      setRole('member');
      setDepartmentId('');
      setAllowedAgentIds([]);
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to issue access key');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleToggle(k: ApiKeyDto) {
    setError(null);
    try {
      await api.updateApiKey(k.id, { isActive: !k.isActive });
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update access key');
    }
  }

  async function handleDelete(k: ApiKeyDto) {
    setError(null);
    try {
      await api.deleteApiKey(k.id);
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete access key');
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">
            Access Keys &amp; RBAC Credentials
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Issue SHA-256 hashed Bearer keys for IDE tools, webhooks, and department admins. Keys exist strictly for access control and cost attribution.
          </p>
        </div>

        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-700 whitespace-nowrap"
        >
          <Plus className="w-3.5 h-3.5" />
          Issue Access Key
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {revealedKey && (
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-5 space-y-3">
          <div className="flex items-center justify-between gap-4">
            <div className="text-sm font-semibold text-slate-900">
              One-Time Access Key Issued — Copy Now
            </div>
            <button
              type="button"
              onClick={() => setRevealedKey(null)}
              className="text-xs text-slate-600 hover:text-slate-900"
            >
              Dismiss
            </button>
          </div>
          <code className="block rounded-lg border border-blue-200 bg-white px-3.5 py-2.5 font-mono text-xs text-slate-900 select-all break-all">
            {revealedKey}
          </code>
          <button
            type="button"
            onClick={() => {
              navigator.clipboard.writeText(revealedKey);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? 'Copied' : 'Copy Bearer Key'}
          </button>
        </div>
      )}

      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 font-medium text-slate-500">
                <th className="px-5 py-3">User Label</th>
                <th className="px-4 py-3">Key Prefix</th>
                <th className="px-4 py-3">Role</th>
                <th className="px-4 py-3">Department</th>
                <th className="px-4 py-3">Agent Scope</th>
                <th className="px-4 py-3">Last Used</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-5 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={8} className="px-5 py-8 text-center text-slate-500">
                    Loading access keys...
                  </td>
                </tr>
              ) : (
                keys.map((k) => {
                  const isSelf = k.id === session.keyId;
                  return (
                    <tr key={k.id} className="hover:bg-slate-50">
                      <td className="px-5 py-3 font-medium text-slate-900">
                        {k.userLabel}
                        {isSelf && (
                          <span className="ml-2 font-mono text-blue-600">
                            (current session)
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 font-mono text-slate-600">
                        {k.keyPrefix}
                      </td>
                      <td className="px-4 py-3 font-mono text-slate-800">{k.role}</td>
                      <td className="px-4 py-3 text-slate-600">
                        {k.departmentName || 'Workspace-wide'}
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        {k.allowedAgentIds.length === 0
                          ? 'Dept default'
                          : `${k.allowedAgentIds.length} agent(s)`}
                      </td>
                      <td className="px-4 py-3 font-mono tabular-nums text-slate-500 whitespace-nowrap">
                        {k.lastUsedAt
                          ? new Date(k.lastUsedAt).toLocaleString()
                          : 'Never'}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={
                            k.isActive ? 'text-emerald-700' : 'text-red-700'
                          }
                        >
                          {k.isActive ? 'Active' : 'Revoked'}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-right whitespace-nowrap space-x-3">
                        {!isSelf && (
                          <>
                            <button
                              type="button"
                              onClick={() => handleToggle(k)}
                              className="text-slate-700 hover:underline"
                            >
                              {k.isActive ? 'Revoke' : 'Restore'}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDelete(k)}
                              className="text-red-600 hover:text-red-800 inline-flex items-center"
                              aria-label={`Delete key for ${k.userLabel}`}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Issue Key Modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-semibold text-slate-900">
                Issue Access Key
              </h3>
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                className="p-1 text-slate-500 hover:text-slate-900"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  User or Tool Label
                </label>
                <input
                  type="text"
                  required
                  value={userLabel}
                  onChange={(e) => setUserLabel(e.target.value)}
                  placeholder="ahmad@company.com or ci-pr-bot"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Role
                  </label>
                  <select
                    value={role}
                    onChange={(e) => setRole(e.target.value as Role)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Department {role === 'department_admin' ? '(required)' : '(optional)'}
                  </label>
                  <select
                    required={role === 'department_admin'}
                    value={departmentId}
                    onChange={(e) => setDepartmentId(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                  >
                    <option value="">Workspace-wide</option>
                    {departments.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {agents.length > 0 && (
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Allowed Agents Override (leave unchecked for role/dept default)
                  </label>
                  <div className="max-h-32 overflow-auto rounded-lg border border-slate-200 p-2.5 space-y-1.5">
                    {agents.map((ag) => (
                      <label
                        key={ag.id}
                        className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={allowedAgentIds.includes(ag.id)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setAllowedAgentIds((prev) => [...prev, ag.id]);
                            } else {
                              setAllowedAgentIds((prev) =>
                                prev.filter((id) => id !== ag.id),
                              );
                            }
                          }}
                          className="rounded border-slate-300 text-blue-600"
                        />
                        <span className="font-mono">agent/{ag.slug}</span>
                        <span className="text-slate-500">({ag.departmentName})</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCreate(false)}
                  className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-medium text-slate-700"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-700"
                >
                  {submitting ? 'Issuing...' : 'Issue Key'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
