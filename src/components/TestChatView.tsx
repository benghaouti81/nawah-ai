import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Send, Square, Trash2, Wrench } from 'lucide-react';
import {
  api,
  ApiError,
  streamChatCompletion,
  type SessionInfo,
  type StreamReceipt,
  type StreamTraceToolEvent,
} from '../lib/api';
import type { AgentDto } from '../shared/types';

interface TestChatViewProps {
  session: SessionInfo;
  initialModel?: string | null;
  onNavigate: (tab: string) => void;
}

interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolEvents?: StreamTraceToolEvent[];
  receipt?: StreamReceipt;
  error?: string;
}

export function TestChatView({
  session,
  initialModel,
  onNavigate,
}: TestChatViewProps) {
  const [agents, setAgents] = useState<AgentDto[]>([]);
  const [selectedModel, setSelectedModel] = useState(initialModel || '');
  const [prompt, setPrompt] = useState('');
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    api
      .getAgents()
      .then((ags) => {
        const active = ags.filter((a) => a.isActive);
        setAgents(active);
        if (initialModel && active.some((a) => `agent/${a.slug}` === initialModel)) {
          setSelectedModel(initialModel);
        } else if (active.length > 0 && !selectedModel) {
          setSelectedModel(`agent/${active[0].slug}`);
        }
      })
      .catch((err) => {
        setLoadError(err instanceof ApiError ? err.message : 'Failed to load agents');
      });
  }, [initialModel]);

  const currentAgent = agents.find((a) => `agent/${a.slug}` === selectedModel);

  async function handleSend(e: FormEvent) {
    e.preventDefault();
    if (!prompt.trim() || !selectedModel || streaming) return;

    const userText = prompt.trim();
    setPrompt('');

    const userTurn: ChatTurn = {
      id: `u_${Date.now()}`,
      role: 'user',
      content: userText,
    };
    const assistantId = `a_${Date.now()}`;
    const assistantTurn: ChatTurn = {
      id: assistantId,
      role: 'assistant',
      content: '',
      toolEvents: [],
    };

    const historyForApi = [
      ...turns
        .filter((t) => !t.error && t.content.trim().length > 0)
        .map((t) => ({ role: t.role, content: t.content })),
      { role: 'user' as const, content: userText },
    ];

    setTurns((prev) => [...prev, userTurn, assistantTurn]);
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await streamChatCompletion({
        model: selectedModel,
        messages: historyForApi,
        signal: controller.signal,
        onDelta: (chunk) => {
          setTurns((prev) =>
            prev.map((t) =>
              t.id === assistantId ? { ...t, content: t.content + chunk } : t,
            ),
          );
        },
        onToolEvent: (ev) => {
          setTurns((prev) =>
            prev.map((t) =>
              t.id === assistantId
                ? { ...t, toolEvents: [...(t.toolEvents ?? []), ev] }
                : t,
            ),
          );
        },
        onReceipt: (receipt) => {
          setTurns((prev) =>
            prev.map((t) => (t.id === assistantId ? { ...t, receipt } : t)),
          );
        },
      });
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        const message =
          err instanceof ApiError
            ? `[${err.code}] ${err.message}`
            : err instanceof Error
              ? err.message
              : 'Execution failed';
        setTurns((prev) =>
          prev.map((t) =>
            t.id === assistantId ? { ...t, error: message } : t,
          ),
        );
      }
    } finally {
      abortRef.current = null;
      setStreaming(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">
            Live Gateway Test Chat (/v1/chat/completions)
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Executes real SSE streaming against the selected agent&apos;s configured provider and permitted MCP tools.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <select
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
          >
            {agents.length === 0 ? (
              <option value="">No active agents</option>
            ) : (
              agents.map((a) => (
                <option key={a.id} value={`agent/${a.slug}`}>
                  agent/{a.slug} ({a.modelName || 'unassigned'})
                </option>
              ))
            )}
          </select>

          <button
            type="button"
            onClick={() => setTurns([])}
            disabled={turns.length === 0 || streaming}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Clear
          </button>
        </div>
      </div>

      {loadError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {loadError}
        </div>
      )}

      {currentAgent && !currentAgent.modelId && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-5 py-3.5 flex flex-wrap items-center justify-between gap-3 text-xs text-amber-900">
          <span>
            <strong>agent/{currentAgent.slug}</strong> does not have an upstream model assigned yet. Invoking it will return a real 422 error and record a failed log entry.
          </span>
          {session.role !== 'member' && (
            <button
              type="button"
              onClick={() => onNavigate('agents')}
              className="rounded-md border border-amber-300 bg-white px-3 py-1.5 font-medium text-amber-900 hover:bg-amber-100 whitespace-nowrap"
            >
              Assign Model
            </button>
          )}
        </div>
      )}

      <div className="rounded-xl border border-slate-200 bg-white flex flex-col min-h-[520px]">
        <div className="flex-1 p-6 space-y-5 overflow-y-auto max-h-[60vh]">
          {turns.length === 0 ? (
            <div className="h-full py-16 text-center">
              <h3 className="text-sm font-semibold text-slate-900">
                Ready for Live Agent Execution
              </h3>
              <p className="mt-1 text-sm text-slate-600 max-w-md mx-auto">
                {agents.length === 0
                  ? 'Install or create an active department agent first, bind an external provider model, and send a prompt.'
                  : `Select an authorized agent above and send a message. Provider-reported usage and calculated cost are recorded strictly post-execution.`}
              </p>
            </div>
          ) : (
            turns.map((turn) => (
              <div
                key={turn.id}
                className={`flex flex-col ${
                  turn.role === 'user' ? 'items-end' : 'items-start'
                }`}
              >
                <div className="text-xs font-mono text-slate-500 mb-1">
                  {turn.role === 'user' ? session.userLabel : selectedModel}
                </div>

                {turn.toolEvents && turn.toolEvents.length > 0 && (
                  <div className="w-full max-w-3xl mb-2 space-y-2">
                    {turn.toolEvents.map((ev, idx) => (
                      <div
                        key={idx}
                        className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs"
                      >
                        <div className="flex items-center gap-1.5 font-mono font-medium text-slate-800">
                          <Wrench className="w-3.5 h-3.5 text-slate-500" />
                          <span>
                            Step {ev.step} · {ev.serverSlug}.{ev.toolName}
                          </span>
                          <span
                            className={
                              ev.isError ? 'text-red-600' : 'text-emerald-700'
                            }
                          >
                            {ev.isError ? '(error)' : '(ok)'}
                          </span>
                        </div>
                        <pre className="mt-1.5 text-[11px] font-mono text-slate-600 overflow-x-auto whitespace-pre-wrap">
                          Args: {JSON.stringify(ev.arguments)}
                          {'\n'}
                          Result: {ev.result.slice(0, 600)}
                        </pre>
                      </div>
                    ))}
                  </div>
                )}

                {turn.error ? (
                  <div className="w-full max-w-3xl rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs font-mono text-red-700">
                    {turn.error}
                  </div>
                ) : (
                  <div
                    className={`max-w-3xl rounded-xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${
                      turn.role === 'user'
                        ? 'bg-slate-900 text-white'
                        : 'border border-slate-200 bg-slate-50 text-slate-900'
                    }`}
                  >
                    {turn.content || (streaming && turn.role === 'assistant' ? 'Streaming...' : '')}
                  </div>
                )}

                {turn.receipt && (
                  <div className="mt-1.5 text-xs font-mono tabular-nums text-slate-500">
                    {turn.receipt.provider_type} · {turn.receipt.upstream_model} ·{' '}
                    {turn.receipt.input_tokens === null || turn.receipt.output_tokens === null
                      ? 'usage unavailable'
                      : `${turn.receipt.input_tokens} in / ${turn.receipt.output_tokens} out`}{' '}
                    ·{' '}
                    {turn.receipt.calculated_cost_usd === null
                      ? 'cost unavailable'
                      : `calc. $${turn.receipt.calculated_cost_usd.toFixed(6)}`}{' '}
                    · {turn.receipt.latency_ms} ms
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        <form
          onSubmit={handleSend}
          className="border-t border-slate-200 p-4 flex items-end gap-3 bg-white rounded-b-xl"
        >
          <textarea
            rows={2}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleSend(e);
              }
            }}
            disabled={agents.length === 0 || streaming}
            placeholder={
              agents.length === 0
                ? 'Configure an active agent to begin chatting...'
                : 'Send a prompt to the agent (Enter to send, Shift+Enter for newline)...'
            }
            className="flex-1 resize-none rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
          />

          {streaming ? (
            <button
              type="button"
              onClick={() => abortRef.current?.abort()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-300 bg-red-50 px-4 py-2.5 text-xs font-medium text-red-700 hover:bg-red-100 whitespace-nowrap"
            >
              <Square className="w-3.5 h-3.5" />
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={!prompt.trim() || !selectedModel}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap"
            >
              <Send className="w-3.5 h-3.5" />
              Send
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
