import { create } from "zustand";
import { api, ApiClientError } from "../lib/api.ts";
import type { UpdateCheckResult } from "../types";

export type UpdateCheckStatus =
  | "idle" // 尚未检查
  | "checking"
  | "latest" // 已是最新版本
  | "available" // 发现新版本
  | "error";

interface UpdateCheckState {
  status: UpdateCheckStatus;
  /** 最近一次成功检查的结果（latest / available 时有值）。 */
  result: UpdateCheckResult | null;
  /** 最近一次失败的提示文案（仅手动检查时向用户展示）。 */
  error: string | null;
  /** 本次结果是否来自手动检查（决定是否在界面上展示「已是最新 / 失败」反馈）。 */
  manual: boolean;
  /** 用户对「发现新版本」气泡点了「稍后」，不再重复打扰。 */
  dismissed: boolean;
  /** 触发一次更新检查。manual=true 时失败与「已最新」都会给出可见反馈。 */
  check: (manual: boolean, endpoint?: string) => Promise<void>;
  dismiss: () => void;
}

export const useUpdateCheck = create<UpdateCheckState>((set, get) => ({
  status: "idle",
  result: null,
  error: null,
  manual: false,
  dismissed: false,

  check: async (manual, endpoint) => {
    if (get().status === "checking") return;
    set({ status: "checking", manual, error: null });
    try {
      const result = await api.checkUpdate(endpoint);
      set({
        status: result.hasUpdate ? "available" : "latest",
        result,
        // 新的检查结果（尤其是发现新版本）重新覆盖「稍后」状态。
        dismissed: false,
      });
    } catch (error) {
      console.error("[updateCheck] error:", error);
      const message =
        error instanceof ApiClientError
          ? error.message
          : error instanceof Error
            ? error.message
            : "检查更新失败";
      set({ status: "error", error: message, result: null });
    }
  },

  dismiss: () => set({ dismissed: true }),
}));
