import { useEffect, useState, useCallback } from 'react';
import { Loader2 } from 'lucide-react';
import { PageHeader } from '../components/AppLayout';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Switch } from '../components/ui';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from '../components/ui/dialog';
import type {
  CliAliasStatus,
  HarnessAuthMode,
  HarnessProvider,
  HarnessSettingsStatus,
  HarnessSettingsUpdate,
  ServerConfigInfo,
  TelemetryStatusResult,
} from '../../shared/ipc-types';
import { ServerUrlSource } from '../../shared/ipc-types';
import { normalizeServerUrl } from '../../shared/server-url-format';
import { useAuthStore } from '../stores/auth-store';
import { useUpdateStore } from '../stores/update-store';
import { initTelemetry, shutdownTelemetry } from '../telemetry';
import { InboxIn, Refresh, TrashBinTrash } from '@solar-icons/react';

type SaveStatus = 'idle' | 'saving' | 'success' | 'error';

function LogoutDialog() {
  const { logout, loading } = useAuthStore();
  const [showLogoutDialog, setShowLogoutDialog] = useState(false);

  const handleLogout = async () => {
    await logout();
    setShowLogoutDialog(false);
  };

  return (
    <Dialog open={showLogoutDialog} onOpenChange={setShowLogoutDialog}>
      <DialogTrigger asChild>
        <Button variant="outline" className="text-sm shadow-action" onClick={() => setShowLogoutDialog(true)}>
          Logout
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Log out of CoreDoc?</DialogTitle>
          <DialogDescription className="text-sm font-medium text-content-secondary leading-5">
            You will lose access to all cloud workspaces and team features. Local workspaces will remain available.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="secondary" onClick={() => setShowLogoutDialog(false)} disabled={loading}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleLogout} disabled={loading}>
            {loading ? <Loader2 className="size-3.5 animate-spin mr-1.5" /> : null}
            Log out
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LogoutButton() {
  const { isLoggedIn } = useAuthStore();
  if (!isLoggedIn) return null;

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-base font-extrabold text-content-primary">Danger zone</h3>
      <div className="flex items-center gap-2.5">
        <LogoutDialog />
      </div>
    </div>
  );
}

/**
 * Which Coredoc server this app talks to. Sits above Account because it is the
 * pre-login decision: an on-prem user must be able to point the app at their
 * own server before the login browser round-trip.
 */
function ServerSection() {
  const { isLoggedIn } = useAuthStore();
  const [config, setConfig] = useState<ServerConfigInfo | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [cliStale, setCliStale] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: isLoggedIn is an intentional re-fetch trigger — after login the stored tokens' server becomes the runtime override, changing the resolved value and its source.
  useEffect(() => {
    void window.electronAPI.workspaceGetServerConfig().then(setConfig);
  }, [isLoggedIn]);

  const handleSave = useCallback(async () => {
    if (draft === null) return;
    const normalized = normalizeServerUrl(draft);
    if (!normalized) {
      setError('Enter a full http:// or https:// server URL');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const result = await window.electronAPI.workspaceSetServerUrl(normalized);
      setConfig(result);
      setCliStale(result.requiresCliReinstall);
      setDraft(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the server URL');
    } finally {
      setSaving(false);
    }
  }, [draft]);

  if (!config) return null;

  const isManaged = config.source === ServerUrlSource.Managed;
  const isEnv = config.source === ServerUrlSource.Env;
  // Changing servers mid-session would strand the current tokens on the old
  // one, so the affordance is pre-login only (and never under managed config).
  const canChange = !isManaged && !isLoggedIn;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2.5">
        <div className="flex-1 flex flex-col gap-1">
          <div className="flex gap-1 items-center px-0.5">
            <h2 className="text-base font-extrabold text-content-primary">Server</h2>
          </div>
          <div className="flex gap-1 items-center px-0.5">
            <span className="text-sm font-medium text-content-tertiary">{config.url}</span>
          </div>
          {isManaged ? (
            <p className="px-0.5 text-xs font-medium text-content-quaternary">Managed by your organization</p>
          ) : null}
          {isEnv ? (
            <p className="px-0.5 text-xs font-medium text-content-quaternary">Set by COREDOC_SERVER_URL</p>
          ) : null}
          {cliStale ? (
            <p className="px-0.5 text-xs font-medium text-content-quaternary">
              The installed <code>coredoc</code> terminal command still points at the previous server — reinstall it
              below.
            </p>
          ) : null}
          {error ? <p className="px-0.5 text-xs text-red-500">{error}</p> : null}
        </div>
        {canChange && draft === null && (
          <Button variant="secondary" onClick={() => setDraft(config.url)}>
            Change server
          </Button>
        )}
      </div>

      {canChange && draft !== null && (
        <div className="flex items-center gap-2">
          <Input
            aria-label="Coredoc server URL"
            placeholder="https://coredoc.your-company.com"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={saving}
          />
          <Button onClick={() => void handleSave()} disabled={saving}>
            {saving ? <Loader2 className="size-3.5 animate-spin mr-1.5" /> : null}
            Save
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setDraft(null);
              setError('');
            }}
            disabled={saving}
          >
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}

function AccountSection() {
  const { isLoggedIn, email, login, loading, error } = useAuthStore();

  return (
    <div className="flex items-center gap-2.5">
      <div className="flex-1 flex flex-col gap-1">
        <div className="flex gap-1 items-center px-0.5">
          <h2 className="text-base font-extrabold text-content-primary">Account</h2>
        </div>
        {isLoggedIn ? (
          <div className="flex gap-0.5 items-center px-0.5">
            <span className="text-sm font-medium text-content-primary">Email:</span>
            <span className="text-sm font-medium text-content-tertiary">{email}</span>
          </div>
        ) : (
          <p className="px-0.5 text-sm font-medium text-content-tertiary">
            Log in to sync workspaces and access more value & features
          </p>
        )}
        {error ? <p className="px-0.5 text-xs text-red-500">{error}</p> : null}
      </div>
      {!isLoggedIn && (
        <Button onClick={() => login()} disabled={loading}>
          {loading ? <Loader2 className="size-3.5 animate-spin mr-1.5" /> : null}
          Login
        </Button>
      )}
    </div>
  );
}

function HarnessSection() {
  const [status, setStatus] = useState<HarnessSettingsStatus | null>(null);
  const [token, setToken] = useState('');
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [saveError, setSaveError] = useState('');

  const loadStatus = useCallback(async () => {
    const result = await window.electronAPI.getHarnessSettings();
    setStatus(result);
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const applyUpdate = useCallback(
    async (update: HarnessSettingsUpdate) => {
      setSaveStatus('saving');
      setSaveError('');
      try {
        const result = await window.electronAPI.updateHarnessSettings(update);
        if (!result.success) throw new Error(result.error || 'Failed to save');
        await loadStatus();
        setSaveStatus('success');
      } catch (error) {
        setSaveStatus('error');
        setSaveError(error instanceof Error ? error.message : 'Unknown error');
      }
    },
    [loadStatus],
  );

  const handleSave = useCallback(async () => {
    if (!status || !token.trim()) return;
    setSaveStatus('saving');
    await applyUpdate({ credential: { provider: status.provider, value: token.trim() } });
    setToken('');
  }, [applyUpdate, status, token]);

  const handleClear = useCallback(async () => {
    if (!status) return;
    await applyUpdate({ credential: { provider: status.provider, value: '' } });
    setToken('');
  }, [applyUpdate, status]);

  const isDirty = token.trim().length > 0;
  const providerLabel = status?.provider === 'codex' ? 'Codex' : 'Claude Code';
  const credentialStatus = status ? status.credentials[status.provider] : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1 px-0.5">
        <h2 className="text-base font-extrabold text-content-primary">AI harness</h2>
        <p className="text-sm font-medium text-content-tertiary leading-5">
          Choose the coding agent used for profile generation, summaries, and chat in this workspace.
        </p>
      </div>

      {status && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5 text-sm font-medium text-content-primary">
              <span>Provider</span>
              <Select
                value={status.provider}
                onValueChange={(value) => {
                  setToken('');
                  void applyUpdate({ provider: value as HarnessProvider });
                }}
                disabled={saveStatus === 'saving'}
              >
                <SelectTrigger className="w-full" aria-label="Harness provider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="claude-code">Claude Code</SelectItem>
                  <SelectItem value="codex">Codex</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5 text-sm font-medium text-content-primary">
              <span>Authentication</span>
              <Select
                value={status.authMode}
                onValueChange={(value) => {
                  setToken('');
                  void applyUpdate({ authMode: value as HarnessAuthMode });
                }}
                disabled={saveStatus === 'saving'}
              >
                <SelectTrigger className="w-full" aria-label="Harness authentication">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="subscription">Subscription</SelectItem>
                  <SelectItem value="api-token">API token</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {status.authMode === 'subscription' ? (
            <p className="px-0.5 text-sm font-medium text-content-tertiary leading-5">
              Uses the saved {providerLabel} CLI login on this computer. Coredoc does not require or store a token.
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {credentialStatus?.isSet && credentialStatus.maskedValue ? (
                <div className="relative">
                  <div className="flex items-center h-9 rounded-lg border border-border-input bg-bg-primary px-3 pr-10 shadow-field">
                    <span className="font-mono text-sm font-medium text-content-tertiary">
                      {credentialStatus.maskedValue}
                    </span>
                  </div>
                  <button
                    type="button"
                    aria-label={`Clear ${providerLabel} API token`}
                    className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center justify-center size-8 rounded-sm text-content-warning hover:text-content-warning cursor-pointer"
                    onClick={handleClear}
                    disabled={saveStatus === 'saving'}
                  >
                    <TrashBinTrash weight="Outline" className="size-5" />
                  </button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <Input
                    type="password"
                    aria-label={`${providerLabel} API token`}
                    placeholder={`Enter ${providerLabel} API token`}
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && isDirty) void handleSave();
                    }}
                    className="flex-1"
                  />
                  <Button onClick={handleSave} disabled={!isDirty || saveStatus === 'saving'}>
                    {saveStatus === 'saving' && <Loader2 className="size-3.5 animate-spin mr-1.5" />}
                    {saveStatus === 'saving' ? 'Saving...' : 'Save'}
                  </Button>
                </div>
              )}
              <p className="px-0.5 text-sm font-medium text-content-tertiary leading-5">
                Stored only in this workspace’s local .env file and passed only to {providerLabel} runs.
              </p>
            </div>
          )}
        </>
      )}

      {saveStatus === 'success' && (
        <p className="px-0.5 text-sm font-medium text-content-brand">Harness settings saved</p>
      )}
      {saveStatus === 'error' && <p className="px-0.5 text-sm font-medium text-content-warning">{saveError}</p>}
    </div>
  );
}

function TerminalCommandSection() {
  const [status, setStatus] = useState<CliAliasStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);

  const loadStatus = useCallback(async () => {
    const result = await window.electronAPI.getCliAliasStatus();
    setStatus(result);
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const handleInstall = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    const result = await window.electronAPI.installCliAlias();
    setStatus(result.status);
    if (result.success) {
      setMessage({ tone: 'success', text: result.note ?? `Installed` });
    } else {
      setMessage({ tone: 'error', text: result.error ?? 'Install failed' });
    }
    setBusy(false);
  }, []);

  const handleUninstall = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    const result = await window.electronAPI.uninstallCliAlias();
    setStatus(result.status);
    if (result.success) {
      setMessage({ tone: 'success', text: 'Terminal command removed.' });
    } else {
      setMessage({ tone: 'error', text: result.error ?? 'Uninstall failed' });
    }
    setBusy(false);
  }, []);

  if (!status) return null;

  const unsupported = !!status.unsupportedReason;

  return (
    <div className="flex flex-col gap-2">
      <h2 className="px-0.5 text-base font-extrabold text-content-primary">Terminal command</h2>

      <p className="px-0.5 text-sm font-medium text-content-tertiary leading-5">
        Install the <span className="font-mono">coredoc</span> command on your PATH so you can run CLI subcommands (for
        example <span className="font-mono">coredoc mapper validate</span>) from any terminal. Works without Node.js
        installed and doesn't require the desktop app to be open.
      </p>

      {unsupported ? (
        <p className="px-0.5 text-sm font-medium text-content-warning">{status.unsupportedReason}</p>
      ) : (
        <>
          <div className="flex items-center gap-2.5">
            <div className="flex-1 flex flex-col gap-0.5">
              <div className="flex gap-1 items-center px-0.5">
                <span className="text-sm font-medium text-content-primary">Status:</span>
                <span className="text-sm font-medium text-content-tertiary">
                  {status.installed ? 'Installed' : 'Not installed'}
                </span>
              </div>
            </div>
            {status.installed ? (
              <Button variant="outline" onClick={handleUninstall} disabled={busy} className="shadow-action">
                {busy ? <Loader2 className="size-3.5 animate-spin mr-1.5" /> : null}
                Remove
              </Button>
            ) : (
              <Button onClick={handleInstall} disabled={busy}>
                {busy ? <Loader2 className="size-3.5 animate-spin mr-1.5" /> : null}
                Install
              </Button>
            )}
          </div>

          {status.hint && !status.installed && (
            <p className="px-0.5 text-xs font-medium text-content-tertiary">{status.hint}</p>
          )}
          {message && (
            <p
              className={`px-0.5 text-xs font-medium ${
                message.tone === 'success' ? 'text-content-brand' : 'text-red-500'
              }`}
            >
              {message.text}
            </p>
          )}
        </>
      )}
    </div>
  );
}

function UpdatesSection() {
  const { status, availableVersion, downloadProgress, error, checkForUpdate, installUpdate, initListener } =
    useUpdateStore();

  useEffect(() => {
    const unsubscribe = initListener();
    return unsubscribe;
  }, [initListener]);

  const isChecking = status === 'checking';
  const isDownloading = status === 'downloading';
  const isReady = status === 'ready';
  const isAvailable = status === 'available';
  const hasUpdate = isAvailable || isDownloading || isReady;

  const statusLabel = hasUpdate ? '(New version available)' : status === 'error' ? '(Error)' : '(Up to date)';

  const statusColor = hasUpdate ? 'text-amber-500' : status === 'error' ? 'text-red-500' : 'text-content-brand';

  return (
    <div className="flex gap-3 items-center">
      <div className="flex-1 flex flex-col gap-1">
        <div className="flex gap-1.5 items-baseline px-0.5">
          <h2 className="text-base font-extrabold text-content-primary">Updates</h2>
          <span className={`text-sm font-normal ${statusColor}`}>{statusLabel}</span>
        </div>
        <p className="px-0.5 text-sm font-medium text-content-tertiary leading-5">Download and install updates.</p>

        {isDownloading && (
          <div className="mt-1 space-y-1">
            <p className="px-0.5 text-xs text-content-tertiary">
              Downloading v{availableVersion}... {downloadProgress != null ? `${downloadProgress}%` : ''}
            </p>
            <div className="w-full bg-bg-overlay rounded-full h-1.5">
              <div
                className="bg-content-brand h-1.5 rounded-full transition-all"
                style={{ width: `${downloadProgress ?? 0}%` }}
              />
            </div>
          </div>
        )}

        {status === 'error' && error && (
          <div className="mt-1">
            <p className="px-0.5 text-xs text-red-500">{error}</p>
          </div>
        )}
      </div>

      <div className="shrink-0">
        {isChecking ? (
          <Button variant="secondary" size="sm" disabled className="gap-1.5 shadow-action">
            <Loader2 className="size-4 animate-spin" />
            Checking...
          </Button>
        ) : status === 'error' ? (
          <Button variant="secondary" size="sm" className="gap-1.5 shadow-action" onClick={checkForUpdate}>
            <Refresh weight="Outline" className="size-4" />
            Retry
          </Button>
        ) : (isReady || isAvailable) && !isDownloading ? (
          <Button
            variant="secondary"
            size="sm"
            className="gap-1.5 shadow-action"
            onClick={isReady ? installUpdate : checkForUpdate}
          >
            <InboxIn weight="Outline" className="size-4" />
            {`Update to v ${availableVersion}`}
          </Button>
        ) : !hasUpdate ? (
          <Button variant="secondary" size="sm" className="gap-1.5 shadow-action" onClick={checkForUpdate}>
            <Refresh weight="Outline" className="size-4" />
            Check for updates
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function TelemetrySection() {
  const [status, setStatus] = useState<TelemetryStatusResult | null>(null);
  const [toggling, setToggling] = useState(false);

  const loadStatus = useCallback(async () => {
    const result = await window.electronAPI.getTelemetryStatus();
    setStatus(result);
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const handleToggle = useCallback(async () => {
    if (!status) return;
    setToggling(true);
    const newEnabled = !status.enabled;
    await window.electronAPI.setTelemetryEnabled(newEnabled);

    if (newEnabled) {
      await initTelemetry();
    } else {
      shutdownTelemetry();
    }

    await loadStatus();
    setToggling(false);
  }, [status, loadStatus]);

  return (
    <div className="flex gap-3 items-center">
      <div className="flex-1 flex flex-col gap-1">
        <h2 className="px-0.5 text-base font-extrabold text-content-primary">Anonymous Telemetry</h2>
        <p className="px-0.5 text-sm font-medium text-content-tertiary leading-5">
          Help us improve CoreDoc by sending anonymous usage data. No code, file paths, or personal information is ever
          collected.
        </p>
      </div>
      {status && <Switch checked={status.enabled} disabled={toggling} onCheckedChange={handleToggle} />}
    </div>
  );
}

export function SettingsPage() {
  const { currentVersion } = useUpdateStore();

  return (
    <>
      <PageHeader>
        <div>
          <h1 className="text-xl font-bold text-content-primary">Settings</h1>
        </div>
      </PageHeader>

      <div className="flex-1 overflow-auto px-6 pb-2 pt-3">
        <div className="flex flex-col gap-6">
          <ServerSection />
          <AccountSection />
          <HarnessSection />
          <TerminalCommandSection />
          <UpdatesSection />
          <TelemetrySection />
          <LogoutButton />
        </div>
      </div>

      {currentVersion && (
        <div className="shrink-0 flex items-center justify-center py-0.5 bg-white/50">
          <span className="text-xs font-normal text-content-quaternary">CoreDoc v{currentVersion}</span>
        </div>
      )}
    </>
  );
}
