import { create } from 'zustand';
import type { EditSettings, SubtitleCue, WorkflowStepId } from '@/types/video';

interface WorkflowState {
  activeProjectId: string | null;
  activeStep: WorkflowStepId;
  draftSettings: EditSettings | null;
  draftCues: SubtitleCue[];
  cuesDirty: boolean;
  settingsDirty: boolean;
  settingsRevision: number;
  currentTimeMs: number;
  activeJobId: string | null;

  setActiveProjectId: (projectId: string | null) => void;
  setActiveStep: (step: WorkflowStepId) => void;
  setDraftSettings: (settings: EditSettings, markDirty?: boolean) => void;
  updateDraftSettings: (updater: (prev: EditSettings) => EditSettings) => void;
  setDraftCues: (cues: SubtitleCue[], markDirty?: boolean) => void;
  setCurrentTimeMs: (ms: number) => void;
  setActiveJobId: (jobId: string | null) => void;
  markSettingsSaved: (revision?: number) => void;
  markCuesSaved: () => void;
}

export const useWorkflowStore = create<WorkflowState>((set) => ({
  activeProjectId: null,
  activeStep: 'upload',
  draftSettings: null,
  draftCues: [],
  cuesDirty: false,
  settingsDirty: false,
  settingsRevision: 0,
  currentTimeMs: 0,
  activeJobId: null,

  setActiveProjectId: (projectId) =>
    set((state) => {
      if (state.activeProjectId === projectId) return state;
      return {
        activeProjectId: projectId,
        activeStep: 'upload',
        draftSettings: null,
        draftCues: [],
        cuesDirty: false,
        settingsDirty: false,
        settingsRevision: 0,
        currentTimeMs: 0,
        activeJobId: null,
      };
    }),
  setActiveStep: (step) => set({ activeStep: step }),
  setDraftSettings: (settings, markDirty = false) =>
    set((state) => ({
      draftSettings: structuredClone(settings),
      settingsDirty: markDirty,
      settingsRevision: markDirty ? state.settingsRevision + 1 : state.settingsRevision,
    })),
  updateDraftSettings: (updater) =>
    set((state) => {
      if (!state.draftSettings) return state;
      const updated = updater(structuredClone(state.draftSettings));
      return {
        draftSettings: updated,
        settingsDirty: true,
        settingsRevision: state.settingsRevision + 1,
      };
    }),
  setDraftCues: (cues, markDirty = false) =>
    set({
      draftCues: cues.map((c, idx) => ({ ...c, sequence: idx + 1 })),
      cuesDirty: markDirty,
    }),
  setCurrentTimeMs: (ms) => set({ currentTimeMs: ms }),
  setActiveJobId: (jobId) => set({ activeJobId: jobId }),
  markSettingsSaved: (revision) =>
    set((state) => {
      if (revision !== undefined && state.settingsRevision !== revision) {
        return state;
      }
      return { settingsDirty: false };
    }),
  markCuesSaved: () => set({ cuesDirty: false }),
}));
