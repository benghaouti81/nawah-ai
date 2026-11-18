import { useEffect, useState, type FormEvent } from 'react';
import { Code2, Download, Plus, X } from 'lucide-react';
import { api, ApiError, type SessionInfo } from '../lib/api';
import type {
  DepartmentDto,
  ProviderDto,
  YamlAgentTemplate,
} from '../shared/types';

interface TemplatesViewProps {
  session: SessionInfo;
  onInstalled: () => void;
}

export function TemplatesView({ session, onInstalled }: TemplatesViewProps) {
  const [templates, setTemplates] = useState<YamlAgentTemplate[]>([]);
  const [departments, setDepartments] = useState<DepartmentDto[]>([]);
  const [providers, setProviders] = useState<ProviderDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [inspectYaml, setInspectYaml] = useState<{
    name: string;
    yaml: string;
  } | null>(null);

  const [installTarget, setInstallTarget] = useState<YamlAgentTemplate | null>(null);
  const [deptId, setDeptId] = useState('');
  const [customSlug, setCustomSlug] = useState('');
  const [modelId, setModelId] = useState('');
  const [installing, setInstalling] = useState(false);

  const canInstall =
    session.role === 'global_admin' || session.role === 'department_admin';

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [tpls, depts, provs] = await Promise.all([
          api.getTemplates(),
          api.getDepartments(),
          api.getProviders(),
        ]);
        setTemplates(tpls);
        setDepartments(depts);
        setProviders(provs);
        if (depts.length > 0) {
          setDeptId(depts[0].id);
        }
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Failed to load templates');
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, []);

  async function handleInspect(tpl: YamlAgentTemplate) {
    try {
      const res = await api.getTemplateYaml(tpl.id);
      setInspectYaml({ name: `${tpl.slug}.yaml`, yaml: res.yaml });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to read template YAML');
    }
  }

  function openInstallModal(tpl: YamlAgentTemplate) {
    setInstallTarget(tpl);
    setCustomSlug(tpl.slug);
    setModelId('');
    setError(null);
  }

  const selectedDepartment = departments.find((d) => d.id === deptId);
  const allModels = providers.flatMap((p) =>
    p.models
      .filter((m) => m.isActive && p.isActive)
      .map((m) => ({
        id: m.id,
        label: `${p.name} · ${m.modelId}`,
      })),
  );
  const permittedModels =
    selectedDepartment && selectedDepartment.allowedModelIds.length > 0
      ? allModels.filter((m) => selectedDepartment.allowedModelIds.includes(m.id))
      : allModels;

  async function handleInstallSubmit(e: FormEvent) {
    e.preventDefault();
    if (!installTarget || !deptId) return;
    setInstalling(true);
    setError(null);
    try {
      await api.installTemplate(installTarget.id, {
        departmentId: deptId,
        slug: customSlug.trim() || installTarget.slug,
        modelId: modelId || null,
      });
      setInstallTarget(null);
      onInstalled();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to install template');
    } finally {
      setInstalling(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-slate-900">
          Starter Agent Template Catalog
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          Declarative YAML blueprints loaded from disk. Installing copies the template into your department so customizations remain safe across Core updates.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {canInstall && departments.length === 0 && !loading && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-900">
          Create a department under <strong>Governance &amp; MCP</strong> before installing an agent template.
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-52 rounded-xl border border-slate-200 bg-white p-6 animate-pulse"
            />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {templates.map((tpl) => (
            <div
              key={tpl.id}
              className="rounded-xl border border-slate-200 bg-white p-6 flex flex-col justify-between"
            >
              <div>
                <div className="text-xs font-mono text-slate-500">
                  agent/{tpl.slug} · v{tpl.version} · temp {tpl.temperature}
                </div>
                <h3 className="mt-1.5 text-lg font-semibold text-slate-900">
                  {tpl.name}
                </h3>
                <p className="mt-2 text-sm text-slate-600 leading-relaxed">
                  {tpl.description}
                </p>

                <div className="mt-4 pt-4 border-t border-slate-100 text-xs text-slate-500">
                  Suggested MCP tools:{' '}
                  <span className="font-mono text-slate-700">
                    {tpl.mcp_permissions.allowed_tools.length > 0
                      ? tpl.mcp_permissions.allowed_tools.join(', ')
                      : 'None'}
                  </span>
                  {' · '}
                  <span>{tpl.mcp_permissions.read_only ? 'Read-only' : 'Read/Write'}</span>
                </div>
              </div>

              <div className="mt-5 flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => handleInspect(tpl)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap"
                >
                  <Code2 className="w-3.5 h-3.5" />
                  Inspect YAML
                </button>
                {canInstall && (
                  <button
                    type="button"
                    disabled={departments.length === 0}
                    onClick={() => openInstallModal(tpl)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors whitespace-nowrap"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Install to Department
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Inspect YAML Modal */}
      {inspectYaml && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <div className="w-full max-w-2xl rounded-xl border border-slate-200 bg-white overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
              <div className="font-mono text-sm font-semibold text-slate-900">
                {inspectYaml.name}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const blob = new Blob([inspectYaml.yaml], {
                      type: 'text/yaml;charset=utf-8',
                    });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = inspectYaml.name;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  <Download className="w-3.5 h-3.5" />
                  Download
                </button>
                <button
                  type="button"
                  onClick={() => setInspectYaml(null)}
                  className="p-1.5 text-slate-500 hover:text-slate-900"
                  aria-label="Close YAML preview"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            <pre className="p-6 max-h-[70vh] overflow-auto bg-slate-50 font-mono text-xs text-slate-800 whitespace-pre-wrap">
              {inspectYaml.yaml}
            </pre>
          </div>
        </div>
      )}

      {/* Install Modal */}
      {installTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-semibold text-slate-900">
                Install {installTarget.name}
              </h3>
              <button
                type="button"
                onClick={() => setInstallTarget(null)}
                className="p-1 text-slate-500 hover:text-slate-900"
                aria-label="Close modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleInstallSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Target Department
                </label>
                <select
                  required
                  value={deptId}
                  onChange={(e) => setDeptId(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
                >
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Agent Slug (exposed as agent/&lt;slug&gt;)
                </label>
                <input
                  type="text"
                  required
                  pattern="[a-z0-9-]+"
                  value={customSlug}
                  onChange={(e) => setCustomSlug(e.target.value.toLowerCase())}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Assigned Provider Model (optional now, required before execution)
                </label>
                <select
                  value={modelId}
                  onChange={(e) => setModelId(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
                >
                  <option value="">Unassigned (configure later)</option>
                  {permittedModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="pt-2 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setInstallTarget(null)}
                  className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={installing}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-60 whitespace-nowrap"
                >
                  {installing ? 'Installing...' : 'Install Agent'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
