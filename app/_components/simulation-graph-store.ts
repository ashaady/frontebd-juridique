"use client";

import { create } from "zustand";

export type SimulationGraphFocalView = "split" | "debate" | "structure" | "3d";

type SimulationGraphState = {
  caseId: string | null;
  focusedNodeId: string | null;
  focalView: SimulationGraphFocalView;
  resetForCase: (caseId: string | null) => void;
  setFocusedNodeId: (nodeId: string | null) => void;
  setFocalView: (view: SimulationGraphFocalView) => void;
};

export const useSimulationGraphStore = create<SimulationGraphState>((set, get) => ({
  caseId: null,
  focusedNodeId: null,
  focalView: "split",
  resetForCase: (caseId) => {
    if (get().caseId === caseId) return;
    set({ caseId, focusedNodeId: null, focalView: "split" });
  },
  setFocusedNodeId: (focusedNodeId) => set({ focusedNodeId }),
  setFocalView: (focalView) => set({ focalView })
}));
