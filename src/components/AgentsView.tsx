import { useEffect, useState, type FormEvent } from 'react';
import {
  Download,
  History,
  MessageSquare,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { api, ApiError, type SessionInfo } from '../lib/api';
import type {
  AgentDto,
  AgentRevisionDto,
  DepartmentDto,
  McpServerDto,
  ProviderDto,
} from '../shared/types';

interface AgentsViewProps {
  session: SessionInfo;
  onOpenChat: (agentSlug: string) => void;
  onGoTemplates: () => void;
}

export function AgentsView({
  session,
  onOpenChat,
  onGoTemplates,
}: AgentsViewProps) {
  const [agents, setAgents] = useState<AgentDto[]>([]);
  const [departments, setDepartments] = useState<DepartmentDto[]>([]);
  const [providers, setProviders] = useState<ProviderDto[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerDto[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<AgentRevisionDto[]>([]);
  const [subTab, setSubTab] = useState<'config' | 'revisions'>('config');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  // Editor state
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [modelId, setModelId] = useState<string>('');
  const [temperature, setTemperature] = useState(0.2);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [contextDocs, setContextDocs] = useState('');
  const [serverIds, setServerIds] = useState<string[]>([]);
  const [allowedToolsInput, setAllowedToolsInput] = useState('');
  const [readOnly, setReadOnly] = useState(true);
  const [isActive, setIsActive] = useState(true);
  const [changeNote, setChangeNote] = useState('');

  // Create / Import Modals
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newDeptId, setNewDeptId] = useState('');
  const [newSlug, setNewSlug] = useState('');
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newPrompt, setNewPrompt] = useState('');

  const [showImportModal, setShowImportModal] = useState(false);
  const [importDeptId, setImportDeptId] = useState('');
  const [importYamlText, setImportYamlText] = useState('');

  const canEdit =
    session.role === 'global_admin' || session.role === 'department_admin';

  async function loadAll(preserveSelectedId?: string) {
    setLoading(true);
    setError(null);
    try {
      const [ags, depts, provs, mcps] = await Promise.all([
        api.getAgents(),
        canEdit ? api.getDepartments() : Promise.resolve([]),
        canEdit ? api.getProviders() : Promise.resolve([]),
        canEdit ? api.getMcpServers() : Promise.resolve([]),
      ]);
      setAgents(ags);
      setDepartments(depts);
      setProviders(provs);
      setMcpServers(mcps);
      if (depts.length > 0) {
        setNewDeptId((prev) => prev || depts[0].id);
        setImportDeptId((prev) => prev || depts[0].id);
      }

      const targetId =
        preserveSelectedId && ags.some((a) => a.id === preserveSelectedId)
          ? preserveSelectedId
          : ags[0]?.id ?? null;
      setSelectedId(targetId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load agents');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadAll();
  }, []);

  const selectedAgent = agents.find((a) => a.id === selectedId) ?? null;

  useEffect(() => {
    if (!selectedAgent) {
      setRevisions([]);
      return;
    }
    setName(selectedAgent.name);
    setDescription(selectedAgent.description);
    setModelId(selectedAgent.modelId || '');
    setTemperature(selectedAgent.temperature);
    setSystemPrompt(selectedAgent.systemPrompt);
    setContextDocs(selectedAgent.contextDocs);
    setServerIds(selectedAgent.mcpPermissions?.serverIds ?? []);
    setAllowedToolsInput(
      (selectedAgent.mcpPermissions?.allowedTools ?? []).join(', '),
    );
    setReadOnly(selectedAgent.mcpPermissions?.readOnly ?? true);
    setIsActive(selectedAgent.isActive);
    setChangeNote('');
    setFeedback(null);

    if (canEdit) {
      api
        .getAgentRevisions(selectedAgent.id)
        .then(setRevisions)
        .catch(() => setRevisions([]));
    }
  }, [selectedAgent?.id, selectedAgent?.updatedAt, canEdit]);

  const activeDept = selectedAgent
    ? departments.find((d) => d.id === selectedAgent.departmentId)
    : undefined;

  const allModels = providers.flatMap((p) =>
    p.models
      .filter((m) => m.isActive && p.isActive)
      .map((m) => ({
        id: m.id,
        label: `${p.name} · ${m.modelId}`,
      })),
  );
  const permittedModels =
    activeDept && activeDept.allowedModelIds.length > 0
      ? allModels.filter((m) => activeDept.allowedModelIds.includes(m.id))
      : allModels;

  const permittedMcps = activeDept
    ? mcpServers.filter((s) => activeDept.allowedMcpServerIds.includes(s.id))
    : mcpServers;

  const discoveredToolNames = Array.from(
    new Set(
      permittedMcps
        .filter((s) => serverIds.includes(s.id))
        .flatMap((s) => s.discoveredTools.map((t) => t.name)),
    ),
  );

  function toggleToolName(toolName: string) {
    const current = allowedToolsInput
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const exists = current.includes(toolName);
    const next = exists
      ? current.filter((t) => t !== toolName)
      : [...current, toolName];
    setAllowedToolsInput(next.join(', '));
  }

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    if (!selectedAgent) return;
    setSaving(true);
    setError(null);
    setFeedback(null);

    const allowedTools = allowedToolsInput
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    try {
      await api.updateAgent(selectedAgent.id, {
        name,
        description,
        modelId: modelId || null,
        temperature: Number(temperature),
        systemPrompt,
        contextDocs,
        mcpPermissions: {
          serverIds,
          allowedTools,
          readOnly,
        },
        isActive,
        changeNote: changeNote.trim() || 'Updated configuration',
      });
      await loadAll(selectedAgent.id);
      setFeedback('Saved agent configuration and recorded revision snapshot.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save agent');
    } finally {
      setSaving(false);
    }
  }

  async function handleRollback(revId: string) {
    if (!selectedAgent) return;
    setSaving(true);
    setError(null);
    setFeedback(null);
    try {
      await api.rollbackAgentRevision(selectedAgent.id, revId);
      await loadAll(selectedAgent.id);
      setSubTab('config');
      setFeedback('Rolled back prompt and context docs to selected revision.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Rollback failed');
    } finally {
      setSaving(false);
    }
  }

  async function handleExportYaml() {
    if (!selectedAgent) return;
    try {
      const res = await api.exportAgentYaml(selectedAgent.id);
      const blob = new Blob([res.yaml], { type: 'text/yaml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${res.slug}.yaml`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'YAML export failed');
    }
  }

  async function handleCreateSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const created = await api.createAgent({
        departmentId: newDeptId,
        slug: newSlug.trim().toLowerCase(),
        name: newName.trim(),
        description: newDesc.trim(),
        modelId: null,
        systemPrompt: newPrompt.trim(),
        temperature: 0.2,
        contextDocs: '',
        mcpPermissions: { serverIds: [], allowedTools: [], readOnly: true },
      });
      setShowCreateModal(false);
      setNewSlug('');
      setNewName('');
      setNewDesc('');
      setNewPrompt('');
      await loadAll(created.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create agent');
    } finally {
      setSaving(false);
    }
  }

  async function handleImportSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const created = await api.importAgentYaml({
        departmentId: importDeptId,
        yamlContent: importYamlText,
      });
      setShowImportModal(false);
      setImportYamlText('');
      await loadAll(created.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to import YAML');
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteAgent() {
    if (!selectedAgent) return;
    setSaving(true);
    setError(null);
    try {
      await api.deleteAgent(selectedAgent.id);
      await loadAll();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete agent');
    } finally {
      setSaving(false);
    }
  }

  if (!canEdit) {
    // Member read-only directory of authorized agents
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">
            Authorized Department Agents
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Agents exposed as OpenAI-compatible models via /v1/chat/completions for your access key.
          </p>
        </div>

        {agents.length === 0 && !loading ? (
          <div className="rounded-xl border border-slate-200 bg-white px-6 py-12 text-center">
            <h3 className="text-sm font-semibold text-slate-900">
              No Authorized Agents Available
            </h3>
            <p className="mt-1 text-sm text-slate-600">
              Ask your Department Admin or Global Admin to install or activate agents for your department.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {agents.map((ag) => (
              <div
                key={ag.id}
                className="rounded-xl border border-slate-200 bg-white p-5 flex flex-col justify-between"
              >
                <div>
                  <div className="text-xs font-mono text-slate-500">
                    agent/{ag.slug} · {ag.departmentName}
                  </div>
                  <h3 className="mt-1 text-base font-semibold text-slate-900">
                    {ag.name}
                  </h3>
                  <p className="mt-1.5 text-sm text-slate-600">{ag.description}</p>
                  <div className="mt-3 text-xs font-mono text-slate-500">
                    Model: {ag.modelName ? `${ag.providerName} / ${ag.modelName}` : 'Unassigned'}
                  </div>
                </div>
                <div className="mt-4 pt-3 border-t border-slate-100">
                  <button
                    type="button"
                    onClick={() => onOpenChat(`agent/${ag.slug}`)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-blue-700 transition-colors whitespace-nowrap"
                  >
                    <MessageSquare className="w-3.5 h-3.5" />
                    Test in Chat
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">
            Department Agents &amp; Revisions
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Customize system prompts, Markdown context docs, model assignments, and MCP tool allowlists with immutable revision history.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            disabled={departments.length === 0}
            onClick={() => setShowImportModal(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
          >
            <Upload className="w-3.5 h-3.5" />
            Import YAML
          </button>
          <button
            type="button"
            disabled={departments.length === 0}
            onClick={() => setShowCreateModal(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            New Agent
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {feedback && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          {feedback}
        </div>
      )}

      {!loading && agents.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white px-6 py-14 text-center">
          <h3 className="text-sm font-semibold text-slate-900">
            No Department Agents Configured
          </h3>
          <p className="mt-1.5 text-sm text-slate-600 max-w-md mx-auto">
            {departments.length === 0
              ? 'Start by creating a department under Governance & MCP, then install one of the starter YAML templates or create a custom agent.'
              : 'Install a starter template from the Template Catalog, import a YAML file, or create a custom agent.'}
          </p>
          <div className="mt-5 flex items-center justify-center gap-3">
            <button
              type="button"
              onClick={onGoTemplates}
              className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-700 whitespace-nowrap"
            >
              Browse Starter Templates
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left Roster */}
          <div className="lg:col-span-4 rounded-xl border border-slate-200 bg-white overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
              Configured Agents ({agents.length})
            </div>
            <div className="divide-y divide-slate-100">
              {agents.map((ag) => {
                const active = ag.id === selectedId;
                return (
                  <button
                    key={ag.id}
                    type="button"
                    onClick={() => setSelectedId(ag.id)}
                    className={`w-full text-left px-4 py-3.5 transition-colors ${
                      active ? 'bg-blue-50/70' : 'hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-sm text-slate-900 truncate">
                        {ag.name}
                      </span>
                      <span
                        className={`text-xs font-medium shrink-0 ${
                          ag.isActive ? 'text-emerald-700' : 'text-slate-500'
                        }`}
                      >
                        {ag.isActive ? 'Active' : 'Disabled'}
                      </span>
                    </div>
                    <div className="mt-0.5 text-xs font-mono text-slate-500 truncate">
                      agent/{ag.slug} · {ag.departmentName}
                    </div>
                    <div className="mt-1 text-xs text-slate-500 truncate">
                      {ag.modelName ? `${ag.providerName} · ${ag.modelName}` : 'No model assigned'}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Right Editor / Revisions */}
          {selectedAgent && (
            <div className="lg:col-span-8 rounded-xl border border-slate-200 bg-white overflow-hidden">
              <div className="px-6 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-mono text-slate-500">
                    agent/{selectedAgent.slug} · {selectedAgent.departmentName}
                  </div>
                  <h3 className="text-base font-semibold text-slate-900">
                    {selectedAgent.name}
                  </h3>
                </div>

                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1 p-1 bg-slate-100 border border-slate-200 rounded-lg">
                    <button
                      type="button"
                      onClick={() => setSubTab('config')}
                      className={`px-3 py-1 text-xs font-medium rounded-md whitespace-nowrap ${
                        subTab === 'config'
                          ? 'bg-white text-slate-900 border border-slate-200'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      Configuration
                    </button>
                    <button
                      type="button"
                      onClick={() => setSubTab('revisions')}
                      className={`inline-flex items-center gap-1 px-3 py-1 text-xs font-medium rounded-md whitespace-nowrap ${
                        subTab === 'revisions'
                          ? 'bg-white text-slate-900 border border-slate-200'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      <History className="w-3 h-3" />
                      Revisions ({revisions.length})
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={() => onOpenChat(`agent/${selectedAgent.slug}`)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                  >
                    <MessageSquare className="w-3.5 h-3.5" />
                    Test
                  </button>
                  <button
                    type="button"
                    onClick={handleExportYaml}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                  >
                    <Download className="w-3.5 h-3.5" />
                    YAML
                  </button>
                </div>
              </div>

              {subTab === 'config' ? (
                <form onSubmit={handleSave} className="p-6 space-y-5">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        Display Name
                      </label>
                      <input
                        type="text"
                        required
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        Provider Model (Department Guardrails Applied)
                      </label>
                      <select
                        value={modelId}
                        onChange={(e) => setModelId(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
                      >
                        <option value="">Unassigned</option>
                        {permittedModels.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Description
                    </label>
                    <input
                      type="text"
                      required
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
                    />
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        Temperature ({temperature})
                      </label>
                      <input
                        type="number"
                        step="0.05"
                        min="0"
                        max="2"
                        value={temperature}
                        onChange={(e) => setTemperature(Number(e.target.value))}
                        className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
                      />
                    </div>
                    <div className="flex items-end pb-2">
                      <label className="inline-flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={isActive}
                          onChange={(e) => setIsActive(e.target.checked)}
                          className="rounded border-slate-300 text-blue-600 focus:ring-blue-600"
                        />
                        Agent active in /v1/models gateway
                      </label>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      System Prompt
                    </label>
                    <textarea
                      rows={7}
                      required
                      value={systemPrompt}
                      onChange={(e) => setSystemPrompt(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 font-mono text-xs text-slate-900 leading-relaxed focus:outline-none focus:ring-2 focus:ring-blue-600"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Context Docs (Markdown injected into system context)
                    </label>
                    <textarea
                      rows={5}
                      value={contextDocs}
                      onChange={(e) => setContextDocs(e.target.value)}
                      placeholder="Department architecture notes, coding standards, or review rubrics..."
                      className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 font-mono text-xs text-slate-900 leading-relaxed focus:outline-none focus:ring-2 focus:ring-blue-600"
                    />
                  </div>

                  {/* MCP Permissions */}
                  <div className="pt-4 border-t border-slate-200 space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <h4 className="text-sm font-semibold text-slate-900">
                          MCP Server &amp; Tool Whitelist
                        </h4>
                        <p className="text-xs text-slate-500">
                          Restricted to MCP servers approved by department guardrails.
                        </p>
                      </div>
                      <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={readOnly}
                          onChange={(e) => setReadOnly(e.target.checked)}
                          className="rounded border-slate-300 text-blue-600 focus:ring-blue-600"
                        />
                        Enforce read-only tool annotations
                      </label>
                    </div>

                    {permittedMcps.length === 0 ? (
                      <div className="text-xs text-slate-500">
                        No MCP servers are currently permitted for {activeDept?.name || 'this department'}.
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-3">
                        {permittedMcps.map((srv) => {
                          const checked = serverIds.includes(srv.id);
                          return (
                            <label
                              key={srv.id}
                              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-800 cursor-pointer"
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={(e) => {
                                  if (e.target.checked) {
                                    setServerIds((prev) => [...prev, srv.id]);
                                  } else {
                                    setServerIds((prev) =>
                                      prev.filter((id) => id !== srv.id),
                                    );
                                  }
                                }}
                                className="rounded border-slate-300 text-blue-600"
                              />
                              <span>{srv.name}</span>
                              <span className="font-mono text-slate-500">
                                ({srv.transport})
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    )}

                    {discoveredToolNames.length > 0 && (
                      <div className="space-y-1.5">
                        <div className="text-xs text-slate-600">
                          Discovered tools from selected servers (click to toggle):
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {discoveredToolNames.map((tName) => {
                            const selected = allowedToolsInput
                              .split(',')
                              .map((s) => s.trim())
                              .includes(tName);
                            return (
                              <button
                                key={tName}
                                type="button"
                                onClick={() => toggleToolName(tName)}
                                className={`px-2.5 py-1 rounded-md font-mono text-xs border transition-colors ${
                                  selected
                                    ? 'border-blue-600 bg-blue-50 text-blue-700'
                                    : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                                }`}
                              >
                                {tName}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    <div>
                      <label className="block text-xs font-medium text-slate-700 mb-1">
                        Allowed Tools Whitelist (comma-separated exact tool names)
                      </label>
                      <input
                        type="text"
                        value={allowedToolsInput}
                        onChange={(e) => setAllowedToolsInput(e.target.value)}
                        placeholder="e.g. git_diff, read_file"
                        className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
                      />
                    </div>
                  </div>

                  <div className="pt-4 border-t border-slate-200 flex flex-wrap items-center justify-between gap-4">
                    <input
                      type="text"
                      value={changeNote}
                      onChange={(e) => setChangeNote(e.target.value)}
                      placeholder="Revision note (e.g. tightened SQL index guidelines)..."
                      className="flex-1 min-w-[220px] rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
                    />

                    <div className="flex items-center gap-2.5">
                      <button
                        type="button"
                        onClick={handleDeleteAgent}
                        disabled={saving}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-white px-3.5 py-2 text-xs font-medium text-red-700 hover:bg-red-50 whitespace-nowrap"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        Delete
                      </button>
                      <button
                        type="submit"
                        disabled={saving}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-60 whitespace-nowrap"
                      >
                        <Save className="w-3.5 h-3.5" />
                        {saving ? 'Saving...' : 'Save Revision'}
                      </button>
                    </div>
                  </div>
                </form>
              ) : (
                <div className="p-6 space-y-4">
                  {revisions.length === 0 ? (
                    <p className="text-sm text-slate-500">
                      No revision snapshots recorded yet.
                    </p>
                  ) : (
                    revisions.map((rev, idx) => (
                      <div
                        key={rev.id}
                        className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-3"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <div className="text-sm font-medium text-slate-900">
                              {rev.changeNote}
                            </div>
                            <div className="text-xs text-slate-500 font-mono mt-0.5">
                              {new Date(rev.createdAt).toLocaleString()} ·{' '}
                              {rev.changedByLabel || 'System'}
                              {idx === 0 ? ' · Current' : ''}
                            </div>
                          </div>
                          {idx > 0 && (
                            <button
                              type="button"
                              disabled={saving}
                              onClick={() => handleRollback(rev.id)}
                              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap"
                            >
                              <RotateCcw className="w-3.5 h-3.5" />
                              Roll Back to This Version
                            </button>
                          )}
                        </div>
                        <pre className="max-h-36 overflow-auto rounded-md border border-slate-200 bg-white p-3 font-mono text-xs text-slate-700 whitespace-pre-wrap">
                          {rev.systemPrompt}
                        </pre>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* New Agent Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-semibold text-slate-900">
                Create Custom Agent
              </h3>
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                className="p-1 text-slate-500 hover:text-slate-900"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleCreateSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Department
                  </label>
                  <select
                    required
                    value={newDeptId}
                    onChange={(e) => setNewDeptId(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
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
                    Slug (agent/&lt;slug&gt;)
                  </label>
                  <input
                    type="text"
                    required
                    pattern="[a-z0-9-]+"
                    value={newSlug}
                    onChange={(e) => setNewSlug(e.target.value.toLowerCase())}
                    placeholder="api-reviewer"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Name
                </label>
                <input
                  type="text"
                  required
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="API Design Reviewer"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Description
                </label>
                <input
                  type="text"
                  required
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  placeholder="Reviews OpenAPI specs, pagination contracts, and backward compatibility."
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  System Prompt
                </label>
                <textarea
                  rows={5}
                  required
                  value={newPrompt}
                  onChange={(e) => setNewPrompt(e.target.value)}
                  placeholder="You are a principal API architect..."
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs"
                />
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-medium text-slate-700"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-700"
                >
                  Create Agent
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Import YAML Modal */}
      {showImportModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-semibold text-slate-900">
                Import Agent YAML
              </h3>
              <button
                type="button"
                onClick={() => setShowImportModal(false)}
                className="p-1 text-slate-500 hover:text-slate-900"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleImportSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Target Department
                </label>
                <select
                  required
                  value={importDeptId}
                  onChange={(e) => setImportDeptId(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
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
                  YAML Definition (validated by Zod template schema)
                </label>
                <textarea
                  rows={10}
                  required
                  value={importYamlText}
                  onChange={(e) => setImportYamlText(e.target.value)}
                  placeholder={`id: custom-reviewer\nversion: "0.1"\nslug: custom-reviewer\nname: Custom Reviewer\ndescription: Specialized reviewer\ntemperature: 0.2\nsystem_prompt: |\n  You are a specialized reviewer...`}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs"
                />
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowImportModal(false)}
                  className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-medium text-slate-700"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-700"
                >
                  Validate &amp; Import
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
