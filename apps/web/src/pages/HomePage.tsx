import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus,
  Sparkles,
  Film,
  Trash2,
  ArrowRight,
  Clock,
  Loader2,
  Subtitles,
  Image as ImageIcon,
  Download,
} from 'lucide-react';
import { videoApi } from '@/api/videoApi';
import { formatFriendlyDuration } from '@/lib/timecode';
import type { ProjectDetail } from '@/types/video';

const STATUS_BADGE: Record<
  ProjectDetail['status'],
  { label: string; className: string }
> = {
  draft: {
    label: 'Draft',
    className: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
  },
  processing: {
    label: 'Processing',
    className: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/40 animate-pulse',
  },
  completed: {
    label: 'Completed',
    className: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  },
  failed: {
    label: 'Failed',
    className: 'bg-rose-500/15 text-rose-400 border-rose-500/30',
  },
};

export function HomePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [newProjectName, setNewProjectName] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);

  const { data: projects = [], isLoading } = useQuery({
    queryKey: ['projects'],
    queryFn: videoApi.listProjects,
    refetchInterval: 4000,
  });

  const createMutation = useMutation({
    mutationFn: (name: string) => videoApi.createProject(name),
    onSuccess: (proj) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      navigate(`/projects/${proj.id}`);
    },
  });

  const demoMutation = useMutation({
    mutationFn: () => videoApi.createDemoProject(),
    onSuccess: (proj) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      navigate(`/projects/${proj.id}`);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => videoApi.deleteProject(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    createMutation.mutate(newProjectName.trim() || 'Untitled Video Project');
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-8">
      {/* Hero Banner */}
      <div className="rounded-3xl bg-gradient-to-br from-indigo-950/60 via-card to-card border border-indigo-500/25 p-6 sm:p-8 flex flex-col lg:flex-row lg:items-center justify-between gap-6 shadow-lg">
        <div className="space-y-2 max-w-2xl">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-500/15 border border-indigo-500/30 text-indigo-300 text-xs font-semibold">
            <Sparkles className="h-3.5 w-3.5" />
            Automated Branded Video Pipeline
          </div>
          <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">
            Turn Raw Clips into Branded, Subtitled Videos in 8 Guided Steps
          </h1>
          <p className="text-sm text-muted-foreground">
            Import your source video locally, select a frame-accurate trim window, apply cinematic color grading and FFT audio noise reduction, overlay your transparent brand logo, generate and edit AI subtitles, append a normalized outro, and export an FFprobe-verified MP4.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3 shrink-0">
          <button
            type="button"
            disabled={demoMutation.isPending}
            onClick={() => demoMutation.mutate()}
            className="inline-flex items-center gap-2 px-4 py-3 rounded-xl bg-card hover:bg-muted border border-indigo-500/40 text-xs font-semibold text-indigo-300 transition-all cursor-pointer"
          >
            {demoMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Generating Sample Media...
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4 text-indigo-400" />
                Load Instant Sample Project
              </>
            )}
          </button>

          <button
            type="button"
            onClick={() => setShowCreateModal(true)}
            className="inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold shadow-md transition-all cursor-pointer"
          >
            <Plus className="h-4 w-4" />
            Create Video
          </button>
        </div>
      </div>

      {/* Create Project Inline Form */}
      {showCreateModal && (
        <form
          onSubmit={handleCreateSubmit}
          className="rounded-2xl bg-card border border-indigo-500/40 p-5 flex flex-col sm:flex-row items-stretch sm:items-end gap-4 shadow-md"
        >
          <div className="flex-1 space-y-1.5">
            <label
              htmlFor="new-project-name"
              className="block text-xs font-semibold text-foreground"
            >
              Project Title
            </label>
            <input
              id="new-project-name"
              type="text"
              autoFocus
              placeholder="e.g., Weekly Product Walkthrough #14"
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              className="w-full rounded-xl bg-background border border-border px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => setShowCreateModal(false)}
              className="px-4 py-2.5 rounded-xl border border-border text-xs font-medium"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={createMutation.isPending}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold"
            >
              {createMutation.isPending ? 'Creating...' : 'Start Guided Workflow'}
              <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </form>
      )}

      {/* Projects Section */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">Recent Video Projects</h2>
          <span className="text-xs text-muted-foreground font-mono">
            {projects.length} {projects.length === 1 ? 'project' : 'projects'}
          </span>
        </div>

        {isLoading ? (
          <div className="rounded-2xl border border-border p-12 flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin text-indigo-400" />
            Loading your studio projects...
          </div>
        ) : projects.length === 0 ? (
          <div className="rounded-3xl border border-dashed border-border bg-card/40 p-12 text-center space-y-4">
            <div className="h-12 w-12 rounded-2xl bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center text-indigo-400 mx-auto">
              <Film className="h-6 w-6" />
            </div>
            <div className="space-y-1 max-w-md mx-auto">
              <h3 className="text-base font-bold">No video projects yet</h3>
              <p className="text-xs text-muted-foreground">
                Create a new video project to upload your own clip, or launch our instant sample project with pre-synthesized HD video, logo, and outro assets.
              </p>
            </div>
            <div className="flex items-center justify-center gap-3 pt-2">
              <button
                type="button"
                onClick={() => demoMutation.mutate()}
                disabled={demoMutation.isPending}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-indigo-500/40 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-300 text-xs font-semibold"
              >
                <Sparkles className="h-4 w-4" />
                Try Sample Project
              </button>
              <button
                type="button"
                onClick={() => setShowCreateModal(true)}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold"
              >
                <Plus className="h-4 w-4" />
                Create Video
              </button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {projects.map((proj) => {
              const badge = STATUS_BADGE[proj.status] || STATUS_BADGE.draft;
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

              return (
                <div
                  key={proj.id}
                  className="rounded-2xl bg-card/80 border border-border hover:border-indigo-500/50 transition-all p-5 flex flex-col justify-between gap-4 shadow-sm"
                >
                  <div className="space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h3
                          className="font-bold text-sm truncate"
                          title={proj.name}
                        >
                          {proj.name}
                        </h3>
                        <span className="text-[11px] text-muted-foreground flex items-center gap-1 mt-0.5">
                          <Clock className="h-3 w-3" />
                          Updated {new Date(proj.updated_at).toLocaleString()}
                        </span>
                      </div>

                      <span
                        className={`text-[11px] font-semibold px-2.5 py-0.5 rounded-full border shrink-0 ${badge.className}`}
                      >
                        {badge.label}
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-2 rounded-xl bg-muted/40 border border-border/60 p-3 text-xs">
                      <div>
                        <span className="text-[10px] text-muted-foreground block">
                          Source Clip
                        </span>
                        <span className="font-mono font-medium">
                          {srcAsset
                            ? `${formatFriendlyDuration(clipMs)} (${srcAsset.width}×${srcAsset.height})`
                            : 'Not uploaded'}
                        </span>
                      </div>
                      <div>
                        <span className="text-[10px] text-muted-foreground block">
                          Active Features
                        </span>
                        <div className="flex items-center gap-2 mt-0.5 text-muted-foreground">
                          {proj.settings_json?.logo?.enabled && (
                            <span
                              title="Logo Overlay Enabled"
                              className="inline-flex items-center gap-0.5 text-[11px] text-indigo-400"
                            >
                              <ImageIcon className="h-3 w-3" />
                              Logo
                            </span>
                          )}
                          {proj.subtitle_cue_count > 0 && (
                            <span
                              title="Subtitles Ready"
                              className="inline-flex items-center gap-0.5 text-[11px] text-emerald-400"
                            >
                              <Subtitles className="h-3 w-3" />
                              {proj.subtitle_cue_count} cues
                            </span>
                          )}
                          {proj.settings_json?.outro?.enabled && (
                            <span
                              title="Outro Enabled"
                              className="inline-flex items-center gap-0.5 text-[11px] text-amber-400"
                            >
                              <Film className="h-3 w-3" />
                              Outro
                            </span>
                          )}
                          {!proj.settings_json?.logo?.enabled &&
                            proj.subtitle_cue_count === 0 &&
                            !proj.settings_json?.outro?.enabled && (
                              <span className="text-[11px]">Trim only</span>
                            )}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-2 pt-2 border-t border-border/60">
                    <button
                      type="button"
                      onClick={() => deleteMutation.mutate(proj.id)}
                      aria-label={`Delete project ${proj.name}`}
                      className="p-2 rounded-lg text-muted-foreground hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>

                    <div className="flex items-center gap-2">
                      {outAsset && (
                        <button
                          type="button"
                          onClick={async () => {
                            await videoApi.downloadOutputAsset(
                              outAsset.id,
                              outAsset.original_filename
                            );
                          }}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/40 text-emerald-300 text-xs font-semibold cursor-pointer"
                        >
                          <Download className="h-3.5 w-3.5" />
                          MP4
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => navigate(`/projects/${proj.id}`)}
                        className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition-colors cursor-pointer"
                      >
                        Open Studio
                        <ArrowRight className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
