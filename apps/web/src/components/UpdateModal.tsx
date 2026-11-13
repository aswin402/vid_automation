import React, { useState } from 'react';
import {
  AlertCircle,
  ArrowUpCircle,
  Check,
  CheckCircle2,
  Cpu,
  Database,
  Download,
  ExternalLink,
  HardDriveDownload,
  History,
  Loader2,
  RefreshCw,
  Rocket,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { extractApiError, videoApi } from '@/api/videoApi';
import type {
  BackupInfo,
  UpdateCheckResponse,
  UpdateProgressState,
} from '@/types/video';

export type UpdateModalTab = 'update' | 'backups';

interface UpdateModalProps {
  open: boolean;
  onClose: () => void;
  activeTab: UpdateModalTab;
  onTabChange: (tab: UpdateModalTab) => void;
  updateCheck: UpdateCheckResponse | null;
  isCheckingUpdate: boolean;
  onRefreshUpdateCheck: () => Promise<void>;
  liveUpdateStatus: UpdateProgressState | null;
}

function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatShortDate(iso: string | null | undefined): string {
  if (!iso) return 'Just now';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatStrategyLabel(strategy: string | null | undefined): string {
  switch (strategy) {
    case 'windows_nsis':
      return 'Windows Per-User Auto-Installer';
    case 'windows_msi':
      return 'Windows MSI Package';
    case 'linux_appimage':
      return 'Linux AppImage · Zero-Root Auto-Swap';
    case 'linux_deb':
      return 'Debian / Ubuntu System Package';
    case 'macos_dmg':
      return 'macOS App Bundle (.dmg)';
    case 'staged_package':
      return 'Verified Update Package';
    default:
      return 'Direct Release Package';
  }
}

function isUpdateRunning(status: string | undefined): boolean {
  return Boolean(
    status &&
      ['checking', 'backing_up', 'downloading', 'verifying', 'installing'].includes(
        status
      )
  );
}

export const UpdateModal: React.FC<UpdateModalProps> = ({
  open,
  onClose,
  activeTab,
  onTabChange,
  updateCheck,
  isCheckingUpdate,
  onRefreshUpdateCheck,
  liveUpdateStatus,
}) => {
  const queryClient = useQueryClient();

  const [startingUpdate, setStartingUpdate] = useState(false);
  const [restartingApp, setRestartingApp] = useState(false);
  const [creatingBackup, setCreatingBackup] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [confirmRestoreId, setConfirmRestoreId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [bannerMessage, setBannerMessage] = useState<{
    tone: 'success' | 'error';
    text: string;
  } | null>(null);

  const systemVersionQuery = useQuery({
    queryKey: ['system-version'],
    queryFn: () => videoApi.getSystemVersion(),
    enabled: open,
    staleTime: 60_000,
  });

  const backupsQuery = useQuery({
    queryKey: ['system-backups'],
    queryFn: () => videoApi.listBackups(),
    enabled: open,
  });

  if (!open) return null;

  const currentVersion =
    updateCheck?.current_version ??
    systemVersionQuery.data?.current_version ??
    liveUpdateStatus?.current_version ??
    '0.2.3';

  const status = liveUpdateStatus?.status ?? 'idle';
  const running = isUpdateRunning(status);
  const readyToRestart = status === 'ready_to_restart';
  const updateFailed = status === 'failed';
  const showProgressPipeline =
    running || readyToRestart || (updateFailed && liveUpdateStatus !== null);

  const progressPct = Math.round(
    Math.min(100, Math.max(0, (liveUpdateStatus?.progress ?? 0) * 100))
  );

  const circleRadius = 46;
  const circleCircumference = 2 * Math.PI * circleRadius;
  const strokeDashoffset =
    circleCircumference - (progressPct / 100) * circleCircumference;

  const backups: BackupInfo[] = backupsQuery.data ?? [];

  const handleStartAutoUpdate = async () => {
    setBannerMessage(null);
    setStartingUpdate(true);
    try {
      await videoApi.startAppUpdate();
      await queryClient.invalidateQueries({ queryKey: ['system-update-status'] });
      await queryClient.invalidateQueries({ queryKey: ['system-backups'] });
    } catch (err) {
      setBannerMessage({
        tone: 'error',
        text: extractApiError(err, 'Failed to start automatic update.'),
      });
    } finally {
      setStartingUpdate(false);
    }
  };

  const handleApplyAndRestart = async () => {
    setBannerMessage(null);
    setRestartingApp(true);
    try {
      await videoApi.applyUpdateAndRestart();
    } catch (err) {
      setRestartingApp(false);
      setBannerMessage({
        tone: 'error',
        text: extractApiError(err, 'Unable to restart automatically.'),
      });
    }
  };

  const handleCreateManualBackup = async () => {
    setBannerMessage(null);
    setCreatingBackup(true);
    try {
      const snap = await videoApi.createBackup({
        label: `Manual Snapshot · v${currentVersion}`,
        include_storage: true,
      });
      await queryClient.invalidateQueries({ queryKey: ['system-backups'] });
      setBannerMessage({
        tone: 'success',
        text: `Snapshot saved (${formatBytes(snap.size_bytes)}) — ${snap.project_count} project(s), ${snap.batch_count} batch campaign(s).`,
      });
    } catch (err) {
      setBannerMessage({
        tone: 'error',
        text: extractApiError(err, 'Failed to create app data backup.'),
      });
    } finally {
      setCreatingBackup(false);
    }
  };

  const handleConfirmRestore = async (backupId: string) => {
    setBannerMessage(null);
    setRestoringId(backupId);
    try {
      const resp = await videoApi.restoreBackup(backupId);
      setConfirmRestoreId(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['system-backups'] }),
        queryClient.invalidateQueries({ queryKey: ['projects'] }),
        queryClient.invalidateQueries({ queryKey: ['batches'] }),
      ]);
      setBannerMessage({
        tone: 'success',
        text: resp.message,
      });
    } catch (err) {
      setBannerMessage({
        tone: 'error',
        text: extractApiError(err, 'Failed to restore backup snapshot.'),
      });
    } finally {
      setRestoringId(null);
    }
  };

  const handleDeleteBackup = async (backupId: string) => {
    setBannerMessage(null);
    setDeletingId(backupId);
    try {
      await videoApi.deleteBackup(backupId);
      if (confirmRestoreId === backupId) {
        setConfirmRestoreId(null);
      }
      await queryClient.invalidateQueries({ queryKey: ['system-backups'] });
    } catch (err) {
      setBannerMessage({
        tone: 'error',
        text: extractApiError(err, 'Failed to delete backup snapshot.'),
      });
    } finally {
      setDeletingId(null);
    }
  };

  // Compute 4-stage visual states for the animated pipeline
  const backupDone = Boolean(liveUpdateStatus?.backup_info) || progressPct >= 22;
  const backupActive = status === 'checking' || status === 'backing_up';

  const downloadDone =
    ['verifying', 'installing', 'ready_to_restart', 'completed'].includes(status) ||
    progressPct >= 86;
  const downloadActive = status === 'downloading';

  const installDone = status === 'ready_to_restart' || status === 'completed';
  const installActive = status === 'verifying' || status === 'installing';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="CelestiaVid Update and Backup Studio"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/65 backdrop-blur-md"
      onClick={(e) => {
        if (e.target === e.currentTarget && !running) {
          onClose();
        }
      }}
    >
      <div className="celestia-modal-card w-full max-w-xl rounded-3xl bg-card border border-border/90 shadow-2xl overflow-hidden text-card-foreground">
        {/* Top Header */}
        <div className="px-6 pt-5 pb-4 border-b border-border/70 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="h-10 w-10 rounded-2xl bg-indigo-600/15 border border-indigo-500/30 flex items-center justify-center text-indigo-400 shrink-0">
              <Sparkles className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold tracking-tight truncate">
                  Update &amp; Data Backup
                </h2>
                <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-muted text-muted-foreground border border-border">
                  v{currentVersion}
                </span>
              </div>
              <p className="text-xs text-muted-foreground truncate">
                Automatic SQLite &amp; project snapshot protection on every update
              </p>
            </div>
          </div>

          <button
            type="button"
            disabled={running}
            onClick={onClose}
            title={running ? 'Update in progress' : 'Close'}
            className="h-8 w-8 rounded-xl flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-40 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Segmented Minimal Switcher */}
        <div className="px-6 pt-3.5">
          <div className="grid grid-cols-2 gap-1 p-1 rounded-2xl bg-muted/60 border border-border/70">
            <button
              type="button"
              onClick={() => {
                setBannerMessage(null);
                onTabChange('update');
              }}
              className={`flex items-center justify-center gap-2 py-2 px-3 rounded-xl text-xs font-semibold transition-all ${
                activeTab === 'update'
                  ? 'bg-card text-foreground shadow-sm border border-border/60'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <ArrowUpCircle className="h-3.5 w-3.5" />
              <span>Software Update</span>
              {updateCheck?.update_available && !readyToRestart && (
                <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
              )}
            </button>

            <button
              type="button"
              onClick={() => {
                setBannerMessage(null);
                onTabChange('backups');
                void backupsQuery.refetch();
              }}
              className={`flex items-center justify-center gap-2 py-2 px-3 rounded-xl text-xs font-semibold transition-all ${
                activeTab === 'backups'
                  ? 'bg-card text-foreground shadow-sm border border-border/60'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Database className="h-3.5 w-3.5" />
              <span>App Data Backups</span>
              {backups.length > 0 && (
                <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-indigo-500/15 text-indigo-400 font-bold">
                  {backups.length}
                </span>
              )}
            </button>
          </div>
        </div>

        {/* Status Feedback Banner */}
        {bannerMessage && (
          <div className="px-6 pt-3">
            <div
              className={`px-3.5 py-2.5 rounded-2xl text-xs flex items-start gap-2.5 border ${
                bannerMessage.tone === 'success'
                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                  : 'bg-rose-500/10 border-rose-500/30 text-rose-400'
              }`}
            >
              {bannerMessage.tone === 'success' ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
              ) : (
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              )}
              <span className="leading-relaxed">{bannerMessage.text}</span>
            </div>
          </div>
        )}

        {/* Body Content */}
        <div className="p-6">
          {activeTab === 'update' ? (
            showProgressPipeline ? (
              /* ============== Animated Multi-Stage Update Pipeline ============== */
              <div className="space-y-5">
                <div className="flex flex-col sm:flex-row items-center gap-5 p-4 rounded-2xl bg-muted/35 border border-border/80">
                  {/* Orbital Progress Ring */}
                  <div className="relative h-28 w-28 flex items-center justify-center shrink-0">
                    <svg
                      className="h-28 w-28 -rotate-90"
                      viewBox="0 0 112 112"
                      aria-hidden="true"
                    >
                      <circle
                        cx="56"
                        cy="56"
                        r="52"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1"
                        strokeDasharray="3 5"
                        className={`text-indigo-500/35 ${
                          running ? 'celestia-orbital-ring' : ''
                        }`}
                      />
                      <circle
                        cx="56"
                        cy="56"
                        r={circleRadius}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="6"
                        className="text-muted/80"
                      />
                      <circle
                        cx="56"
                        cy="56"
                        r={circleRadius}
                        fill="none"
                        stroke="url(#celestiaUpdateGrad)"
                        strokeWidth="6"
                        strokeLinecap="round"
                        strokeDasharray={circleCircumference}
                        strokeDashoffset={strokeDashoffset}
                        className="transition-all duration-300 ease-out"
                      />
                      <defs>
                        <linearGradient
                          id="celestiaUpdateGrad"
                          x1="0%"
                          y1="0%"
                          x2="100%"
                          y2="100%"
                        >
                          <stop offset="0%" stopColor="#6366f1" />
                          <stop offset="100%" stopColor="#10b981" />
                        </linearGradient>
                      </defs>
                    </svg>

                    <div className="absolute inset-0 flex flex-col items-center justify-center">
                      {readyToRestart ? (
                        <div className="h-10 w-10 rounded-full bg-emerald-500/15 text-emerald-400 flex items-center justify-center">
                          <Check className="h-5 w-5 stroke-[2.5]" />
                        </div>
                      ) : updateFailed ? (
                        <AlertCircle className="h-6 w-6 text-rose-400" />
                      ) : (
                        <>
                          <span className="text-xl font-bold tabular-nums tracking-tight">
                            {progressPct}%
                          </span>
                          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                            {status === 'backing_up'
                              ? 'Backup'
                              : status === 'downloading'
                              ? 'Download'
                              : status === 'installing'
                              ? 'Install'
                              : 'Sync'}
                          </span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Live Stage Readout & Shimmer Bar */}
                  <div className="flex-1 min-w-0 w-full space-y-2.5 text-center sm:text-left">
                    <div className="flex items-center justify-center sm:justify-between gap-2 flex-wrap">
                      <span className="text-sm font-bold">
                        {readyToRestart
                          ? `CelestiaVid v${
                              liveUpdateStatus?.target_version ??
                              updateCheck?.latest_version ??
                              ''
                            } Ready`
                          : updateFailed
                          ? 'Update Paused'
                          : `Updating to v${
                              liveUpdateStatus?.target_version ??
                              updateCheck?.latest_version ??
                              '...'
                            }`}
                      </span>
                      {liveUpdateStatus && liveUpdateStatus.downloaded_bytes > 0 && (
                        <span className="text-[11px] font-mono text-muted-foreground tabular-nums">
                          {formatBytes(liveUpdateStatus.downloaded_bytes)}
                          {liveUpdateStatus.total_bytes
                            ? ` / ${formatBytes(liveUpdateStatus.total_bytes)}`
                            : ''}
                        </span>
                      )}
                    </div>

                    {/* Sleek Shimmer Progress Bar */}
                    <div className="h-2 w-full rounded-full bg-muted overflow-hidden relative">
                      <div
                        className={`h-full rounded-full transition-all duration-300 ease-out relative overflow-hidden ${
                          updateFailed
                            ? 'bg-rose-500'
                            : 'bg-gradient-to-r from-indigo-500 via-indigo-400 to-emerald-400'
                        } ${running ? 'celestia-shimmer-sweep' : ''}`}
                        style={{ width: `${Math.max(4, progressPct)}%` }}
                      />
                    </div>

                    <p className="text-xs text-muted-foreground leading-relaxed">
                      {liveUpdateStatus?.error_message_safe ??
                        liveUpdateStatus?.message ??
                        'Preparing update pipeline...'}
                    </p>
                  </div>
                </div>

                {/* 4-Stage Stepper Checklist */}
                <div className="space-y-2">
                  {/* Step 1: Backup */}
                  <div
                    className={`flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-2xl border text-xs transition-all ${
                      backupDone
                        ? 'bg-emerald-500/8 border-emerald-500/25 text-foreground'
                        : backupActive
                        ? 'bg-indigo-500/10 border-indigo-500/35 text-foreground'
                        : 'bg-muted/25 border-border/60 text-muted-foreground'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      {backupDone ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                      ) : backupActive ? (
                        <Loader2 className="h-4 w-4 text-indigo-400 animate-spin shrink-0" />
                      ) : (
                        <ShieldCheck className="h-4 w-4 shrink-0" />
                      )}
                      <div className="truncate">
                        <span className="font-semibold">
                          1. Automatic App Data Backup
                        </span>
                        {liveUpdateStatus?.backup_info && (
                          <span className="ml-2 text-[11px] text-muted-foreground">
                            ({formatBytes(liveUpdateStatus.backup_info.size_bytes)} saved)
                          </span>
                        )}
                      </div>
                    </div>
                    <span className="text-[11px] font-medium shrink-0 text-emerald-400">
                      {backupDone ? 'Protected' : backupActive ? 'Snapshotting...' : 'Queued'}
                    </span>
                  </div>

                  {/* Step 2: Streamed Download */}
                  <div
                    className={`flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-2xl border text-xs transition-all ${
                      downloadDone
                        ? 'bg-emerald-500/8 border-emerald-500/25 text-foreground'
                        : downloadActive
                        ? 'bg-indigo-500/10 border-indigo-500/35 text-foreground'
                        : 'bg-muted/25 border-border/60 text-muted-foreground'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      {downloadDone ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                      ) : downloadActive ? (
                        <Loader2 className="h-4 w-4 text-indigo-400 animate-spin shrink-0" />
                      ) : (
                        <Download className="h-4 w-4 shrink-0" />
                      )}
                      <span className="font-semibold truncate">
                        2. Download Release Package
                      </span>
                    </div>
                    <span className="text-[11px] font-mono shrink-0 text-muted-foreground">
                      {downloadDone
                        ? 'Verified'
                        : downloadActive
                        ? `${progressPct}%`
                        : 'Pending'}
                    </span>
                  </div>

                  {/* Step 3: Install */}
                  <div
                    className={`flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-2xl border text-xs transition-all ${
                      installDone
                        ? 'bg-emerald-500/8 border-emerald-500/25 text-foreground'
                        : installActive
                        ? 'bg-indigo-500/10 border-indigo-500/35 text-foreground'
                        : 'bg-muted/25 border-border/60 text-muted-foreground'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      {installDone ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                      ) : installActive ? (
                        <Loader2 className="h-4 w-4 text-indigo-400 animate-spin shrink-0" />
                      ) : (
                        <Cpu className="h-4 w-4 shrink-0" />
                      )}
                      <span className="font-semibold truncate">
                        3. Verify &amp; Stage Update
                      </span>
                    </div>
                    <span className="text-[11px] font-medium shrink-0 text-muted-foreground">
                      {installDone
                        ? 'Complete'
                        : installActive
                        ? 'Applying...'
                        : 'Pending'}
                    </span>
                  </div>

                  {/* Step 4: Relaunch */}
                  <div
                    className={`flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-2xl border text-xs transition-all ${
                      readyToRestart
                        ? 'bg-emerald-500/12 border-emerald-500/40 text-foreground'
                        : 'bg-muted/25 border-border/60 text-muted-foreground'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <Rocket
                        className={`h-4 w-4 shrink-0 ${
                          readyToRestart ? 'text-emerald-400' : ''
                        }`}
                      />
                      <span className="font-semibold truncate">
                        4. Relaunch CelestiaVid Studio
                      </span>
                    </div>
                    <span className="text-[11px] font-semibold shrink-0 text-emerald-400">
                      {readyToRestart ? 'Ready Now' : 'Waiting'}
                    </span>
                  </div>
                </div>

                {/* Action Footer for Active/Completed Pipeline */}
                <div className="flex items-center justify-end gap-2.5 pt-1">
                  {updateFailed && (
                    <button
                      type="button"
                      onClick={handleStartAutoUpdate}
                      className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition-colors"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      <span>Retry Update</span>
                    </button>
                  )}

                  {readyToRestart && liveUpdateStatus?.can_auto_restart && (
                    <button
                      type="button"
                      disabled={restartingApp}
                      onClick={handleApplyAndRestart}
                      className="relative overflow-hidden celestia-shimmer-sweep inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white text-xs font-bold shadow-md transition-all"
                    >
                      {restartingApp ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Rocket className="h-4 w-4" />
                      )}
                      <span>
                        Restart &amp; Launch v
                        {liveUpdateStatus.target_version ??
                          updateCheck?.latest_version}
                      </span>
                    </button>
                  )}

                  {readyToRestart && !liveUpdateStatus?.can_auto_restart && (
                    <a
                      href={updateCheck?.html_url ?? '#'}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition-colors"
                    >
                      <span>Open Release Page</span>
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  )}
                </div>
              </div>
            ) : updateCheck?.update_available ? (
              /* ============== New Version Available View ============== */
              <div className="space-y-4">
                <div className="p-4 rounded-2xl bg-gradient-to-br from-indigo-500/12 via-card to-emerald-500/10 border border-indigo-500/30 flex items-center justify-between gap-4 flex-wrap">
                  <div className="space-y-1">
                    <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 text-[11px] font-semibold">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-ping" />
                      <span>New Version Available</span>
                    </div>
                    <h3 className="text-lg font-bold tracking-tight">
                      {updateCheck.release_name}
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      v{updateCheck.current_version} →{' '}
                      <span className="text-foreground font-semibold">
                        v{updateCheck.latest_version}
                      </span>
                      {' · '}
                      {formatStrategyLabel(updateCheck.install_strategy)}
                      {updateCheck.asset_size_bytes
                        ? ` · ${formatBytes(updateCheck.asset_size_bytes)}`
                        : ''}
                    </p>
                  </div>

                  <a
                    href={updateCheck.html_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-muted/80 hover:bg-muted text-xs font-medium text-muted-foreground hover:text-foreground border border-border transition-colors"
                  >
                    <span>Release Notes</span>
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>

                {/* Automatic App Data Backup Guarantee */}
                <div className="flex items-start gap-3 p-3.5 rounded-2xl bg-emerald-500/8 border border-emerald-500/25">
                  <ShieldCheck className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
                  <div className="text-xs leading-relaxed">
                    <span className="font-semibold text-foreground">
                      Automatic App Data Backup Included:{' '}
                    </span>
                    <span className="text-muted-foreground">
                      Before updating, CelestiaVid snapshots your SQLite database,
                      projects, batch rows, subtitles, and managed brand logos so zero
                      work is ever lost.
                    </span>
                  </div>
                </div>

                {/* Release Notes Preview */}
                <div className="rounded-2xl bg-muted/35 border border-border/75 p-3.5 max-h-40 overflow-y-auto">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                    What&apos;s New in v{updateCheck.latest_version}
                  </div>
                  <p className="text-xs text-foreground/90 whitespace-pre-line leading-relaxed">
                    {updateCheck.release_notes}
                  </p>
                </div>

                {/* CTA Buttons */}
                <div className="flex items-center justify-between gap-3 pt-1">
                  <button
                    type="button"
                    disabled={isCheckingUpdate}
                    onClick={() => void onRefreshUpdateCheck()}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  >
                    <RefreshCw
                      className={`h-3.5 w-3.5 ${
                        isCheckingUpdate ? 'animate-spin' : ''
                      }`}
                    />
                    <span>Recheck</span>
                  </button>

                  {updateCheck.asset_download_url ? (
                    <button
                      type="button"
                      disabled={startingUpdate}
                      onClick={handleStartAutoUpdate}
                      className="relative overflow-hidden celestia-shimmer-sweep inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-55 text-white text-xs font-bold shadow-md transition-all"
                    >
                      {startingUpdate ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <HardDriveDownload className="h-4 w-4" />
                      )}
                      <span>
                        Backup Data &amp; Update to v{updateCheck.latest_version}
                      </span>
                    </button>
                  ) : (
                    <a
                      href={updateCheck.html_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold shadow-md transition-all"
                    >
                      <span>Download v{updateCheck.latest_version}</span>
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  )}
                </div>
              </div>
            ) : (
              /* ============== Up-to-Date Minimal Status View ============== */
              <div className="space-y-4">
                <div className="p-6 rounded-2xl bg-muted/30 border border-border/80 flex flex-col items-center text-center space-y-3">
                  <div className="relative h-14 w-14 flex items-center justify-center">
                    {isCheckingUpdate && (
                      <span className="absolute inset-0 rounded-full border border-indigo-500/50 celestia-radar-ring" />
                    )}
                    <div
                      className={`h-14 w-14 rounded-2xl flex items-center justify-center border ${
                        isCheckingUpdate
                          ? 'bg-indigo-500/15 border-indigo-500/35 text-indigo-400'
                          : 'bg-emerald-500/12 border-emerald-500/30 text-emerald-400'
                      }`}
                    >
                      {isCheckingUpdate ? (
                        <RefreshCw className="h-6 w-6 animate-spin" />
                      ) : (
                        <CheckCircle2 className="h-6 w-6" />
                      )}
                    </div>
                  </div>

                  <div className="space-y-1">
                    <h3 className="text-sm font-bold">
                      {isCheckingUpdate
                        ? 'Checking GitHub Releases...'
                        : `CelestiaVid v${currentVersion} is up to date`}
                    </h3>
                    <p className="text-xs text-muted-foreground max-w-sm">
                      {updateCheck?.checked_at
                        ? `Last checked ${formatShortDate(updateCheck.checked_at)} · Automatic update notifications are active.`
                        : 'CelestiaVid automatically notifies you in the top bar whenever a new version launches.'}
                    </p>
                  </div>

                  <div className="flex items-center gap-2.5 pt-1 flex-wrap justify-center">
                    <button
                      type="button"
                      disabled={isCheckingUpdate}
                      onClick={() => void onRefreshUpdateCheck()}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-card hover:bg-muted border border-border text-xs font-semibold transition-colors"
                    >
                      <RefreshCw
                        className={`h-3.5 w-3.5 ${
                          isCheckingUpdate ? 'animate-spin' : ''
                        }`}
                      />
                      <span>Check for Updates</span>
                    </button>

                    <button
                      type="button"
                      disabled={creatingBackup}
                      onClick={handleCreateManualBackup}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-semibold shadow-sm transition-colors"
                    >
                      {creatingBackup ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <ShieldCheck className="h-3.5 w-3.5" />
                      )}
                      <span>Back Up App Data Now</span>
                    </button>
                  </div>
                </div>
              </div>
            )
          ) : (
            /* ============== App Data Backups Tab ============== */
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-foreground">
                    Local Snapshots ({backups.length})
                  </div>
                  <div className="text-[11px] text-muted-foreground truncate max-w-xs sm:max-w-sm">
                    {systemVersionQuery.data?.backups_dir ??
                      'Includes SQLite database, projects, batches & brand assets'}
                  </div>
                </div>

                <button
                  type="button"
                  disabled={creatingBackup}
                  onClick={handleCreateManualBackup}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-semibold shadow-sm transition-colors shrink-0"
                >
                  {creatingBackup ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Database className="h-3.5 w-3.5" />
                  )}
                  <span>Create Backup</span>
                </button>
              </div>

              {backupsQuery.isLoading ? (
                <div className="py-10 flex items-center justify-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Loading saved app data snapshots...</span>
                </div>
              ) : backups.length === 0 ? (
                <div className="py-9 px-4 rounded-2xl bg-muted/30 border border-border/70 text-center space-y-2">
                  <History className="h-6 w-6 text-muted-foreground mx-auto" />
                  <div className="text-xs font-semibold">No backups created yet</div>
                  <p className="text-[11px] text-muted-foreground max-w-xs mx-auto">
                    Backups are created automatically before every app update, or you
                    can snapshot your workspace manually anytime.
                  </p>
                </div>
              ) : (
                <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                  {backups.map((b) => {
                    const isConfirming = confirmRestoreId === b.id;
                    const isRestoring = restoringId === b.id;
                    const isDeleting = deletingId === b.id;
                    const badgeStyle =
                      b.reason === 'pre-update'
                        ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                        : b.reason === 'pre-restore'
                        ? 'bg-amber-500/15 text-amber-400 border-amber-500/30'
                        : 'bg-indigo-500/15 text-indigo-400 border-indigo-500/30';
                    const badgeLabel =
                      b.reason === 'pre-update'
                        ? 'Auto Pre-Update'
                        : b.reason === 'pre-restore'
                        ? 'Safety Snapshot'
                        : b.reason === 'cli'
                        ? 'CLI Installer'
                        : 'Manual';

                    return (
                      <div
                        key={b.id}
                        className="p-3 rounded-2xl bg-muted/30 hover:bg-muted/45 border border-border/75 transition-colors flex items-center justify-between gap-3"
                      >
                        <div className="min-w-0 space-y-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs font-semibold truncate max-w-[230px]">
                              {b.label}
                            </span>
                            <span
                              className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${badgeStyle}`}
                            >
                              {badgeLabel}
                            </span>
                          </div>
                          <div className="text-[11px] text-muted-foreground flex items-center gap-2 flex-wrap">
                            <span>v{b.app_version}</span>
                            <span>·</span>
                            <span>{formatShortDate(b.created_at)}</span>
                            <span>·</span>
                            <span className="font-mono">{formatBytes(b.size_bytes)}</span>
                            {(b.project_count > 0 || b.batch_count > 0) && (
                              <>
                                <span>·</span>
                                <span>
                                  {b.project_count} proj, {b.batch_count} batch
                                </span>
                              </>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          {isConfirming ? (
                            <>
                              <button
                                type="button"
                                disabled={isRestoring}
                                onClick={() => void handleConfirmRestore(b.id)}
                                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-semibold transition-colors"
                              >
                                {isRestoring ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <Check className="h-3 w-3" />
                                )}
                                <span>Confirm</span>
                              </button>
                              <button
                                type="button"
                                disabled={isRestoring}
                                onClick={() => setConfirmRestoreId(null)}
                                className="px-2 py-1.5 rounded-xl bg-muted text-muted-foreground hover:text-foreground text-[11px] font-medium"
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                type="button"
                                disabled={isRestoring || isDeleting}
                                onClick={() => setConfirmRestoreId(b.id)}
                                title="Restore this app data snapshot"
                                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-card hover:bg-muted border border-border text-[11px] font-semibold transition-colors"
                              >
                                <RotateCcw className="h-3 w-3" />
                                <span>Restore</span>
                              </button>
                              <button
                                type="button"
                                disabled={isDeleting || isRestoring}
                                onClick={() => void handleDeleteBackup(b.id)}
                                title="Delete snapshot"
                                className="h-7 w-7 rounded-xl flex items-center justify-center text-muted-foreground hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
                              >
                                {isDeleting ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Trash2 className="h-3.5 w-3.5" />
                                )}
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
