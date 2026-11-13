import React, { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowUpCircle,
  Clapperboard,
  Crop,
  Film,
  Image as ImageIcon,
  LayoutGrid,
  Loader2,
  Plus,
  Rocket,
  Scissors,
  Settings2,
  ShieldCheck,
  Sliders,
  Subtitles,
  Volume2,
  X,
} from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { videoApi } from '@/api/videoApi';
import { Button } from '@/components/ui/button';
import { HintTooltip } from '@/components/ui/tooltip';
import {
  useWorkflowStore,
  type StudioNavbarTab,
} from '@/store/useWorkflowStore';
import { ThemeToggleButton } from './ThemeToggleButton';
import { UpdateModal, type UpdateModalTab } from './UpdateModal';

const STUDIO_NAVBAR_TABS: ReadonlyArray<{
  id: StudioNavbarTab;
  label: string;
  hint: string;
  detail: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  {
    id: 'trim',
    label: 'Trim',
    hint: 'Trim In / Out Points',
    detail: 'Cut start/end timestamps with frame-accurate playhead nudge',
    icon: Scissors,
  },
  {
    id: 'crop',
    label: 'Ratio & Face',
    hint: 'Aspect Ratio, Pan/Zoom & AI Face Framing',
    detail: '9:16, 1:1, 4:5, 16:9, manual X/Y pan, and speaker tracking',
    icon: Crop,
  },
  {
    id: 'subtitles',
    label: 'Subtitles',
    hint: 'AI Captions, Cue Editor & Typography',
    detail: 'Generate Whisper captions, edit cue timings/text, and style ASS burn-in',
    icon: Subtitles,
  },
  {
    id: 'color',
    label: 'Color',
    hint: 'Color Grading & LUT Presets',
    detail: 'Brightness, contrast, saturation, gamma, warmth, tint, sharpen & A/B compare',
    icon: Sliders,
  },
  {
    id: 'audio',
    label: 'Audio',
    hint: 'Denoise, EQ & Loudness',
    detail: 'FFT noise reduction, voice clarity, high/low-cut filters & -16 LUFS normalize',
    icon: Volume2,
  },
  {
    id: 'logo',
    label: 'Logo',
    hint: 'Brand Watermark Overlay',
    detail: '9-point anchor grid, free X/Y placement, scale, opacity & safe margin',
    icon: ImageIcon,
  },
  {
    id: 'outro',
    label: 'Outro',
    hint: 'End Card Concatenation',
    detail: 'Append single brand outro with pad, crop, or stretch normalization',
    icon: Film,
  },
  {
    id: 'export',
    label: 'Output',
    hint: 'Resolution, FPS & Encoder Quality',
    detail: 'Override output dimensions, frame rate, H.264 CRF quality & encode speed',
    icon: Settings2,
  },
];

const ACTIVE_UPDATE_STATUSES = [
  'checking',
  'backing_up',
  'downloading',
  'verifying',
  'installing',
];

export const Navbar: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [creatingBatch, setCreatingBatch] = useState(false);
  const [updateModalOpen, setUpdateModalOpen] = useState(false);
  const [updateModalTab, setUpdateModalTab] = useState<UpdateModalTab>('update');
  const [dismissedToastVersion, setDismissedToastVersion] = useState<string | null>(
    null
  );

  const activeStudioTab = useWorkflowStore((s) => s.activeStudioTab);
  const setActiveStudioTab = useWorkflowStore((s) => s.setActiveStudioTab);

  const updateCheckQuery = useQuery({
    queryKey: ['system-update-check'],
    queryFn: () => videoApi.checkForUpdates(),
    staleTime: 5 * 60_000,
    refetchInterval: 15 * 60_000,
    retry: 1,
  });

  const updateStatusQuery = useQuery({
    queryKey: ['system-update-status'],
    queryFn: () => videoApi.getUpdateStatus(),
    refetchInterval: (query) => {
      const st = query.state.data?.status;
      if (st && ACTIVE_UPDATE_STATUSES.includes(st)) {
        return 220;
      }
      return updateModalOpen ? 1500 : false;
    },
  });

  const updateCheck = updateCheckQuery.data ?? null;
  const liveStatus = updateStatusQuery.data ?? null;
  const isUpdatingNow = Boolean(
    liveStatus?.status && ACTIVE_UPDATE_STATUSES.includes(liveStatus.status)
  );
  const isReadyToRestart = liveStatus?.status === 'ready_to_restart';
  const hasNewVersion = Boolean(updateCheck?.update_available);
  const livePct = Math.round(
    Math.min(100, Math.max(0, (liveStatus?.progress ?? 0) * 100))
  );

  const showLaunchUpdateBanner =
    hasNewVersion &&
    !updateModalOpen &&
    !isUpdatingNow &&
    !isReadyToRestart &&
    updateCheck !== null &&
    dismissedToastVersion !== updateCheck.latest_version;

  const isInStudioWorkspace =
    location.pathname.startsWith('/batches/') ||
    location.pathname.startsWith('/projects/');

  const handleSelectStudioTab = async (tab: StudioNavbarTab) => {
    setActiveStudioTab(tab);
    if (isInStudioWorkspace) return;

    setCreatingBatch(true);
    try {
      const existing = await videoApi.listBatches();
      if (existing.length > 0) {
        navigate(`/batches/${existing[0].id}`);
      } else {
        const created = await videoApi.createBatch('Campaign');
        queryClient.invalidateQueries({ queryKey: ['batches'] });
        navigate(`/batches/${created.id}`);
      }
    } finally {
      setCreatingBatch(false);
    }
  };

  const handleQuickNewBatch = async () => {
    setCreatingBatch(true);
    try {
      const created = await videoApi.createBatch('Campaign');
      queryClient.invalidateQueries({ queryKey: ['batches'] });
      navigate(`/batches/${created.id}`);
    } finally {
      setCreatingBatch(false);
    }
  };

  const openUpdateStudio = (tab: UpdateModalTab = 'update') => {
    setUpdateModalTab(tab);
    setUpdateModalOpen(true);
  };

  const handleStartOneClickUpdateFromToast = async () => {
    setUpdateModalTab('update');
    setUpdateModalOpen(true);
    try {
      await videoApi.startAppUpdate();
      await queryClient.invalidateQueries({ queryKey: ['system-update-status'] });
    } catch {
      // Modal surfaces detailed status/retry cleanly
    }
  };

  return (
    <>
      <header className="fixed top-0 left-0 right-0 z-40 h-14 bg-background/90 backdrop-blur-xl border-b border-border">
        <div className="max-w-7xl mx-auto h-full px-3 sm:px-5 flex items-center justify-between gap-2">
          {/* Brand */}
          <HintTooltip
            label="Workspace Home"
            detail="View all batch queues and single clips"
            side="bottom"
          >
            <Link to="/" className="flex items-center gap-2 group shrink-0">
              <div className="h-7 w-7 rounded-lg bg-primary flex items-center justify-center text-primary-foreground shadow-xs group-hover:opacity-90 transition-opacity">
                <Clapperboard className="h-3.5 w-3.5" />
              </div>
              <span className="font-semibold text-sm tracking-tight hidden md:inline">
                CelestiaVid
              </span>
            </Link>
          </HintTooltip>

          {/* Center Studio Editing Tool Tabs */}
          <nav
            aria-label="Studio editing tools"
            className="flex items-center gap-0.5 overflow-x-auto no-scrollbar p-1 rounded-xl bg-card border border-border max-w-full"
          >
            {STUDIO_NAVBAR_TABS.map((tab) => {
              const Icon = tab.icon;
              const isActive = isInStudioWorkspace && activeStudioTab === tab.id;
              return (
                <HintTooltip
                  key={tab.id}
                  label={tab.hint}
                  detail={tab.detail}
                  side="bottom"
                >
                  <button
                    type="button"
                    onClick={() => void handleSelectStudioTab(tab.id)}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium whitespace-nowrap transition-all shrink-0 ${
                      isActive
                        ? 'bg-primary text-primary-foreground shadow-xs'
                        : 'text-muted-foreground hover:text-foreground hover:bg-muted/70'
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0" />
                    <span>{tab.label}</span>
                  </button>
                </HintTooltip>
              );
            })}
          </nav>

          {/* Right Actions */}
          <div className="flex items-center gap-1.5 shrink-0">
            {isReadyToRestart ? (
              <HintTooltip
                label="Update Ready to Apply"
                detail="Backup verified — click to restart into the new version"
                side="bottom"
              >
                <Button
                  type="button"
                  size="sm"
                  onClick={() => openUpdateStudio('update')}
                  className="relative overflow-hidden celestia-shimmer-sweep"
                >
                  <Rocket className="h-3.5 w-3.5" />
                  <span className="hidden md:inline">Restart</span>
                </Button>
              </HintTooltip>
            ) : isUpdatingNow ? (
              <HintTooltip
                label="Updating CelestiaVid"
                detail="Click to inspect live backup & download progress"
                side="bottom"
              >
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => openUpdateStudio('update')}
                  className="tabular-nums"
                >
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                  <span>{livePct}%</span>
                </Button>
              </HintTooltip>
            ) : hasNewVersion && updateCheck ? (
              <HintTooltip
                label={`Update v${updateCheck.latest_version} Available`}
                detail="Includes automatic app data snapshot before install"
                side="bottom"
              >
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => openUpdateStudio('update')}
                  className="relative overflow-hidden celestia-shimmer-sweep border-primary/40 text-primary"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  <ArrowUpCircle className="h-3.5 w-3.5" />
                  <span className="hidden lg:inline">
                    v{updateCheck.latest_version}
                  </span>
                </Button>
              </HintTooltip>
            ) : (
              <HintTooltip
                label="Updates & Data Backups"
                detail={`Version v${updateCheck?.current_version ?? '0.2.3'} · Manage snapshots`}
                side="bottom"
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => openUpdateStudio('update')}
                  className="text-muted-foreground hover:text-foreground font-mono text-[11px]"
                >
                  <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
                  <span className="hidden xl:inline">
                    v{updateCheck?.current_version ?? '0.2.3'}
                  </span>
                </Button>
              </HintTooltip>
            )}

            <HintTooltip
              label="Workspace"
              detail="Switch between campaigns and single projects"
              side="bottom"
            >
              <Button
                asChild
                variant={location.pathname === '/' ? 'secondary' : 'ghost'}
                size="icon-sm"
              >
                <Link to="/" aria-label="Workspace">
                  <LayoutGrid className="h-3.5 w-3.5" />
                </Link>
              </Button>
            </HintTooltip>

            <HintTooltip
              label="New Batch Queue"
              detail="Create a multi-video campaign with single logo & outro"
              side="bottom"
            >
              <Button
                type="button"
                size="sm"
                disabled={creatingBatch}
                onClick={() => void handleQuickNewBatch()}
              >
                {creatingBatch ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plus className="h-3.5 w-3.5" />
                )}
                <span className="hidden lg:inline">New Batch</span>
              </Button>
            </HintTooltip>

            <ThemeToggleButton />
          </div>
        </div>
      </header>

      {/* Compact Release Notification Toast */}
      {showLaunchUpdateBanner && updateCheck && (
        <div
          role="status"
          className="fixed top-16 right-4 z-40 max-w-xs w-[calc(100vw-2rem)] celestia-modal-card rounded-xl bg-popover/95 backdrop-blur-xl border border-border shadow-xl p-3.5"
        >
          <div className="flex items-start justify-between gap-2.5">
            <div className="flex items-start gap-2.5 min-w-0">
              <div className="h-7 w-7 rounded-lg bg-primary/15 text-primary flex items-center justify-center shrink-0 mt-0.5">
                <ArrowUpCircle className="h-4 w-4" />
              </div>
              <div className="min-w-0 space-y-1.5">
                <div className="text-xs font-semibold text-foreground">
                  v{updateCheck.latest_version} available
                </div>
                <p className="text-[11px] text-muted-foreground leading-snug">
                  Auto-backs up projects &amp; database before updating.
                </p>
                <div className="flex items-center gap-1.5 pt-0.5">
                  <Button
                    type="button"
                    size="xs"
                    onClick={() => void handleStartOneClickUpdateFromToast()}
                  >
                    Update
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="xs"
                    onClick={() => openUpdateStudio('update')}
                  >
                    Notes
                  </Button>
                </div>
              </div>
            </div>

            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => setDismissedToastVersion(updateCheck.latest_version)}
              aria-label="Dismiss update notification"
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
        </div>
      )}

      <UpdateModal
        open={updateModalOpen}
        onClose={() => setUpdateModalOpen(false)}
        activeTab={updateModalTab}
        onTabChange={setUpdateModalTab}
        updateCheck={updateCheck}
        isCheckingUpdate={updateCheckQuery.isFetching}
        onRefreshUpdateCheck={async () => {
          await updateCheckQuery.refetch();
        }}
        liveUpdateStatus={liveStatus}
      />
    </>
  );
};
