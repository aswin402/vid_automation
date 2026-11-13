import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus,
  Sparkles,
  Film,
  Trash2,
  ArrowRight,
  Loader2,
  Subtitles,
  Image as ImageIcon,
  Download,
  Layers,
  Crop,
  X,
} from 'lucide-react';
import { videoApi } from '@/api/videoApi';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { HintTooltip } from '@/components/ui/tooltip';
import { formatFriendlyDuration } from '@/lib/timecode';
import type { BatchSummary } from '@/types/video';

type WorkspaceTab = 'batches' | 'projects';

export function HomePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [activeTab, setActiveTab] = useState<WorkspaceTab>('batches');
  const [creatingMode, setCreatingMode] = useState<'batch' | 'project' | null>(
    null
  );
  const [draftTitle, setDraftTitle] = useState('');

  const { data: projects = [], isLoading: isLoadingProjects } = useQuery({
    queryKey: ['projects'],
    queryFn: videoApi.listProjects,
    refetchInterval: 4000,
  });

  const { data: batches = [], isLoading: isLoadingBatches } = useQuery({
    queryKey: ['batches'],
    queryFn: videoApi.listBatches,
    refetchInterval: 3500,
  });

  const createProjectMutation = useMutation({
    mutationFn: (name: string) => videoApi.createProject(name),
    onSuccess: (proj) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      setCreatingMode(null);
      setDraftTitle('');
      navigate(`/projects/${proj.id}`);
    },
  });

  const demoProjectMutation = useMutation({
    mutationFn: () => videoApi.createDemoProject(),
    onSuccess: (proj) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      navigate(`/projects/${proj.id}`);
    },
  });

  const deleteProjectMutation = useMutation({
    mutationFn: (id: string) => videoApi.deleteProject(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  const createBatchMutation = useMutation({
    mutationFn: (name: string) => videoApi.createBatch(name),
    onSuccess: (batch) => {
      queryClient.invalidateQueries({ queryKey: ['batches'] });
      setCreatingMode(null);
      setDraftTitle('');
      navigate(`/batches/${batch.id}`);
    },
  });

  const demoBatchMutation = useMutation({
    mutationFn: () => videoApi.createDemoBatch(),
    onSuccess: (batch) => {
      queryClient.invalidateQueries({ queryKey: ['batches'] });
      navigate(`/batches/${batch.id}`);
    },
  });

  const deleteBatchMutation = useMutation({
    mutationFn: (id: string) => videoApi.deleteBatch(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['batches'] });
    },
  });

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (creatingMode === 'batch') {
      createBatchMutation.mutate(draftTitle.trim() || 'Untitled Campaign');
    } else if (creatingMode === 'project') {
      createProjectMutation.mutate(draftTitle.trim() || 'Untitled Clip');
    }
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">
      {/* Minimal Studio Workspace Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-border">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold tracking-tight">Workspace</h1>

          <div
            role="tablist"
            aria-label="Workspace mode"
            className="inline-flex items-center gap-1 p-1 rounded-xl bg-card border border-border"
          >
            <HintTooltip
              label="Batch Queues"
              detail="Multi-video queue with single shared logo & outro"
              side="bottom"
            >
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'batches'}
                onClick={() => setActiveTab('batches')}
                className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium transition-all ${
                  activeTab === 'batches'
                    ? 'bg-primary text-primary-foreground shadow-xs'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <Layers className="h-3.5 w-3.5" />
                <span>Batches</span>
                <span className="font-mono text-[11px] opacity-80">
                  {batches.length}
                </span>
              </button>
            </HintTooltip>

            <HintTooltip
              label="Single Clips"
              detail="Standalone step-by-step single video projects"
              side="bottom"
            >
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'projects'}
                onClick={() => setActiveTab('projects')}
                className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium transition-all ${
                  activeTab === 'projects'
                    ? 'bg-primary text-primary-foreground shadow-xs'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <Film className="h-3.5 w-3.5" />
                <span>Single Clips</span>
                <span className="font-mono text-[11px] opacity-80">
                  {projects.length}
                </span>
              </button>
            </HintTooltip>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <HintTooltip
            label={
              activeTab === 'batches'
                ? 'Load Sample 3-Video Batch'
                : 'Load Sample Single Clip'
            }
            detail="Generates synthetic test media to explore all tools"
            side="bottom"
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={
                demoBatchMutation.isPending || demoProjectMutation.isPending
              }
              onClick={() =>
                activeTab === 'batches'
                  ? demoBatchMutation.mutate()
                  : demoProjectMutation.mutate()
              }
              className="text-muted-foreground hover:text-foreground"
            >
              {demoBatchMutation.isPending || demoProjectMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5 text-primary" />
              )}
              <span>Sample</span>
            </Button>
          </HintTooltip>

          <HintTooltip
            label="New Single Clip"
            detail="Open standalone 9-step project editor"
            side="bottom"
          >
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setActiveTab('projects');
                setDraftTitle('');
                setCreatingMode('project');
              }}
            >
              <Film className="h-3.5 w-3.5" />
              <span>Single Clip</span>
            </Button>
          </HintTooltip>

          <HintTooltip
            label="New Batch Campaign"
            detail="Import multiple videos with shared brand logo & outro"
            side="bottom"
          >
            <Button
              type="button"
              size="sm"
              onClick={() => {
                setActiveTab('batches');
                setDraftTitle('');
                setCreatingMode('batch');
              }}
            >
              <Plus className="h-3.5 w-3.5" />
              <span>New Batch</span>
            </Button>
          </HintTooltip>
        </div>
      </div>

      {/* Compact Inline Creation Bar */}
      {creatingMode && (
        <form
          onSubmit={handleCreateSubmit}
          className="rounded-xl bg-card border border-border p-3 flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 shadow-sm"
        >
          <input
            type="text"
            autoFocus
            placeholder={
              creatingMode === 'batch'
                ? 'Campaign name (e.g. Q4 Reels Batch)...'
                : 'Clip name (e.g. Product Demo #14)...'
            }
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            className="flex-1 rounded-lg bg-background border border-border px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring/50"
          />
          <div className="flex items-center gap-2 shrink-0">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setCreatingMode(null)}
            >
              <X className="h-3.5 w-3.5" />
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={
                createBatchMutation.isPending || createProjectMutation.isPending
              }
            >
              {createBatchMutation.isPending ||
              createProjectMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ArrowRight className="h-3.5 w-3.5" />
              )}
              Create
            </Button>
          </div>
        </form>
      )}

      {/* Active Tab Content */}
      {activeTab === 'batches' ? (
        isLoadingBatches ? (
          <div className="rounded-xl border border-border bg-card/50 p-10 flex items-center justify-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            <span>Loading batches...</span>
          </div>
        ) : batches.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border bg-card/40 py-14 px-6 text-center space-y-3">
            <div className="h-10 w-10 rounded-xl bg-secondary flex items-center justify-center text-primary mx-auto">
              <Layers className="h-5 w-5" />
            </div>
            <div className="text-sm font-medium">No batch queues yet</div>
            <div className="flex items-center justify-center gap-2 pt-1">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={demoBatchMutation.isPending}
                onClick={() => demoBatchMutation.mutate()}
              >
                <Sparkles className="h-3.5 w-3.5 text-primary" />
                Sample Batch
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  setDraftTitle('');
                  setCreatingMode('batch');
                }}
              >
                <Plus className="h-3.5 w-3.5" />
                New Batch
              </Button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {batches.map((b: BatchSummary) => {
              const isRunning = b.processing_count > 0;
              const isDone =
                b.item_count > 0 && b.completed_count === b.item_count;

              return (
                <div
                  key={b.id}
                  onClick={() => navigate(`/batches/${b.id}`)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      navigate(`/batches/${b.id}`);
                    }
                  }}
                  className="group rounded-xl bg-card border border-border hover:border-primary/45 transition-all p-4 flex flex-col justify-between gap-3.5 shadow-2xs"
                >
                  <div className="space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h2
                          className="font-semibold text-sm truncate group-hover:text-primary transition-colors"
                          title={b.name}
                        >
                          {b.name}
                        </h2>
                        <span className="text-[11px] text-muted-foreground font-mono">
                          {new Date(b.updated_at).toLocaleDateString()} ·{' '}
                          {new Date(b.updated_at).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                      </div>

                      {isRunning ? (
                        <Badge variant="default" className="animate-pulse">
                          <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                          {b.processing_count} active
                        </Badge>
                      ) : b.completed_count > 0 ? (
                        <Badge variant="secondary">
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${
                              isDone ? 'bg-emerald-500' : 'bg-primary'
                            }`}
                          />
                          {b.completed_count}/{b.item_count}
                        </Badge>
                      ) : (
                        <Badge variant="outline">{b.item_count} clips</Badge>
                      )}
                    </div>

                    <div className="grid grid-cols-3 gap-1.5 rounded-lg bg-muted/50 border border-border/70 p-2 text-center">
                      <div>
                        <span className="block text-[10px] text-muted-foreground">
                          Videos
                        </span>
                        <span className="font-mono text-xs font-semibold text-foreground">
                          {b.video_count}
                        </span>
                      </div>
                      <div>
                        <span className="block text-[10px] text-muted-foreground">
                          Logo
                        </span>
                        <span className="font-mono text-xs font-semibold text-foreground">
                          {b.logo_count > 0 ? 'Yes' : '—'}
                        </span>
                      </div>
                      <div>
                        <span className="block text-[10px] text-muted-foreground">
                          Outro
                        </span>
                        <span className="font-mono text-xs font-semibold text-foreground">
                          {b.outro_count > 0 ? 'Yes' : '—'}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div
                    className="flex items-center justify-between gap-2 pt-2 border-t border-border/60"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <HintTooltip label="Delete batch" side="top">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => deleteBatchMutation.mutate(b.id)}
                        aria-label={`Delete batch ${b.name}`}
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </HintTooltip>

                    <HintTooltip
                      label="Open Batch Studio"
                      detail="Edit rows, preview live & queue exports"
                      side="top"
                    >
                      <Button
                        type="button"
                        variant="secondary"
                        size="xs"
                        onClick={() => navigate(`/batches/${b.id}`)}
                        className="group-hover:bg-primary group-hover:text-primary-foreground"
                      >
                        <span>Open</span>
                        <ArrowRight className="h-3 w-3" />
                      </Button>
                    </HintTooltip>
                  </div>
                </div>
              );
            })}
          </div>
        )
      ) : isLoadingProjects ? (
        <div className="rounded-xl border border-border bg-card/50 p-10 flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          <span>Loading clips...</span>
        </div>
      ) : projects.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-card/40 py-14 px-6 text-center space-y-3">
          <div className="h-10 w-10 rounded-xl bg-secondary flex items-center justify-center text-primary mx-auto">
            <Film className="h-5 w-5" />
          </div>
          <div className="text-sm font-medium">No single clips yet</div>
          <div className="flex items-center justify-center gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={demoProjectMutation.isPending}
              onClick={() => demoProjectMutation.mutate()}
            >
              <Sparkles className="h-3.5 w-3.5 text-primary" />
              Sample Clip
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                setDraftTitle('');
                setCreatingMode('project');
              }}
            >
              <Plus className="h-3.5 w-3.5" />
              New Clip
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {projects.map((proj) => {
            const srcAsset = proj.assets.find(
              (a) => a.kind === 'source' && a.status === 'ready'
            );
            const outAsset = proj.assets.find(
              (a) => a.kind === 'output' && a.status === 'ready'
            );
            const trimStart = proj.settings_json?.trim?.start_ms || 0;
            const trimEnd =
              proj.settings_json?.trim?.end_ms ?? (srcAsset?.duration_ms || 0);
            const clipMs = Math.max(0, trimEnd - trimStart);

            const statusDotClass =
              proj.status === 'completed'
                ? 'bg-emerald-500'
                : proj.status === 'processing'
                ? 'bg-primary animate-pulse'
                : proj.status === 'failed'
                ? 'bg-destructive'
                : 'bg-muted-foreground/50';

            return (
              <div
                key={proj.id}
                onClick={() => navigate(`/projects/${proj.id}`)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    navigate(`/projects/${proj.id}`);
                  }
                }}
                className="group rounded-xl bg-card border border-border hover:border-primary/45 transition-all p-4 flex flex-col justify-between gap-3.5 shadow-2xs"
              >
                <div className="space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h2
                        className="font-semibold text-sm truncate group-hover:text-primary transition-colors"
                        title={proj.name}
                      >
                        {proj.name}
                      </h2>
                      <span className="text-[11px] text-muted-foreground font-mono">
                        {srcAsset
                          ? `${formatFriendlyDuration(clipMs)} · ${srcAsset.width}×${srcAsset.height}`
                          : 'No source video'}
                      </span>
                    </div>

                    <Badge variant="secondary" className="capitalize">
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${statusDotClass}`}
                      />
                      {proj.status}
                    </Badge>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5 min-h-6">
                    {proj.settings_json?.crop?.enabled && (
                      <Badge variant="outline">
                        <Crop className="h-3 w-3" />
                        {proj.settings_json.crop.aspect_ratio}
                      </Badge>
                    )}
                    {proj.settings_json?.logo?.enabled && (
                      <Badge variant="outline">
                        <ImageIcon className="h-3 w-3" />
                        Logo
                      </Badge>
                    )}
                    {proj.subtitle_cue_count > 0 && (
                      <Badge variant="outline">
                        <Subtitles className="h-3 w-3" />
                        {proj.subtitle_cue_count}
                      </Badge>
                    )}
                    {proj.settings_json?.outro?.enabled && (
                      <Badge variant="outline">
                        <Film className="h-3 w-3" />
                        Outro
                      </Badge>
                    )}
                  </div>
                </div>

                <div
                  className="flex items-center justify-between gap-2 pt-2 border-t border-border/60"
                  onClick={(e) => e.stopPropagation()}
                >
                  <HintTooltip label="Delete project" side="top">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => deleteProjectMutation.mutate(proj.id)}
                      aria-label={`Delete project ${proj.name}`}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </HintTooltip>

                  <div className="flex items-center gap-1.5">
                    {outAsset && (
                      <HintTooltip label="Download exported MP4" side="top">
                        <Button
                          type="button"
                          variant="outline"
                          size="xs"
                          onClick={async () => {
                            await videoApi.downloadOutputAsset(
                              outAsset.id,
                              outAsset.original_filename
                            );
                          }}
                        >
                          <Download className="h-3 w-3" />
                          MP4
                        </Button>
                      </HintTooltip>
                    )}

                    <HintTooltip label="Open Clip Studio" side="top">
                      <Button
                        type="button"
                        variant="secondary"
                        size="xs"
                        onClick={() => navigate(`/projects/${proj.id}`)}
                        className="group-hover:bg-primary group-hover:text-primary-foreground"
                      >
                        <span>Open</span>
                        <ArrowRight className="h-3 w-3" />
                      </Button>
                    </HintTooltip>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
