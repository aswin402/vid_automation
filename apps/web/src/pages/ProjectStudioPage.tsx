import React, { useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Loader2, Save, CheckCircle2 } from 'lucide-react';
import { videoApi } from '@/api/videoApi';
import { useWorkflowStore } from '@/store/useWorkflowStore';
import { WorkflowStepper } from '@/components/studio/WorkflowStepper';
import { UploadStep } from '@/components/studio/steps/UploadStep';
import { TrimStep } from '@/components/studio/steps/TrimStep';
import { ColorCorrectionStep } from '@/components/studio/steps/ColorCorrectionStep';
import { LogoStep } from '@/components/studio/steps/LogoStep';
import { SubtitlesStep } from '@/components/studio/steps/SubtitlesStep';
import { OutroStep } from '@/components/studio/steps/OutroStep';
import { ReviewExportStep } from '@/components/studio/steps/ReviewExportStep';

export const ProjectStudioPage: React.FC = () => {
  const { projectId } = useParams<{ projectId: string }>();
  const queryClient = useQueryClient();

  const {
    activeStep,
    draftSettings,
    draftCues,
    cuesDirty,
    settingsDirty,
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

  // Initialize draftSettings when project loads
  useEffect(() => {
    if (project?.settings_json && !settingsDirty) {
      setDraftSettings(project.settings_json, false);
    }
  }, [project?.id, project?.settings_json]);

  // Initialize draftCues when subtitle version loads
  useEffect(() => {
    if (subtitleData?.cues && !cuesDirty) {
      setDraftCues(subtitleData.cues, false);
    }
  }, [subtitleData?.version, subtitleData?.cues]);

  // Refetch subtitles when a transcription job finishes
  const latestTranscribeJob = project?.jobs?.find((j) => j.kind === 'transcribe');
  useEffect(() => {
    if (latestTranscribeJob?.status === 'completed') {
      refetchSubtitles();
    }
  }, [latestTranscribeJob?.status, latestTranscribeJob?.subtitle_version]);

  // Auto-save draftSettings after 450ms of inactivity so drag/slider edits are always persisted
  useEffect(() => {
    if (!settingsDirty || !projectId || !draftSettings) return;
    const timer = window.setTimeout(async () => {
      try {
        const updated = await videoApi.updateProject(projectId, {
          settings: draftSettings,
        });
        markSettingsSaved();
        queryClient.setQueryData(['project', projectId], updated);
      } catch {
        // Manual save or pre-export flush will retry if network hiccups
      }
    }, 450);
    return () => window.clearTimeout(timer);
  }, [settingsDirty, projectId, draftSettings, markSettingsSaved, queryClient]);

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
    const updated = await videoApi.updateProject(projectId, {
      settings: draftSettings,
    });
    setDraftSettings(updated.settings_json, false);
    markSettingsSaved();
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
    if (projectId && draftSettings) {
      const updated = await videoApi.updateProject(projectId, {
        settings: draftSettings,
      });
      setDraftSettings(updated.settings_json, false);
      markSettingsSaved();
      queryClient.setQueryData(['project', projectId], updated);
    }
    return resolvedSubVer;
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
      {/* Studio Top Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Link
            to="/"
            className="p-2 rounded-xl border border-border hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Back to Dashboard"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div>
            <h1 className="text-lg font-bold leading-tight">{project.name}</h1>
            <span className="text-xs text-muted-foreground">
              {sourceAsset
                ? `${sourceAsset.original_filename} · ${sourceAsset.width}×${sourceAsset.height}`
                : 'Step 1: Upload a source video to begin'}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          {settingsDirty || cuesDirty ? (
            <button
              type="button"
              onClick={async () => {
                if (cuesDirty) await handleSaveCues();
                if (settingsDirty) await handleSaveSettings();
              }}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-amber-500/20 border border-amber-500/40 text-amber-300 text-xs font-semibold"
            >
              <Save className="h-3.5 w-3.5" />
              Save Unsaved Changes
            </button>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-xs text-emerald-400 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20">
              <CheckCircle2 className="h-3.5 w-3.5" />
              All changes saved
            </span>
          )}
        </div>
      </div>

      {/* 7-Step Guided Stepper */}
      <WorkflowStepper
        activeStep={activeStep}
        hasSourceVideo={Boolean(sourceAsset)}
        hasColorCorrection={Boolean(draftSettings.color_correction?.enabled)}
        hasLogo={Boolean(logoAsset && draftSettings.logo.enabled)}
        hasSubtitles={Boolean(
          draftSettings.subtitles.enabled && draftCues.length > 0
        )}
        hasOutro={Boolean(outroAsset && draftSettings.outro.enabled)}
        onSelectStep={async (step) => {
          setActiveStep(step);
          if (cuesDirty) await handleSaveCues();
          if (settingsDirty) await handleSaveSettings();
        }}
      />

      {/* Step Content */}
      <div className="rounded-3xl bg-card/50 border border-border p-5 sm:p-6 shadow-sm">
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
            onBack={() => setActiveStep('trim')}
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
            onBack={() => setActiveStep('color')}
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
            onFlushBeforeExport={handleFlushBeforeExport}
            onJobUpdated={() => refetchProject()}
            onBack={() => setActiveStep('outro')}
          />
        )}
      </div>
    </div>
  );
};
