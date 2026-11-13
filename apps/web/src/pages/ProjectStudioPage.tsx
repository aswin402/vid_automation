import React, { useEffect } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Loader2,
  Save,
  CheckCircle2,
  Layers,
  Upload,
  Sparkles,
} from 'lucide-react';
import { videoApi } from '@/api/videoApi';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { HintTooltip } from '@/components/ui/tooltip';
import { useWorkflowStore } from '@/store/useWorkflowStore';
import { UploadStep } from '@/components/studio/steps/UploadStep';
import { TrimStep } from '@/components/studio/steps/TrimStep';
import { CropFrameStep } from '@/components/studio/steps/CropFrameStep';
import { ColorCorrectionStep } from '@/components/studio/steps/ColorCorrectionStep';
import { AudioEnhancementStep } from '@/components/studio/steps/AudioEnhancementStep';
import { LogoStep } from '@/components/studio/steps/LogoStep';
import { SubtitlesStep } from '@/components/studio/steps/SubtitlesStep';
import { OutroStep } from '@/components/studio/steps/OutroStep';
import { ReviewExportStep } from '@/components/studio/steps/ReviewExportStep';

export const ProjectStudioPage: React.FC = () => {
  const { projectId } = useParams<{ projectId: string }>();
  const [searchParams] = useSearchParams();
  const parentBatchId = searchParams.get('batchId');
  const queryClient = useQueryClient();

  const {
    activeStep,
    draftSettings,
    draftCues,
    cuesDirty,
    settingsDirty,
    settingsRevision,
    currentTimeMs,
    setActiveProjectId,
    setActiveStep,
    setDraftSettings,
    updateDraftSettings,
    setDraftCues,
    setCurrentTimeMs,
    markSettingsSaved,
    markCuesSaved,
  } = useWorkflowStore();

  useEffect(() => {
    setActiveProjectId(projectId || null);
  }, [projectId, setActiveProjectId]);

  const { data: capabilities } = useQuery({
    queryKey: ['capabilities'],
    queryFn: videoApi.getCapabilities,
    staleTime: 60_000,
  });

  const {
    data: project,
    isLoading,
    refetch: refetchProject,
  } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => videoApi.getProject(projectId!),
    enabled: Boolean(projectId),
    refetchInterval: (query) => {
      const p = query.state.data;
      if (!p) return false;
      const hasActiveJob = p.jobs?.some(
        (j) => !['completed', 'failed', 'canceled'].includes(j.status)
      );
      return hasActiveJob ? 1200 : false;
    },
  });

  const activeSubVersion = project?.active_subtitle_version || 0;

  const { data: subtitleData, refetch: refetchSubtitles } = useQuery({
    queryKey: ['subtitles', projectId, activeSubVersion],
    queryFn: () => videoApi.getSubtitleVersion(projectId!, activeSubVersion),
    enabled: Boolean(projectId),
  });

  // Initialize draftSettings once when project loads (or when server updates while no local draft exists)
  useEffect(() => {
    if (project?.settings_json && !draftSettings) {
      setDraftSettings(project.settings_json, false);
    }
  }, [project?.id, project?.settings_json, draftSettings, setDraftSettings]);

  // Initialize draftCues when subtitle version loads
  useEffect(() => {
    if (subtitleData?.cues && !cuesDirty) {
      setDraftCues(subtitleData.cues, false);
    }
  }, [subtitleData?.version, subtitleData?.cues, cuesDirty, setDraftCues]);

  // Refetch subtitles when a transcription job finishes
  const latestTranscribeJob = project?.jobs?.find((j) => j.kind === 'transcribe');
  useEffect(() => {
    if (latestTranscribeJob?.status === 'completed') {
      void refetchSubtitles();
    }
  }, [latestTranscribeJob?.status, latestTranscribeJob?.subtitle_version, refetchSubtitles]);

  // Auto-save draftSettings after 450ms of inactivity using revision guard so newer edits are never clobbered
  useEffect(() => {
    if (!settingsDirty || !projectId || !draftSettings) return;
    const revSnapshot = settingsRevision;
    const settingsSnapshot = draftSettings;
    const timer = window.setTimeout(async () => {
      try {
        const updated = await videoApi.updateProject(projectId, {
          settings: settingsSnapshot,
        });
        markSettingsSaved(revSnapshot);
        queryClient.setQueryData(['project', projectId], updated);
      } catch {
        // Manual save or pre-export flush will retry if network hiccups
      }
    }, 450);
    return () => window.clearTimeout(timer);
  }, [settingsDirty, settingsRevision, projectId, draftSettings, markSettingsSaved, queryClient]);

  if (isLoading || !project || !draftSettings) {
    return (
      <div className="max-w-7xl mx-auto px-6 py-16 flex items-center justify-center gap-3 text-sm text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin text-indigo-400" />
        Loading project workspace...
      </div>
    );
  }

  const sourceAsset = project.assets.find(
    (a) => a.kind === 'source' && a.status === 'ready'
  );
  const logoAsset = project.assets.find(
    (a) => a.kind === 'logo' && a.status === 'ready'
  );
  const outroAsset = project.assets.find(
    (a) => a.kind === 'outro' && a.status === 'ready'
  );
  const outputAsset = project.assets.find(
    (a) => a.kind === 'output' && a.status === 'ready'
  );
  const latestExportJob = project.jobs.find((j) => j.kind === 'export');

  const handleSaveSettings = async () => {
    if (!projectId || !draftSettings) return;
    const currentSnapshot = useWorkflowStore.getState().draftSettings || draftSettings;
    const currentRev = useWorkflowStore.getState().settingsRevision;
    const updated = await videoApi.updateProject(projectId, {
      settings: currentSnapshot,
    });
    markSettingsSaved(currentRev);
    queryClient.setQueryData(['project', projectId], updated);
  };

  const handleSaveCues = async () => {
    if (!projectId) return;
    const saved = await videoApi.saveSubtitleVersion(
      projectId,
      activeSubVersion,
      draftSettings.subtitles.language || 'en',
      draftCues
    );
    setDraftCues(saved.cues, false);
    markCuesSaved();
    await refetchProject();
  };

  const handleFlushBeforeExport = async (): Promise<number> => {
    let resolvedSubVer = activeSubVersion;
    if (cuesDirty && projectId) {
      const saved = await videoApi.saveSubtitleVersion(
        projectId,
        activeSubVersion,
        draftSettings.subtitles.language || 'en',
        draftCues
      );
      resolvedSubVer = saved.version;
      setDraftCues(saved.cues, false);
      markCuesSaved();
    }
    const latestSettings = useWorkflowStore.getState().draftSettings || draftSettings;
    const latestRev = useWorkflowStore.getState().settingsRevision;
    if (projectId && latestSettings) {
      const updated = await videoApi.updateProject(projectId, {
        settings: latestSettings,
      });
      markSettingsSaved(latestRev);
      queryClient.setQueryData(['project', projectId], updated);
    }
    return resolvedSubVer;
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-5 space-y-5">
      {/* Minimal Studio Top Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-border">
        <div className="flex items-center gap-2.5 min-w-0">
          <HintTooltip
            label={parentBatchId ? 'Back to Batch Studio' : 'Back to Workspace'}
            side="bottom"
          >
            <Button asChild variant="ghost" size="icon-sm">
              <Link
                to={parentBatchId ? `/batches/${parentBatchId}` : '/'}
                aria-label={parentBatchId ? 'Back to Batch Studio' : 'Back to Workspace'}
              >
                <ArrowLeft className="h-4 w-4" />
              </Link>
            </Button>
          </HintTooltip>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-base font-semibold leading-tight truncate">
                {project.name}
              </h1>
              {parentBatchId && (
                <Badge variant="secondary">
                  <Link
                    to={`/batches/${parentBatchId}`}
                    className="inline-flex items-center gap-1"
                  >
                    <Layers className="h-3 w-3" />
                    Batch
                  </Link>
                </Badge>
              )}
            </div>
            <span className="text-[11px] text-muted-foreground font-mono">
              {sourceAsset
                ? `${sourceAsset.original_filename} · ${sourceAsset.width}×${sourceAsset.height}`
                : 'Upload source video'}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <HintTooltip
            label="Media Assets"
            detail="Upload or replace source video, logo & outro"
            side="bottom"
          >
            <Button
              type="button"
              variant={activeStep === 'upload' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setActiveStep('upload')}
            >
              <Upload className="h-3.5 w-3.5" />
              Media
            </Button>
          </HintTooltip>

          <HintTooltip
            label="Output & Export"
            detail="Set encoding quality and render MP4"
            side="bottom"
          >
            <Button
              type="button"
              variant={activeStep === 'export' ? 'default' : 'secondary'}
              size="sm"
              disabled={!sourceAsset}
              onClick={() => setActiveStep('export')}
            >
              <Sparkles className="h-3.5 w-3.5" />
              Export
            </Button>
          </HintTooltip>

          {settingsDirty || cuesDirty ? (
            <HintTooltip label="Save pending edits now" side="bottom">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={async () => {
                  if (cuesDirty) await handleSaveCues();
                  if (settingsDirty) await handleSaveSettings();
                }}
              >
                <Save className="h-3.5 w-3.5 text-primary" />
                Save
              </Button>
            </HintTooltip>
          ) : (
            <Badge variant="outline" className="gap-1">
              <CheckCircle2 className="h-3 w-3 text-emerald-500" />
              Saved
            </Badge>
          )}
        </div>
      </div>

      {/* Step Content */}
      <div className="rounded-2xl bg-card border border-border p-4 sm:p-6 shadow-2xs">
        {activeStep === 'upload' && (
          <UploadStep
            projectId={project.id}
            assets={project.assets}
            onAssetsChanged={() => refetchProject()}
            onNext={() => setActiveStep('trim')}
          />
        )}

        {activeStep === 'trim' && (
          <TrimStep
            sourceAsset={sourceAsset}
            logoAsset={logoAsset}
            settings={draftSettings}
            cues={draftCues}
            currentTimeMs={currentTimeMs}
            onTimeUpdate={setCurrentTimeMs}
            onUpdateSettings={updateDraftSettings}
            onSaveSettings={handleSaveSettings}
            onBack={() => setActiveStep('upload')}
            onNext={() => setActiveStep('crop')}
          />
        )}

        {activeStep === 'crop' && (
          <CropFrameStep
            projectId={project.id}
            sourceAsset={sourceAsset}
            logoAsset={logoAsset}
            settings={draftSettings}
            cues={draftCues}
            currentTimeMs={currentTimeMs}
            onTimeUpdate={setCurrentTimeMs}
            onUpdateSettings={updateDraftSettings}
            onSaveSettings={handleSaveSettings}
            onBack={() => setActiveStep('trim')}
            onNext={() => setActiveStep('color')}
          />
        )}

        {activeStep === 'color' && (
          <ColorCorrectionStep
            sourceAsset={sourceAsset}
            logoAsset={logoAsset}
            settings={draftSettings}
            cues={draftCues}
            currentTimeMs={currentTimeMs}
            onTimeUpdate={setCurrentTimeMs}
            onUpdateSettings={updateDraftSettings}
            onSaveSettings={handleSaveSettings}
            onBack={() => setActiveStep('crop')}
            onNext={() => setActiveStep('audio')}
          />
        )}

        {activeStep === 'audio' && (
          <AudioEnhancementStep
            sourceAsset={sourceAsset}
            logoAsset={logoAsset}
            settings={draftSettings}
            cues={draftCues}
            currentTimeMs={currentTimeMs}
            onTimeUpdate={setCurrentTimeMs}
            onUpdateSettings={updateDraftSettings}
            onSaveSettings={handleSaveSettings}
            onBack={() => setActiveStep('color')}
            onNext={() => setActiveStep('logo')}
          />
        )}

        {activeStep === 'logo' && (
          <LogoStep
            projectId={project.id}
            sourceAsset={sourceAsset}
            logoAsset={logoAsset}
            settings={draftSettings}
            cues={draftCues}
            currentTimeMs={currentTimeMs}
            onTimeUpdate={setCurrentTimeMs}
            onUpdateSettings={updateDraftSettings}
            onSaveSettings={handleSaveSettings}
            onAssetsChanged={() => refetchProject()}
            onBack={() => setActiveStep('audio')}
            onNext={() => setActiveStep('subtitles')}
          />
        )}

        {activeStep === 'subtitles' && (
          <SubtitlesStep
            projectId={project.id}
            sourceAsset={sourceAsset}
            logoAsset={logoAsset}
            settings={draftSettings}
            cues={draftCues}
            cuesDirty={cuesDirty}
            subtitleVersion={activeSubVersion}
            detectedLanguage={project.detected_language}
            allowedFonts={
              capabilities?.allowed_fonts || [
                'DejaVu Sans',
                'Liberation Sans',
                'Ubuntu',
                'Noto Sans',
              ]
            }
            supportedLanguages={
              capabilities?.supported_languages || [
                { code: 'auto', name: 'Auto-detect' },
                { code: 'en', name: 'English' },
                { code: 'es', name: 'Spanish' },
                { code: 'fr', name: 'French' },
              ]
            }
            activeTranscribeJob={latestTranscribeJob}
            currentTimeMs={currentTimeMs}
            onTimeUpdate={setCurrentTimeMs}
            onUpdateSettings={updateDraftSettings}
            onUpdateCues={setDraftCues}
            onSaveSettings={handleSaveSettings}
            onSaveCues={handleSaveCues}
            onTranscriptionStarted={() => refetchProject()}
            onBack={() => setActiveStep('logo')}
            onNext={() => setActiveStep('outro')}
          />
        )}

        {activeStep === 'outro' && (
          <OutroStep
            projectId={project.id}
            sourceAsset={sourceAsset}
            outroAsset={outroAsset}
            settings={draftSettings}
            onUpdateSettings={updateDraftSettings}
            onSaveSettings={handleSaveSettings}
            onAssetsChanged={() => refetchProject()}
            onBack={() => setActiveStep('subtitles')}
            onNext={() => setActiveStep('export')}
          />
        )}

        {activeStep === 'export' && (
          <ReviewExportStep
            projectId={project.id}
            sourceAsset={sourceAsset}
            logoAsset={logoAsset}
            outroAsset={outroAsset}
            outputAsset={outputAsset}
            settings={draftSettings}
            cues={draftCues}
            subtitleVersion={activeSubVersion}
            detectedLanguage={project.detected_language}
            latestExportJob={latestExportJob}
            onUpdateSettings={updateDraftSettings}
            onFlushBeforeExport={handleFlushBeforeExport}
            onJobUpdated={() => refetchProject()}
            onBack={() => setActiveStep('outro')}
          />
        )}
      </div>
    </div>
  );
};
