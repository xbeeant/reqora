import { create } from "zustand";
import type { WorkspaceState } from "./workspace/types.ts";
import { createContext } from "./workspace/context.ts";
import { createCoreSlice } from "./workspace/slices/core.ts";
import { createCollectionsSlice } from "./workspace/slices/collections.ts";
import { createEnvironmentsSlice } from "./workspace/slices/environments.ts";
import { createDraftUiSlice } from "./workspace/slices/draftUi.ts";
import { createRequestRunSlice } from "./workspace/slices/requestRun.ts";
import { createCasesSlice } from "./workspace/slices/cases.ts";
import { createScenariosSlice } from "./workspace/slices/scenarios.ts";
import { createSuitesSlice } from "./workspace/slices/suites.ts";
import { createMiscSlice } from "./workspace/slices/misc.ts";
import { createProtocolsSlice } from "./workspace/slices/protocols.ts";
import { createCloudSlice } from "./workspace/slices/cloud.ts";
import { createImportExportSlice } from "./workspace/slices/importExport.ts";
import { createIntegrationsSlice } from "./workspace/slices/integrations.ts";
import { createHistorySlice } from "./workspace/slices/history.ts";
import { createSyncModeSlice } from "./workspace/slices/syncMode.ts";

export const useWorkspace = create<WorkspaceState>((set, get) => {
  const ctx = createContext(set, get);
  return {
    ...createCoreSlice(ctx),
    ...createCollectionsSlice(ctx),
    ...createEnvironmentsSlice(ctx),
    ...createDraftUiSlice(ctx),
    ...createRequestRunSlice(ctx),
    ...createCasesSlice(ctx),
    ...createScenariosSlice(ctx),
    ...createSuitesSlice(ctx),
    ...createMiscSlice(ctx),
    ...createProtocolsSlice(ctx),
    ...createCloudSlice(ctx),
    ...createImportExportSlice(ctx),
    ...createIntegrationsSlice(ctx),
    ...createHistorySlice(ctx),
    ...createSyncModeSlice(ctx),
  };
});
export type { WorkspaceState } from "./workspace/types.ts";
export {
  checkExternalChanges,
  startExternalChangeWatch,
  stopExternalChangeWatch,
} from "./workspace/externalChanges.ts";
