import { create } from 'zustand';
import type { EditSettings, SubtitleCue, WorkflowStepId } from '@/types/video';

interface WorkflowState {
  activeProjectId: string | null;
  activeStep: WorkflowStepId;
  draftSettings: EditSettings | null;
  draftCues: SubtitleCue[];
  cuesDirty: boolean;
  settingsDirty: boolean;
  currentTimeMs: number;
  activeJobId: string | null;

  setActiveProjectId: (projectId: string | null) => void;
  setActiveStep: (step: WorkflowStepId) => void;
  setDraftSettings: (settings: EditSettings, markDirty?: boolean) => void;
  updateDraftSettings: (updater: (prev: EditSettings) => EditSettings) => void;
  setDraftCues: (cues: SubtitleCue[], markDirty?: boolean) => void;
  setCurrentTimeMs: (ms: number) => void;
  setActiveJobId: (jobId: string | null) => void;
  markSettingsSaved: () => void;
  markCuesSaved: () => void;
}

export const useWorkflowStore = create<WorkflowState>((set) => ({
  activeProjectId: null,
  activeStep: 'upload',
  draftSettings: null,
  draftCues: [],
  cuesDirty: false,
  settingsDirty: false,
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
        currentTimeMs: 0,
        activeJobId: null,
      };
    }),
  setActiveStep: (step) => set({ activeStep: step }),
  setDraftSettings: (settings, markDirty = false) =>
    set({ draftSettings: structuredClone(settings), settingsDirty: markDirty }),
  updateDraftSettings: (updater) =>
    set((state) => {
      if (!state.draftSettings) return state;
      const updated = updater(structuredClone(state.draftSettings));
      return { draftSettings: updated, settingsDirty: true };
    }),
  setDraftCues: (cues, markDirty = false) =>
    set({
      draftCues: cues.map((c, idx) => ({ ...c, sequence: idx + 1 })),
      cuesDirty: markDirty,
    }),
  setCurrentTimeMs: (ms) => set({ currentTimeMs: ms }),
  setActiveJobId: (jobId) => set({ activeJobId: jobId }),
  markSettingsSaved: () => set({ settingsDirty: false }),
  markCuesSaved: () => set({ cuesDirty: false }),
}));
