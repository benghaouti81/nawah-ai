import { useEffect, useState, type FormEvent } from 'react';
import { Activity, Plus, Trash2, X } from 'lucide-react';
import { api, ApiError, type SessionInfo } from '../lib/api';
import { PROVIDER_TYPES, type ProviderDto, type ProviderType } from '../shared/types';

interface ProvidersViewProps {
  session: SessionInfo;
}

const DEFAULT_BASE_URLS: Record<ProviderType, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  google: 'Official @google/genai endpoint',
  ollama: 'http://localhost:11434/v1',
  openai_compatible: 'https://your-vllm-host/v1',
};

export function ProvidersView({ session }: ProvidersViewProps) {
  const [providers, setProviders] = useState<ProviderDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<
    Record<string, { ok: boolean; latencyMs: number; modelsCount?: number; error?: string }>
  >({});
  const [testingId, setTestingId] = useState<string | null>(null);

  // Add Provider modal
  const [showAddProvider, setShowAddProvider] = useState(false);
  const [provName, setProvName] = useState('');
  const [provType, setProvType] = useState<ProviderType>('openai');
  const [provBaseUrl, setProvBaseUrl] = useState('');
  const [provKey, setProvKey] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Add Model modal
  const [addModelForProvider, setAddModelForProvider] = useState<ProviderDto | null>(
    null,
  );
  const [modelIdInput, setModelIdInput] = useState('');
  const [inputCost, setInputCost] = useState('0');
  const [outputCost, setOutputCost] = useState('0');
  const [supportsVision, setSupportsVision] = useState(false);

  // Rotate Key modal
  const [editKeyProvider, setEditKeyProvider] = useState<ProviderDto | null>(null);
  const [newApiKeyVal, setNewApiKeyVal] = useState('');

  const isGlobalAdmin = session.role === 'global_admin';

  async function loadProviders() {
    setLoading(true);
    setError(null);
    try {
      setProviders(await api.getProviders());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load providers');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadProviders();
  }, []);

  async function handleCreateProvider(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.createProvider({
        name: provName.trim(),
        type: provType,
        baseUrl: provType === 'google' ? null : provBaseUrl.trim() || null,
        apiKey: provKey.trim() || null,
      });
      setShowAddProvider(false);
      setProvName('');
      setProvBaseUrl('');
      setProvKey('');
      await loadProviders();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create provider');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleTestConnection(id: string) {
    setTestingId(id);
    try {
      const res = await api.testProvider(id);
      setTestResults((prev) => ({ ...prev, [id]: res }));
    } catch (err) {
      setTestResults((prev) => ({
        ...prev,
        [id]: {
          ok: false,
          latencyMs: 0,
          error: err instanceof ApiError ? err.message : 'Test failed',
        },
      }));
    } finally {
      setTestingId(null);
    }
  }

  async function handleCreateModel(e: FormEvent) {
    e.preventDefault();
    if (!addModelForProvider) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.createModel(addModelForProvider.id, {
        modelId: modelIdInput.trim(),
        supportsVision,
        inputCostPer1mUsd: Number(inputCost) || 0,
        outputCostPer1mUsd: Number(outputCost) || 0,
      });
      setAddModelForProvider(null);
      setModelIdInput('');
      setInputCost('0');
      setOutputCost('0');
      setSupportsVision(false);
      await loadProviders();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to add model');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleUpdateKey(e: FormEvent) {
    e.preventDefault();
    if (!editKeyProvider) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.updateProvider(editKeyProvider.id, {
        apiKey: newApiKeyVal.trim(),
      });
      setEditKeyProvider(null);
      setNewApiKeyVal('');
      await loadProviders();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update API key');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleToggleProvider(p: ProviderDto) {
    try {
      await api.updateProvider(p.id, { isActive: !p.isActive });
      await loadProviders();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update provider');
    }
  }

  async function handleDeleteProvider(id: string) {
    try {
      await api.deleteProvider(id);
      await loadProviders();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete provider');
    }
  }

  async function handleDeleteModel(id: string) {
    try {
      await api.deleteModel(id);
      await loadProviders();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete model');
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">
            External LLM Providers &amp; Model Pricing
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Register cloud or self-hosted providers. Credentials are encrypted with AES-256-GCM at rest and never exposed in the browser.
          </p>
        </div>

        {isGlobalAdmin && (
          <button
            type="button"
            onClick={() => setShowAddProvider(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-700 whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Provider
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {!loading && providers.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white px-6 py-14 text-center">
          <h3 className="text-sm font-semibold text-slate-900">
            No External Providers Configured
          </h3>
          <p className="mt-1.5 text-sm text-slate-600 max-w-md mx-auto">
            Nawah AI executes exclusively against configured external providers (OpenAI, Anthropic, Google, Ollama, or OpenAI-compatible). Add a provider and register at least one model to enable live agent runs.
          </p>
          {isGlobalAdmin && (
            <button
              type="button"
              onClick={() => setShowAddProvider(true)}
              className="mt-5 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-700"
            >
              <Plus className="w-3.5 h-3.5" />
              Register First Provider
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-5">
          {providers.map((p) => {
            const testRes = testResults[p.id];
            return (
              <div
                key={p.id}
                className="rounded-xl border border-slate-200 bg-white overflow-hidden"
              >
                <div className="px-6 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <div className="text-xs font-mono text-slate-500">
                      {p.type} · {p.baseUrl || DEFAULT_BASE_URLS[p.type]} ·{' '}
                      {p.hasApiKey ? 'Encrypted API key stored' : 'No API key stored'}
                    </div>
                    <div className="mt-1 flex items-center gap-3">
                      <h3 className="text-base font-semibold text-slate-900">
                        {p.name}
                      </h3>
                      <span
                        className={`text-xs font-medium ${
                          p.isActive ? 'text-emerald-700' : 'text-slate-500'
                        }`}
                      >
                        {p.isActive ? 'Active' : 'Disabled'}
                      </span>
                    </div>
                  </div>

                  {isGlobalAdmin && (
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled={testingId === p.id}
                        onClick={() => handleTestConnection(p.id)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                      >
                        <Activity className="w-3.5 h-3.5" />
                        {testingId === p.id ? 'Testing...' : 'Test Connection'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditKeyProvider(p)}
                        className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                      >
                        {p.hasApiKey ? 'Rotate Key' : 'Set Key'}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleToggleProvider(p)}
                        className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                      >
                        {p.isActive ? 'Disable' : 'Enable'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setAddModelForProvider(p)}
                        className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 whitespace-nowrap"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        Add Model
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteProvider(p.id)}
                        className="p-1.5 text-slate-400 hover:text-red-600"
                        aria-label={`Delete ${p.name}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                </div>

                {testRes && (
                  <div
                    className={`px-6 py-2.5 text-xs border-b border-slate-200 ${
                      testRes.ok
                        ? 'bg-emerald-50 text-emerald-800'
                        : 'bg-red-50 text-red-700'
                    }`}
                  >
                    {testRes.ok ? (
                      <span className="font-mono tabular-nums">
                        Connection verified in {testRes.latencyMs} ms
                        {testRes.modelsCount !== undefined
                          ? ` · ${testRes.modelsCount} upstream models visible`
                          : ''}
                      </span>
                    ) : (
                      <span>Connection failed: {testRes.error}</span>
                    )}
                  </div>
                )}

                {p.models.length === 0 ? (
                  <div className="px-6 py-5 text-xs text-slate-500">
                    No models registered for this provider yet. Add a model ID with its per-1M token rates.
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 bg-slate-50 font-medium text-slate-500">
                          <th className="px-6 py-2.5">Model ID</th>
                          <th className="px-4 py-2.5">Vision</th>
                          <th className="px-4 py-2.5 text-right">Input / 1M USD</th>
                          <th className="px-4 py-2.5 text-right">Output / 1M USD</th>
                          <th className="px-4 py-2.5">Status</th>
                          {isGlobalAdmin && <th className="px-6 py-2.5 text-right">Actions</th>}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {p.models.map((m) => (
                          <tr key={m.id} className="hover:bg-slate-50">
                            <td className="px-6 py-2.5 font-mono text-slate-900">
                              {m.modelId}
                            </td>
                            <td className="px-4 py-2.5 text-slate-600">
                              {m.supportsVision ? 'Yes' : 'No'}
                            </td>
                            <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-700">
                              ${m.inputCostPer1mUsd.toFixed(4)}
                            </td>
                            <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-700">
                              ${m.outputCostPer1mUsd.toFixed(4)}
                            </td>
                            <td className="px-4 py-2.5">
                              <span
                                className={
                                  m.isActive ? 'text-emerald-700' : 'text-slate-500'
                                }
                              >
                                {m.isActive ? 'Active' : 'Disabled'}
                              </span>
                            </td>
                            {isGlobalAdmin && (
                              <td className="px-6 py-2.5 text-right">
                                <button
                                  type="button"
                                  onClick={() => handleDeleteModel(m.id)}
                                  className="text-red-600 hover:underline"
                                >
                                  Remove
                                </button>
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Add Provider Modal */}
      {showAddProvider && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-semibold text-slate-900">
                Add LLM Provider
              </h3>
              <button
                type="button"
                onClick={() => setShowAddProvider(false)}
                className="p-1 text-slate-500 hover:text-slate-900"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleCreateProvider} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Provider Display Name
                </label>
                <input
                  type="text"
                  required
                  value={provName}
                  onChange={(e) => setProvName(e.target.value)}
                  placeholder="e.g. Corporate OpenAI / Local Ollama"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Provider Type
                </label>
                <select
                  value={provType}
                  onChange={(e) => setProvType(e.target.value as ProviderType)}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                >
                  {PROVIDER_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>

              {provType !== 'google' && (
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Base URL {provType === 'openai_compatible' ? '(required)' : '(optional override)'}
                  </label>
                  <input
                    type="url"
                    required={provType === 'openai_compatible'}
                    value={provBaseUrl}
                    onChange={(e) => setProvBaseUrl(e.target.value)}
                    placeholder={DEFAULT_BASE_URLS[provType]}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs"
                  />
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  API Key{' '}
                  {provType === 'ollama' || provType === 'openai_compatible'
                    ? '(optional)'
                    : '(required for execution)'}
                </label>
                <input
                  type="password"
                  value={provKey}
                  onChange={(e) => setProvKey(e.target.value)}
                  placeholder="Encrypted with AES-256-GCM before saving"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs"
                />
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddProvider(false)}
                  className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-medium text-slate-700"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-700"
                >
                  {submitting ? 'Saving...' : 'Save Provider'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Add Model Modal */}
      {addModelForProvider && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-semibold text-slate-900">
                Add Model to {addModelForProvider.name}
              </h3>
              <button
                type="button"
                onClick={() => setAddModelForProvider(null)}
                className="p-1 text-slate-500 hover:text-slate-900"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleCreateModel} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Upstream Model ID
                </label>
                <input
                  type="text"
                  required
                  value={modelIdInput}
                  onChange={(e) => setModelIdInput(e.target.value)}
                  placeholder="e.g. gpt-4o, claude-3-7-sonnet-latest, gemini-4-hydrogen, qwen2.5-coder:14b"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Input USD / 1M tokens
                  </label>
                  <input
                    type="number"
                    step="0.0001"
                    min="0"
                    value={inputCost}
                    onChange={(e) => setInputCost(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Output USD / 1M tokens
                  </label>
                  <input
                    type="number"
                    step="0.0001"
                    min="0"
                    value={outputCost}
                    onChange={(e) => setOutputCost(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs"
                  />
                </div>
              </div>

              <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={supportsVision}
                  onChange={(e) => setSupportsVision(e.target.checked)}
                  className="rounded border-slate-300 text-blue-600"
                />
                Model supports vision inputs
              </label>

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setAddModelForProvider(null)}
                  className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-medium text-slate-700"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-700"
                >
                  Register Model
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Update Key Modal */}
      {editKeyProvider && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-semibold text-slate-900">
                Update API Key · {editKeyProvider.name}
              </h3>
              <button
                type="button"
                onClick={() => setEditKeyProvider(null)}
                className="p-1 text-slate-500 hover:text-slate-900"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleUpdateKey} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  New API Key (encrypted with AES-256-GCM)
                </label>
                <input
                  type="password"
                  required
                  value={newApiKeyVal}
                  onChange={(e) => setNewApiKeyVal(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs"
                />
              </div>
              <div className="flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setEditKeyProvider(null)}
                  className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-medium text-slate-700"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-700"
                >
                  Encrypt &amp; Save
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
