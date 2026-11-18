import { useEffect, useState } from 'react';
import {
  BarChart3,
  Bot,
  Box,
  Cpu,
  KeyRound,
  LayoutTemplate,
  LogOut,
  Menu,
  MessageSquare,
  Shield,
  X,
} from 'lucide-react';
import { AgentsView } from './components/AgentsView';
import { ApiKeysView } from './components/ApiKeysView';
import { AuthGate } from './components/AuthGate';
import { DeployView } from './components/DeployView';
import { GovernanceView } from './components/GovernanceView';
import { ProvidersView } from './components/ProvidersView';
import { TemplatesView } from './components/TemplatesView';
import { TestChatView } from './components/TestChatView';
import { UsageView } from './components/UsageView';
import {
  api,
  getStoredToken,
  setStoredToken,
  type SessionInfo,
} from './lib/api';

type NavId =
  | 'usage'
  | 'agents'
  | 'templates'
  | 'chat'
  | 'providers'
  | 'governance'
  | 'keys'
  | 'deploy';

interface NavItem {
  id: NavId;
  label: string;
  icon: typeof BarChart3;
  roles: Array<'global_admin' | 'department_admin' | 'member'>;
}

const NAV_ITEMS: NavItem[] = [
  {
    id: 'usage',
    label: 'Usage & Cost',
    icon: BarChart3,
    roles: ['global_admin', 'department_admin', 'member'],
  },
  {
    id: 'agents',
    label: 'Agents',
    icon: Bot,
    roles: ['global_admin', 'department_admin', 'member'],
  },
  {
    id: 'templates',
    label: 'Templates',
    icon: LayoutTemplate,
    roles: ['global_admin', 'department_admin'],
  },
  {
    id: 'chat',
    label: 'Test Chat',
    icon: MessageSquare,
    roles: ['global_admin', 'department_admin', 'member'],
  },
  {
    id: 'providers',
    label: 'Providers',
    icon: Cpu,
    roles: ['global_admin', 'department_admin'],
  },
  {
    id: 'governance',
    label: 'Governance & MCP',
    icon: Shield,
    roles: ['global_admin', 'department_admin'],
  },
  {
    id: 'keys',
    label: 'Access Keys',
    icon: KeyRound,
    roles: ['global_admin'],
  },
  {
    id: 'deploy',
    label: 'Deploy & Integrations',
    icon: Box,
    roles: ['global_admin', 'department_admin', 'member'],
  },
];

export default function App() {
  const [booting, setBooting] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [workspaceName, setWorkspaceName] = useState('Default Workspace');
  const [session, setSession] = useState<SessionInfo | null>(null);

  const [activeTab, setActiveTab] = useState<NavId>('usage');
  const [chatModelOverride, setChatModelOverride] = useState<string | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  async function bootstrapAuth() {
    setBooting(true);
    try {
      const status = await api.getAuthStatus();
      setNeedsSetup(status.needsSetup);
      setWorkspaceName(status.workspaceName);

      if (!status.needsSetup) {
        const stored = getStoredToken();
        if (stored) {
          try {
            const me = await api.getMe(stored);
            setSession(me);
          } catch {
            setStoredToken(null);
            setSession(null);
          }
        }
      }
    } finally {
      setBooting(false);
    }
  }

  useEffect(() => {
    void bootstrapAuth();
  }, []);

  function handleAuthenticated(token: string, me: SessionInfo) {
    setStoredToken(token);
    setNeedsSetup(false);
    setSession(me);
    setActiveTab('usage');
  }

  function handleSignOut() {
    setStoredToken(null);
    setSession(null);
    void bootstrapAuth();
  }

  if (booting) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-sm font-medium text-slate-600">
          Connecting to Nawah AI Core...
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <AuthGate
        needsSetup={needsSetup}
        workspaceName={workspaceName}
        onAuthenticated={handleAuthenticated}
      />
    );
  }

  const visibleNav = NAV_ITEMS.filter((item) => item.roles.includes(session.role));
  const currentNav = visibleNav.find((n) => n.id === activeTab) || visibleNav[0];

  function openTestChat(agentSlug?: string) {
    if (agentSlug) {
      setChatModelOverride(agentSlug);
    }
    setActiveTab('chat');
    setMobileMenuOpen(false);
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex lg:w-64 lg:flex-col lg:fixed lg:inset-y-0 bg-white border-r border-slate-200">
        <div className="h-16 px-6 flex items-center border-b border-slate-200">
          <span className="font-display text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap">
            Nawah AI
          </span>
        </div>

        <nav className="flex-1 px-3 py-5 space-y-1 overflow-y-auto">
          {visibleNav.map((item) => {
            const Icon = item.icon;
            const active = currentNav.id === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-blue-50 text-blue-700'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-200 space-y-3">
          <div className="text-xs">
            <div className="font-medium text-slate-900 truncate">
              {session.userLabel}
            </div>
            <div className="mt-0.5 font-mono text-slate-500 truncate">
              {session.role}
              {session.departmentName ? ` · ${session.departmentName}` : ''}
            </div>
          </div>

          <button
            type="button"
            onClick={handleSignOut}
            className="w-full inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap"
          >
            <LogOut className="w-3.5 h-3.5" />
            Sign Out
          </button>
        </div>
      </aside>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-900/40"
            onClick={() => setMobileMenuOpen(false)}
          />
          <aside className="relative w-64 max-w-full bg-white h-full border-r border-slate-200 flex flex-col">
            <div className="h-16 px-5 flex items-center justify-between border-b border-slate-200">
              <span className="font-display text-lg font-bold text-slate-900">
                Nawah AI
              </span>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                className="p-1.5 text-slate-500 hover:text-slate-900"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
              {visibleNav.map((item) => {
                const Icon = item.icon;
                const active = currentNav.id === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setActiveTab(item.id);
                      setMobileMenuOpen(false);
                    }}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium whitespace-nowrap ${
                      active
                        ? 'bg-blue-50 text-blue-700'
                        : 'text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
            <div className="p-4 border-t border-slate-200 space-y-3">
              <div className="text-xs">
                <div className="font-medium text-slate-900 truncate">
                  {session.userLabel}
                </div>
                <div className="font-mono text-slate-500">{session.role}</div>
              </div>
              <button
                type="button"
                onClick={handleSignOut}
                className="w-full inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700"
              >
                <LogOut className="w-3.5 h-3.5" />
                Sign Out
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* Main Content Shell */}
      <div className="flex-1 lg:pl-64 flex flex-col min-w-0">
        <header className="h-16 bg-white border-b border-slate-200 px-6 lg:px-8 flex items-center justify-between gap-8 sticky top-0 z-20">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-2 -ml-2 text-slate-600 hover:text-slate-900"
              aria-label="Open navigation"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="text-sm text-slate-500 truncate">
              <span>{session.workspaceName}</span>
              <span className="mx-2 text-slate-300">/</span>
              <span className="font-medium text-slate-900">{currentNav.label}</span>
            </div>
          </div>

          <button
            type="button"
            onClick={() => openTestChat()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-700 transition-colors whitespace-nowrap shrink-0"
          >
            <MessageSquare className="w-3.5 h-3.5" />
            Open Test Chat
          </button>
        </header>

        <main className="flex-1 p-6 lg:p-8 max-w-6xl w-full mx-auto">
          {currentNav.id === 'usage' && (
            <UsageView
              session={session}
              onNavigate={(tab) => setActiveTab(tab as NavId)}
            />
          )}
          {currentNav.id === 'agents' && (
            <AgentsView
              session={session}
              onOpenChat={(slug) => openTestChat(slug)}
              onGoTemplates={() => setActiveTab('templates')}
            />
          )}
          {currentNav.id === 'templates' && (
            <TemplatesView
              session={session}
              onInstalled={() => setActiveTab('agents')}
            />
          )}
          {currentNav.id === 'chat' && (
            <TestChatView
              session={session}
              initialModel={chatModelOverride}
              onNavigate={(tab) => setActiveTab(tab as NavId)}
            />
          )}
          {currentNav.id === 'providers' && <ProvidersView session={session} />}
          {currentNav.id === 'governance' && <GovernanceView session={session} />}
          {currentNav.id === 'keys' && <ApiKeysView session={session} />}
          {currentNav.id === 'deploy' && <DeployView session={session} />}
        </main>
      </div>
    </div>
  );
}
