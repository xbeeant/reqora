import { useEffect, useRef, useState } from "react";
import { ArrowUpCircle, CheckCircle2, Download, Loader2, X } from "lucide-react";
import { useT } from "../i18n";
import { Button } from "./ui";
import { api } from "../lib/api";
import { useUpdateCheck } from "../store/updateCheck";

/** 启动后延迟检查的毫秒数，避免和工作区加载抢网络/带宽。 */
const AUTO_CHECK_DELAY_MS = 3000;
/** 「已是最新版本」这类手动反馈气泡自动消失的时间。 */
const TRANSIENT_MS = 4000;

/**
 * 更新检查浮层：
 * - 启动 3 秒后静默检查一次（失败不打扰，只写控制台日志）；
 * - 发现新版本时在右下角浮出提示，可跳转下载地址；
 * - 手动检查（状态栏版本号）会给出「已是最新 / 失败」的可见反馈。
 */
export function UpdateChecker() {
  const t = useT();
  const status = useUpdateCheck((state) => state.status);
  const result = useUpdateCheck((state) => state.result);
  const error = useUpdateCheck((state) => state.error);
  const manual = useUpdateCheck((state) => state.manual);
  const dismissed = useUpdateCheck((state) => state.dismissed);
  const check = useUpdateCheck((state) => state.check);
  const dismiss = useUpdateCheck((state) => state.dismiss);

  // 启动自动检查：只触发一次，失败保持静默。
  useEffect(() => {
    const timer = window.setTimeout(() => void check(false), AUTO_CHECK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [check]);

  // 每轮新状态（重新检查 / 新结果）都重置本地关闭标记。
  const [closed, setClosed] = useState(false);
  useEffect(() => {
    setClosed(false);
  }, [status, result]);

  // 「已是最新版本」的临时反馈几秒后自动收起。
  const hideTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    window.clearTimeout(hideTimer.current);
    if (status === "latest" && manual) {
      hideTimer.current = window.setTimeout(() => setClosed(true), TRANSIENT_MS);
    }
    return () => window.clearTimeout(hideTimer.current);
  }, [status, manual]);

  if (status === "idle" || closed) return null;
  if (status === "available" && dismissed) return null;

  if (status === "available" && result) {
    return (
      <div className="wb-toast fixed bottom-9 right-4 z-40 shadow-lg">
        <ArrowUpCircle className="h-4 w-4 text-brand-500" />
        <span className="text-xs text-ink">
          {t("tools.update.available", { version: result.latestVersion })}
          {result.currentVersion && (
            <span className="ml-1 text-ink-faint">
              {t("tools.update.currentSuffix", { version: result.currentVersion })}
            </span>
          )}
        </span>
        {result.downloadUrl ? (
          <Button
            size="sm"
            variant="primary"
            onClick={() => void api.openUrl(result.downloadUrl as string)}
          >
            <Download className="h-3.5 w-3.5" />
            {t("tools.update.download")}
          </Button>
        ) : null}
        <Button size="sm" variant="secondary" onClick={dismiss}>
          {t("tools.update.later")}
        </Button>
        <button type="button" aria-label={t("tools.update.closeToast")} onClick={() => setClosed(true)}>
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  if (status === "checking" && manual) {
    return (
      <div className="wb-toast fixed bottom-9 right-4 z-40">
        <Loader2 className="h-4 w-4 animate-spin text-ink-faint" />
        <span className="text-xs text-ink-soft">{t("tools.update.checking")}</span>
      </div>
    );
  }

  if (status === "latest" && manual && result) {
    return (
      <div className="wb-toast fixed bottom-9 right-4 z-40">
        <CheckCircle2 className="h-4 w-4 text-emerald-500" />
        <span className="text-xs text-ink-soft">
          {t("tools.update.latest", { version: result.currentVersion })}
        </span>
      </div>
    );
  }

  if (status === "error" && manual) {
    return (
      <div className="wb-toast fixed bottom-9 right-4 z-40">
        <span className="text-xs text-red-600">
          {t("tools.update.failed", { error: error ?? t("tools.common.unknownError") })}
        </span>
        <Button size="sm" variant="secondary" onClick={() => void check(true)}>
          {t("tools.common.retry")}
        </Button>
        <button type="button" aria-label={t("tools.update.closeToast")} onClick={() => setClosed(true)}>
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  return null;
}
