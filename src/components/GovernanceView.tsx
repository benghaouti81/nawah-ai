import { useEffect, useState, type FormEvent } from 'react';
import { Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { api, ApiError, type SessionInfo } from '../lib/api';
import {
  MCP_TRANSPORTS,
  type DepartmentDto,
  type McpServerDto,
  type McpTransport,
  type ProviderDto,
} from '../shared/types';

interface GovernanceViewProps {
  session: SessionInfo;
}

export function GovernanceView({ session }: GovernanceViewProps) {
  const [departments, setDepartments] = useState<DepartmentDto[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerDto[]>([]);
  const [providers, setProviders] = useState<ProviderDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [discoveringId, setDiscoveringId] = useState<string | null>(null);

  // Create Department
  const [showCreateDept, setShowCreateDept] = useState(false);
  const [deptName, setDeptName] = useState('');
  const [deptSlug, setDeptSlug] = useState('');
  const [deptThreshold, setDeptThreshold] = useState('100');

  // Edit Department Guardrails / Threshold
  const [editingDept, setEditingDept] = useState<DepartmentDto | null>(null);
  const [editThreshold, setEditThreshold] = useState('0');
  const [editAllowedModels, setEditAllowedModels] = useState<string[]>([]);
  const [editAllowedMcps, setEditAllowedMcps] = useState<string[]>([]);

  // Create MCP Server (global_admin only)
  const [showCreateMcp, setShowCreateMcp] = useState(false);
  const [mcpName, setMcpName] = useState('');
  const [mcpSlug, setMcpSlug] = useState('');
  const [mcpTransport, setMcpTransport] = useState<McpTransport>('streamable_http');
  const [mcpEndpoint, setMcpEndpoint] = useState('');
  const [mcpHeadersJson, setMcpHeadersJson] = useState('');

  const isGlobalAdmin = session.role === 'global_admin';

  async function loadAll() {
    setLoading(true);
    setError(null);
    try {
      const [depts, mcps, provs] = await Promise.all([
        api.getDepartments(),
        api.getMcpServers(),
        api.getProviders(),
      ]);
      setDepartments(depts);
      setMcpServers(mcps);
      setProviders(provs);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load governance data');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadAll();
  }, []);

  const allModels = providers.flatMap((p) =>
    p.models.map((m) => ({
      id: m.id,
      label: `${p.name} · ${m.modelId}`,
    })),
  );

  async function handleCreateDept(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.createDepartment({
        name: deptName.trim(),
        slug: deptSlug.trim().toLowerCase(),
        monthlyAlertThresholdUsd: Number(deptThreshold) || 0,
        allowedModelIds: [],
        allowedMcpServerIds: [],
      });
      setShowCreateDept(false);
      setDeptName('');
      setDeptSlug('');
      setDeptThreshold('100');
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create department');
    }
  }

  function openEditDept(d: DepartmentDto) {
    setEditingDept(d);
    setEditThreshold(String(d.monthlyAlertThresholdUsd));
    setEditAllowedModels(d.allowedModelIds);
    setEditAllowedMcps(d.allowedMcpServerIds);
  }

  async function handleSaveDept(e: FormEvent) {
    e.preventDefault();
    if (!editingDept) return;
    setError(null);
    try {
      if (isGlobalAdmin) {
        await api.updateDepartment(editingDept.id, {
          monthlyAlertThresholdUsd: Number(editThreshold) || 0,
          allowedModelIds: editAllowedModels,
          allowedMcpServerIds: editAllowedMcps,
        });
      } else {
        await api.updateDepartment(editingDept.id, {
          monthlyAlertThresholdUsd: Number(editThreshold) || 0,
        });
      }
      setEditingDept(null);
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update department');
    }
  }

  async function handleCreateMcp(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api.createMcpServer({
        name: mcpName.trim(),
        slug: mcpSlug.trim().toLowerCase(),
        transport: mcpTransport,
        endpointOrCommand: mcpEndpoint.trim(),
        authHeadersJson: mcpHeadersJson.trim() || null,
      });
      setShowCreateMcp(false);
      setMcpName('');
      setMcpSlug('');
      setMcpEndpoint('');
      setMcpHeadersJson('');
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to register MCP server');
    }
  }

  async function handleDiscoverTools(id: string) {
    setDiscoveringId(id);
    setError(null);
    try {
      await api.discoverMcpTools(id);
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'MCP tool discovery failed');
    } finally {
      setDiscoveringId(null);
    }
  }

  return (
    <div className="space-y-10">
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Departments Section */}
      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold text-slate-900">
              Departments &amp; Boundary Guardrails
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Define monthly spending alert thresholds and constrain which models and MCP servers each department may bind to its agents.
            </p>
          </div>
          {isGlobalAdmin && (
            <button
              type="button"
              onClick={() => setShowCreateDept(true)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-700 whitespace-nowrap"
            >
              <Plus className="w-3.5 h-3.5" />
              New Department
            </button>
          )}
        </div>

        {!loading && departments.length === 0 ? (
          <div className="rounded-xl border border-slate-200 bg-white px-6 py-10 text-center">
            <h3 className="text-sm font-semibold text-slate-900">
              No Departments Created
            </h3>
            <p className="mt-1 text-sm text-slate-600">
              Create your first engineering or product department to organize agents and spending thresholds.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {departments.map((dept) => (
              <div
                key={dept.id}
                className="rounded-xl border border-slate-200 bg-white p-5 flex flex-col justify-between"
              >
                <div>
                  <div className="text-xs font-mono text-slate-500">
                    {dept.slug} · Alert threshold ${dept.monthlyAlertThresholdUsd.toFixed(2)}/mo
                  </div>
                  <h3 className="mt-1 text-base font-semibold text-slate-900">
                    {dept.name}
                  </h3>
                  <div className="mt-3 space-y-1 text-xs text-slate-600">
                    <div>
                      Allowed models:{' '}
                      <span className="font-mono text-slate-800">
                        {dept.allowedModelIds.length === 0
                          ? 'All active workspace models'
                          : `${dept.allowedModelIds.length} restricted model(s)`}
                      </span>
                    </div>
                    <div>
                      Permitted MCP servers:{' '}
                      <span className="font-mono text-slate-800">
                        {dept.allowedMcpServerIds.length === 0
                          ? 'None permitted'
                          : `${dept.allowedMcpServerIds.length} server(s)`}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between">
                  <button
                    type="button"
                    onClick={() => openEditDept(dept)}
                    className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                  >
                    {isGlobalAdmin ? 'Edit Guardrails & Threshold' : 'Edit Alert Threshold'}
                  </button>
                  {isGlobalAdmin && (
                    <button
                      type="button"
                      onClick={() =>
                        api.deleteDepartment(dept.id).then(loadAll).catch((e) => setError(e.message))
                      }
                      className="p-1.5 text-slate-400 hover:text-red-600"
                      aria-label={`Delete ${dept.name}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* MCP Servers Section */}
      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold text-slate-900">
              MCP Tool Servers (@modelcontextprotocol/sdk)
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Connect real company MCP servers via Streamable HTTP, SSE, or stdio (stdio restricted strictly to global_admin).
            </p>
          </div>
          {isGlobalAdmin && (
            <button
              type="button"
              onClick={() => setShowCreateMcp(true)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-700 whitespace-nowrap"
            >
              <Plus className="w-3.5 h-3.5" />
              Register MCP Server
            </button>
          )}
        </div>

        {!loading && mcpServers.length === 0 ? (
          <div className="rounded-xl border border-slate-200 bg-white px-6 py-10 text-center">
            <h3 className="text-sm font-semibold text-slate-900">
              No MCP Servers Registered
            </h3>
            <p className="mt-1 text-sm text-slate-600">
              {isGlobalAdmin
                ? 'Register an MCP server to discover live tools and expose read-only subsets to department agents.'
                : 'No MCP servers have been granted to your department by a Global Admin.'}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {mcpServers.map((srv) => (
              <div
                key={srv.id}
                className="rounded-xl border border-slate-200 bg-white overflow-hidden"
              >
                <div className="px-6 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <div className="text-xs font-mono text-slate-500">
                      {srv.slug} · {srv.transport} · {srv.endpointOrCommand}
                    </div>
                    <h3 className="mt-1 text-base font-semibold text-slate-900">
                      {srv.name}
                    </h3>
                  </div>

                  {isGlobalAdmin && (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={discoveringId === srv.id}
                        onClick={() => handleDiscoverTools(srv.id)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                      >
                        <RefreshCw
                          className={`w-3.5 h-3.5 ${
                            discoveringId === srv.id ? 'animate-spin' : ''
                          }`}
                        />
                        {discoveringId === srv.id ? 'Discovering...' : 'Discover Tools'}
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          api.deleteMcpServer(srv.id).then(loadAll).catch((e) => setError(e.message))
                        }
                        className="p-1.5 text-slate-400 hover:text-red-600"
                        aria-label={`Delete ${srv.name}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                </div>

                <div className="px-6 py-4">
                  {srv.discoveredTools.length === 0 ? (
                    <p className="text-xs text-slate-500">
                      No tools cached yet. Run Discover Tools to query the live MCP server.
                    </p>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {srv.discoveredTools.map((t) => (
                        <div
                          key={t.name}
                          className="rounded-lg border border-slate-200 bg-slate-50 p-3"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-mono text-xs font-semibold text-slate-900">
                              {t.name}
                            </span>
                            <span className="text-xs text-slate-500">
                              {t.annotations?.readOnlyHint === false
                                ? 'Mutating'
                                : 'Read-only / Unmarked'}
                            </span>
                          </div>
                          {t.description && (
                            <p className="mt-1 text-xs text-slate-600">
                              {t.description}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Create Department Modal */}
      {showCreateDept && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-semibold text-slate-900">
                Create Department
              </h3>
              <button
                type="button"
                onClick={() => setShowCreateDept(false)}
                className="p-1 text-slate-500 hover:text-slate-900"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleCreateDept} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Department Name
                </label>
                <input
                  type="text"
                  required
                  value={deptName}
                  onChange={(e) => {
                    const val = e.target.value;
                    setDeptName(val);
                    if (!deptSlug) {
                      setDeptSlug(
                        val
                          .toLowerCase()
                          .replace(/[^a-z0-9]+/g, '-')
                          .replace(/^-|-$/g, ''),
                      );
                    }
                  }}
                  placeholder="Platform Engineering"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Slug
                </label>
                <input
                  type="text"
                  required
                  pattern="[a-z0-9-]+"
                  value={deptSlug}
                  onChange={(e) => setDeptSlug(e.target.value.toLowerCase())}
                  placeholder="platform-eng"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Monthly Alert Threshold (USD, 0 = disabled)
                </label>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={deptThreshold}
                  onChange={(e) => setDeptThreshold(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
                />
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCreateDept(false)}
                  className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-medium text-slate-700"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-700"
                >
                  Create Department
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Department Guardrails Modal */}
      {editingDept && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-semibold text-slate-900">
                {editingDept.name} · Settings
              </h3>
              <button
                type="button"
                onClick={() => setEditingDept(null)}
                className="p-1 text-slate-500 hover:text-slate-900"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleSaveDept} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Monthly Alert Threshold (USD, non-blocking)
                </label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={editThreshold}
                  onChange={(e) => setEditThreshold(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
                />
              </div>

              {isGlobalAdmin && (
                <>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Allowed Models (leave all unchecked to allow any active model)
                    </label>
                    <div className="max-h-36 overflow-auto rounded-lg border border-slate-200 p-2.5 space-y-1.5">
                      {allModels.length === 0 ? (
                        <div className="text-xs text-slate-500">
                          No provider models registered yet.
                        </div>
                      ) : (
                        allModels.map((m) => (
                          <label
                            key={m.id}
                            className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer"
                          >
                            <input
                              type="checkbox"
                              checked={editAllowedModels.includes(m.id)}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setEditAllowedModels((prev) => [...prev, m.id]);
                                } else {
                                  setEditAllowedModels((prev) =>
                                    prev.filter((x) => x !== m.id),
                                  );
                                }
                              }}
                              className="rounded border-slate-300 text-blue-600"
                            />
                            <span>{m.label}</span>
                          </label>
                        ))
                      )}
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Permitted MCP Servers
                    </label>
                    <div className="max-h-36 overflow-auto rounded-lg border border-slate-200 p-2.5 space-y-1.5">
                      {mcpServers.length === 0 ? (
                        <div className="text-xs text-slate-500">
                          No MCP servers registered yet.
                        </div>
                      ) : (
                        mcpServers.map((s) => (
                          <label
                            key={s.id}
                            className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer"
                          >
                            <input
                              type="checkbox"
                              checked={editAllowedMcps.includes(s.id)}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setEditAllowedMcps((prev) => [...prev, s.id]);
                                } else {
                                  setEditAllowedMcps((prev) =>
                                    prev.filter((x) => x !== s.id),
                                  );
                                }
                              }}
                              className="rounded border-slate-300 text-blue-600"
                            />
                            <span>
                              {s.name} ({s.transport})
                            </span>
                          </label>
                        ))
                      )}
                    </div>
                  </div>
                </>
              )}

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setEditingDept(null)}
                  className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-medium text-slate-700"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-700"
                >
                  Save Settings
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Create MCP Server Modal */}
      {showCreateMcp && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-semibold text-slate-900">
                Register MCP Server
              </h3>
              <button
                type="button"
                onClick={() => setShowCreateMcp(false)}
                className="p-1 text-slate-500 hover:text-slate-900"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleCreateMcp} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Server Name
                </label>
                <input
                  type="text"
                  required
                  value={mcpName}
                  onChange={(e) => setMcpName(e.target.value)}
                  placeholder="Git Repository MCP"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Slug
                  </label>
                  <input
                    type="text"
                    required
                    pattern="[a-z0-9-]+"
                    value={mcpSlug}
                    onChange={(e) => setMcpSlug(e.target.value.toLowerCase())}
                    placeholder="git-mcp"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Transport
                  </label>
                  <select
                    value={mcpTransport}
                    onChange={(e) => setMcpTransport(e.target.value as McpTransport)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                  >
                    {MCP_TRANSPORTS.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {mcpTransport === 'stdio' ? 'Executable Command & Args' : 'Endpoint URL'}
                </label>
                <input
                  type="text"
                  required
                  value={mcpEndpoint}
                  onChange={(e) => setMcpEndpoint(e.target.value)}
                  placeholder={
                    mcpTransport === 'stdio'
                      ? 'npx -y @modelcontextprotocol/server-git --repository /repo'
                      : 'https://mcp.internal.company.com/mcp'
                  }
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs"
                />
              </div>
              {mcpTransport !== 'stdio' && (
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Auth Headers JSON (optional, encrypted with AES-256-GCM)
                  </label>
                  <input
                    type="text"
                    value={mcpHeadersJson}
                    onChange={(e) => setMcpHeadersJson(e.target.value)}
                    placeholder='{"Authorization": "Bearer ..."}'
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs"
                  />
                </div>
              )}
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCreateMcp(false)}
                  className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-medium text-slate-700"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-700"
                >
                  Register Server
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
