'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Monitor,
  Wifi,
  WifiOff,
  RefreshCw,
  Activity,
  ShieldBan,
  ShieldCheck,
  Ban,
  Clock,
  Cpu,
  MemoryStick,
  TrendingUp,
  Zap,
  XCircle,
  CheckCircle2,
  Loader2,
  Send,
  Trash2,
  Eye,
  Server,
} from 'lucide-react';
import { toast } from 'sonner';

// ── Types ──────────────────────────────────────────────────────────────────

interface ScreenshotData {
  available: boolean;
  timestamp: string;
  action: {
    actionType: string;
    currentState: string;
    reasoning: string;
  };
  screenshot: string;
}

interface Provider {
  name: string;
  healthScore: number;
  totalCalls: number;
  successRate: number;
  avgLatencyMs: number;
  isAvailable: boolean;
  circuitBreaker: {
    state: string;
    failures: number;
    lastFailure?: string;
  };
}

interface FullStatus {
  currentState: string;
  questionsCompleted: number;
  cyclesCompleted: number;
  uptime: string;
  memoryUsage: string;
  [key: string]: unknown;
}

interface BannedAction {
  action_type: string;
  reason: string;
  bannedAt?: string;
}

// ── Proxy helper ────────────────────────────────────────────────────────────

async function proxyFetch<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const res = await fetch(`/api/proxy/${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(errBody.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ── Connection status hook ─────────────────────────────────────────────────

function useConnectionStatus() {
  const [status, setStatus] = useState<'connected' | 'disconnected' | 'checking'>('checking');

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        await proxyFetch('full-status');
        if (!cancelled) setStatus('connected');
      } catch {
        if (!cancelled) setStatus('disconnected');
      }
    };
    check();
    const interval = setInterval(check, 30000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return status;
}

// ── Health bar color helper ─────────────────────────────────────────────────

function healthColor(score: number): string {
  if (score >= 80) return 'bg-emerald-500';
  if (score >= 50) return 'bg-amber-500';
  return 'bg-red-500';
}

function healthTextColor(score: number): string {
  if (score >= 80) return 'text-emerald-400';
  if (score >= 50) return 'text-amber-400';
  return 'text-red-400';
}

// ── Screenshot section ─────────────────────────────────────────────────────

function ScreenshotSection() {
  const [data, setData] = useState<ScreenshotData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(10);
  const intervalRef = useRef<ReturnType<typeof setInterval>>();
  const countdownRef = useRef<ReturnType<typeof setInterval>>();

  const fetchScreenshot = useCallback(async () => {
    try {
      const result = await proxyFetch<ScreenshotData>('screenshot');
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch screenshot');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchScreenshot();

    countdownRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) return 10;
        return prev - 1;
      });
    }, 1000);

    intervalRef.current = setInterval(fetchScreenshot, 10000);

    return () => {
      clearInterval(intervalRef.current);
      clearInterval(countdownRef.current);
    };
  }, [fetchScreenshot]);

  return (
    <Card className="border-zinc-800 bg-zinc-900/80">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Monitor className="h-5 w-5 text-emerald-400" />
            <CardTitle className="text-lg">Live Screenshot</CardTitle>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-500 font-mono">Refresh in {countdown}s</span>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-zinc-400 hover:text-zinc-200"
              onClick={() => {
                setLoading(true);
                fetchScreenshot();
                setCountdown(10);
              }}
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading && !data ? (
          <div className="space-y-3">
            <Skeleton className="w-full aspect-[4/3] rounded-lg bg-zinc-800" />
            <Skeleton className="h-4 w-48 bg-zinc-800" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center aspect-[4/3] rounded-lg border border-zinc-800 bg-zinc-950/50 text-center p-6">
            <WifiOff className="h-10 w-10 text-red-400 mb-3" />
            <p className="text-sm text-zinc-400">Unable to fetch screenshot</p>
            <p className="text-xs text-zinc-600 mt-1">{error}</p>
          </div>
        ) : data && data.screenshot ? (
          <>
            <div className="relative rounded-lg overflow-hidden border border-zinc-800 bg-black">
              <img
                src={`data:image/jpeg;base64,${data.screenshot}`}
                alt="Bot screenshot"
                className="w-full h-auto"
              />
            </div>
            {data.action && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 flex-wrap">
                  {data.action.actionType && (
                    <Badge
                      variant="outline"
                      className="border-emerald-500/40 text-emerald-400 bg-emerald-500/10"
                    >
                      <Zap className="h-3 w-3 mr-1" />
                      {data.action.actionType}
                    </Badge>
                  )}
                  {data.action.currentState && (
                    <Badge
                      variant="outline"
                      className="border-amber-500/40 text-amber-400 bg-amber-500/10"
                    >
                      <Activity className="h-3 w-3 mr-1" />
                      {data.action.currentState}
                    </Badge>
                  )}
                </div>
                {data.action.reasoning && (
                  <p className="text-xs text-zinc-500 leading-relaxed">
                    {data.action.reasoning}
                  </p>
                )}
                {data.timestamp && (
                  <p className="text-xs text-zinc-600 flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {new Date(data.timestamp).toLocaleString()}
                  </p>
                )}
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-col items-center justify-center aspect-[4/3] rounded-lg border border-zinc-800 bg-zinc-950/50 text-center p-6">
            <Eye className="h-10 w-10 text-zinc-600 mb-3" />
            <p className="text-sm text-zinc-400">No screenshot available</p>
            <p className="text-xs text-zinc-600 mt-1">Bot may not be running or screenshot capture is disabled</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── State control section ───────────────────────────────────────────────────

function StateControlSection() {
  const [fullStatus, setFullStatus] = useState<FullStatus | null>(null);
  const [stateInput, setStateInput] = useState('');
  const [setting, setSetting] = useState(false);
  const [loading, setLoading] = useState(true);

  const fetchStatus = useCallback(async () => {
    try {
      const result = await proxyFetch<FullStatus>('full-status');
      setFullStatus(result);
    } catch {
      // silent fail for background refresh
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 30000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  const handleSetState = async () => {
    if (!stateInput.trim()) return;
    setSetting(true);
    try {
      await proxyFetch('set-state', {
        method: 'POST',
        body: JSON.stringify({ state: stateInput.trim() }),
      });
      toast.success(`State set to: ${stateInput.trim()}`);
      setStateInput('');
      fetchStatus();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to set state');
    } finally {
      setSetting(false);
    }
  };

  return (
    <Card className="border-zinc-800 bg-zinc-900/80">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Activity className="h-5 w-5 text-amber-400" />
          <CardTitle className="text-lg">State Control</CardTitle>
        </div>
        <CardDescription>Manually set the bot&apos;s current state</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <p className="text-xs text-zinc-500 mb-1.5 uppercase tracking-wider font-medium">Current State</p>
          {loading ? (
            <Skeleton className="h-8 w-48 bg-zinc-800" />
          ) : fullStatus?.currentState ? (
            <Badge variant="secondary" className="text-sm px-3 py-1 bg-zinc-800 text-zinc-200">
              {fullStatus.currentState}
            </Badge>
          ) : (
            <span className="text-sm text-zinc-600">Unknown</span>
          )}
        </div>
        <div className="space-y-2">
          <p className="text-xs text-zinc-500 uppercase tracking-wider font-medium">Set New State</p>
          <div className="flex gap-2">
            <Input
              placeholder="e.g. IDLE, SOLVING, REVIEWING..."
              value={stateInput}
              onChange={(e) => setStateInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSetState()}
              className="bg-zinc-800 border-zinc-700 text-zinc-200 placeholder:text-zinc-600 focus-visible:ring-zinc-600"
            />
            <Button
              onClick={handleSetState}
              disabled={setting || !stateInput.trim()}
              className="bg-emerald-600 hover:bg-emerald-700 text-white shrink-0"
            >
              {setting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Provider health section ─────────────────────────────────────────────────

function ProviderHealthSection() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchProviders = useCallback(async () => {
    try {
      const result = await proxyFetch<{ providers: Provider[] }>('providers');
      setProviders(result.providers || []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch providers');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProviders();
    const interval = setInterval(fetchProviders, 30000);
    return () => clearInterval(interval);
  }, [fetchProviders]);

  return (
    <Card className="border-zinc-800 bg-zinc-900/80">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Server className="h-5 w-5 text-emerald-400" />
            <CardTitle className="text-lg">Provider Health</CardTitle>
          </div>
          {!loading && providers.length > 0 && (
            <Badge variant="outline" className="border-zinc-700 text-zinc-400">
              {providers.filter((p) => p.isAvailable).length}/{providers.length} active
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-24 w-full rounded-lg bg-zinc-800" />
            ))}
          </div>
        ) : error ? (
          <div className="text-center py-6">
            <XCircle className="h-8 w-8 text-red-400 mx-auto mb-2" />
            <p className="text-sm text-zinc-500">Failed to load providers</p>
          </div>
        ) : providers.length === 0 ? (
          <div className="text-center py-6">
            <Server className="h-8 w-8 text-zinc-600 mx-auto mb-2" />
            <p className="text-sm text-zinc-500">No providers found</p>
          </div>
        ) : (
          <div className="space-y-3 max-h-[420px] overflow-y-auto pr-1 scrollbar-thin">
            {providers.map((provider) => (
              <div
                key={provider.name}
                className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 space-y-2.5"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Cpu className="h-4 w-4 text-zinc-500" />
                    <span className="text-sm font-medium text-zinc-200">
                      {provider.name}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    {provider.circuitBreaker?.state === 'OPEN' ? (
                      <Badge
                        variant="destructive"
                        className="text-[10px] px-1.5 py-0"
                      >
                        CIRCUIT OPEN
                      </Badge>
                    ) : provider.isAvailable ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                    ) : (
                      <XCircle className="h-4 w-4 text-red-400" />
                    )}
                  </div>
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-zinc-500">Health Score</span>
                    <span className={`font-mono font-medium ${healthTextColor(provider.healthScore)}`}>
                      {provider.healthScore.toFixed(0)}%
                    </span>
                  </div>
                  <div className="relative h-1.5 w-full rounded-full bg-zinc-800 overflow-hidden">
                    <div
                      className={`absolute left-0 top-0 h-full rounded-full transition-all duration-500 ${healthColor(provider.healthScore)}`}
                      style={{ width: `${provider.healthScore}%` }}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <span className="text-zinc-600">Calls</span>
                    <p className="font-mono text-zinc-300">{provider.totalCalls.toLocaleString()}</p>
                  </div>
                  <div>
                    <span className="text-zinc-600">Success</span>
                    <p className={`font-mono ${provider.successRate >= 80 ? 'text-emerald-400' : provider.successRate >= 50 ? 'text-amber-400' : 'text-red-400'}`}>
                      {provider.successRate.toFixed(1)}%
                    </p>
                  </div>
                  <div>
                    <span className="text-zinc-600">Latency</span>
                    <p className={`font-mono ${provider.avgLatencyMs < 2000 ? 'text-emerald-400' : provider.avgLatencyMs < 5000 ? 'text-amber-400' : 'text-red-400'}`}>
                      {(provider.avgLatencyMs / 1000).toFixed(1)}s
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Bot stats section ──────────────────────────────────────────────────────

function BotStatsSection() {
  const [stats, setStats] = useState<FullStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchStats = useCallback(async () => {
    try {
      const result = await proxyFetch<FullStatus>('full-status');
      setStats(result);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 30000);
    return () => clearInterval(interval);
  }, [fetchStats]);

  const statItems = [
    {
      label: 'Questions Done',
      value: stats?.questionsCompleted ?? 0,
      icon: TrendingUp,
      color: 'text-emerald-400',
      bgColor: 'bg-emerald-500/10',
      borderColor: 'border-emerald-500/20',
    },
    {
      label: 'Cycles',
      value: stats?.cyclesCompleted ?? 0,
      icon: RefreshCw,
      color: 'text-amber-400',
      bgColor: 'bg-amber-500/10',
      borderColor: 'border-amber-500/20',
    },
    {
      label: 'Uptime',
      value: stats?.uptime ?? '—',
      icon: Clock,
      color: 'text-zinc-300',
      bgColor: 'bg-zinc-500/10',
      borderColor: 'border-zinc-500/20',
      isText: true,
    },
    {
      label: 'Memory',
      value: stats?.memoryUsage ?? '—',
      icon: MemoryStick,
      color: 'text-zinc-300',
      bgColor: 'bg-zinc-500/10',
      borderColor: 'border-zinc-500/20',
      isText: true,
    },
  ];

  return (
    <Card className="border-zinc-800 bg-zinc-900/80">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-5 w-5 text-emerald-400" />
          <CardTitle className="text-lg">Bot Stats</CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="grid grid-cols-2 gap-3">
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-20 rounded-lg bg-zinc-800" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {statItems.map((item) => (
              <div
                key={item.label}
                className={`rounded-lg border ${item.borderColor} ${item.bgColor} p-3`}
              >
                <div className="flex items-center gap-1.5 mb-1.5">
                  <item.icon className={`h-3.5 w-3.5 ${item.color}`} />
                  <span className="text-xs text-zinc-500 font-medium">{item.label}</span>
                </div>
                <p className={`text-lg font-semibold font-mono ${item.color} ${item.isText ? 'text-sm' : ''}`}>
                  {item.isText ? String(item.value) : Number(item.value).toLocaleString()}
                </p>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Action banning section ──────────────────────────────────────────────────

function ActionBanningSection() {
  const [bannedActions, setBannedActions] = useState<BannedAction[]>([]);
  const [actionType, setActionType] = useState('');
  const [reason, setReason] = useState('');
  const [banning, setBanning] = useState(false);
  const [loading, setLoading] = useState(true);

  const fetchBanned = useCallback(async () => {
    try {
      const result = await proxyFetch<{ banned_actions?: BannedAction[] } | BannedAction[]>('banned-actions');
      // handle both array and { banned_actions: [] } response
      if (Array.isArray(result)) {
        setBannedActions(result);
      } else if (result && 'banned_actions' in result) {
        setBannedActions(result.banned_actions || []);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBanned();
  }, [fetchBanned]);

  const handleBan = async () => {
    if (!actionType.trim()) return;
    setBanning(true);
    try {
      await proxyFetch('banned-actions', {
        method: 'POST',
        body: JSON.stringify({ action_type: actionType.trim(), reason: reason.trim() }),
      });
      toast.success(`Banned action: ${actionType.trim()}`);
      setActionType('');
      setReason('');
      fetchBanned();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to ban action');
    } finally {
      setBanning(false);
    }
  };

  const handleUnban = async (action: string) => {
    try {
      await proxyFetch('banned-actions', {
        method: 'DELETE',
        body: JSON.stringify({ action_type: action }),
      });
      toast.success(`Unbanned action: ${action}`);
      fetchBanned();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to unban action');
    }
  };

  return (
    <Card className="border-zinc-800 bg-zinc-900/80">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldBan className="h-5 w-5 text-red-400" />
            <CardTitle className="text-lg">Action Banning</CardTitle>
          </div>
          {!loading && bannedActions.length > 0 && (
            <Badge variant="destructive" className="text-xs">
              {bannedActions.length} banned
            </Badge>
          )}
        </div>
        <CardDescription>Block or unblock specific bot actions</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Ban form */}
        <div className="flex flex-col sm:flex-row gap-2">
          <Input
            placeholder="Action type to ban (e.g. CLICK_ANSWER)"
            value={actionType}
            onChange={(e) => setActionType(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleBan()}
            className="bg-zinc-800 border-zinc-700 text-zinc-200 placeholder:text-zinc-600 focus-visible:ring-zinc-600 flex-1"
          />
          <Input
            placeholder="Reason for ban (optional)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleBan()}
            className="bg-zinc-800 border-zinc-700 text-zinc-200 placeholder:text-zinc-600 focus-visible:ring-zinc-600 flex-1"
          />
          <Button
            onClick={handleBan}
            disabled={banning || !actionType.trim()}
            variant="destructive"
            className="shrink-0"
          >
            {banning ? (
              <Loader2 className="h-4 w-4 animate-spin mr-1" />
            ) : (
              <Ban className="h-4 w-4 mr-1" />
            )}
            Ban
          </Button>
        </div>

        {/* Banned actions list */}
        {loading ? (
          <div className="space-y-2">
            {[1, 2].map((i) => (
              <Skeleton key={i} className="h-10 w-full bg-zinc-800" />
            ))}
          </div>
        ) : bannedActions.length === 0 ? (
          <div className="text-center py-6">
            <ShieldCheck className="h-8 w-8 text-emerald-500/50 mx-auto mb-2" />
            <p className="text-sm text-zinc-500">No actions are currently banned</p>
          </div>
        ) : (
          <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
            {bannedActions.map((action) => (
              <div
                key={action.action_type}
                className="flex items-center justify-between gap-3 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Badge variant="destructive" className="text-[10px] px-1.5 py-0 shrink-0">
                      BANNED
                    </Badge>
                    <span className="text-sm font-mono font-medium text-red-300 truncate">
                      {action.action_type}
                    </span>
                  </div>
                  {action.reason && (
                    <p className="text-xs text-zinc-500 mt-0.5 truncate">
                      {action.reason}
                    </p>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-zinc-500 hover:text-emerald-400 shrink-0"
                  onClick={() => handleUnban(action.action_type)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Main page ───────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const connectionStatus = useConnectionStatus();

  return (
    <div className="min-h-screen flex flex-col bg-zinc-950 text-zinc-100">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-zinc-800 bg-zinc-950/90 backdrop-blur-sm">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex h-14 items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <div className="h-7 w-7 rounded-lg bg-emerald-600 flex items-center justify-center">
                  <Zap className="h-4 w-4 text-white" />
                </div>
                <h1 className="text-lg font-bold tracking-tight">MathU Bot</h1>
              </div>
              <Badge
                variant="outline"
                className="border-zinc-700 text-zinc-400 text-[10px] font-mono hidden sm:inline-flex"
              >
                CONTROL DASHBOARD
              </Badge>
            </div>
            <div className="flex items-center gap-2">
              <div
                className={`h-2 w-2 rounded-full ${
                  connectionStatus === 'connected'
                    ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]'
                    : connectionStatus === 'disconnected'
                      ? 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)]'
                      : 'bg-amber-500 animate-pulse'
                }`}
              />
              <span className="text-xs text-zinc-500 hidden sm:inline">
                {connectionStatus === 'connected'
                  ? 'Connected'
                  : connectionStatus === 'disconnected'
                    ? 'Disconnected'
                    : 'Checking...'}
              </span>
              {connectionStatus === 'connected' ? (
                <Wifi className="h-4 w-4 text-emerald-400" />
              ) : connectionStatus === 'disconnected' ? (
                <WifiOff className="h-4 w-4 text-red-400" />
              ) : (
                <Loader2 className="h-4 w-4 text-amber-400 animate-spin" />
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        {/* Two-column layout: screenshot+state (left), providers+stats (right) */}
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          {/* Left column — wider */}
          <div className="lg:col-span-3 space-y-6">
            <ScreenshotSection />
            <StateControlSection />
          </div>

          {/* Right column — narrower */}
          <div className="lg:col-span-2 space-y-6">
            <BotStatsSection />
            <ProviderHealthSection />
          </div>
        </div>

        {/* Bottom section — action banning, full width */}
        <ActionBanningSection />
      </main>

      {/* Footer */}
      <footer className="mt-auto border-t border-zinc-800/60 bg-zinc-950">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-3">
          <p className="text-center text-xs text-zinc-600">
            MathU Bot Dashboard &middot; Data refreshes automatically &middot; Configure{' '}
            <code className="text-zinc-500 font-mono bg-zinc-900 px-1.5 py-0.5 rounded text-[10px]">
              BOT_API_URL
            </code>{' '}
            to connect
          </p>
        </div>
      </footer>
    </div>
  );
}
