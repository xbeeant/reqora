import { useEffect, useState, type ReactNode } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import {
  normalizeDocSitePayload,
  type DocSitePayload,
} from "./lib/docSitePayload.ts";
import { DocSiteViewer } from "./components/DocSiteViewer";
import { useT } from "./i18n";

/**
 * 网页版入口：同一个 Vite 构建产物，URL 带 `?doc=<token>` 时走这里。
 *
 * 它完全不加载桌面端 App / zustand store / Tauri API，因此可以把同一份 dist
 * 放到任意静态托管；只需要 `?api=<后端地址>`（跨源时）或同源部署。
 * 渲染交给与桌面端预览共用的 DocSiteViewer，服务端不写任何 HTML 渲染逻辑。
 */

type LoadState =
  | { status: "loading" }
  | { status: "ready"; payload: DocSitePayload }
  | { status: "error"; message: string };

function apiBase(): string {
  const fromUrl = new URLSearchParams(window.location.search).get("api");
  return fromUrl ? fromUrl.replace(/\/+$/, "") : window.location.origin;
}

function StatusPage({ children, error = false }: { children: ReactNode; error?: boolean }) {
  const t = useT();
  return (
    <div className="wb-docsite-status-page">
      <div className="wb-docsite-status-card">
        {error ? (
          <AlertCircle className="h-6 w-6 text-red-500" />
        ) : (
          <Loader2 className="h-6 w-6 animate-spin text-brand-500" />
        )}
        <p>{children}</p>
        {error ? <small>{t("docs.load.hint")}</small> : null}
      </div>
    </div>
  );
}

export function DocSiteApp({ token }: { token: string }) {
  const t = useT();
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      setState({ status: "loading" });
      try {
        const response = await fetch(
          `${apiBase()}/api/v1/doc-sites/${encodeURIComponent(token)}`,
          { headers: { Accept: "application/json" }, signal: controller.signal },
        );
        const envelope = (await response.json().catch(() => null)) as {
          code?: number;
          message?: string;
          data?: unknown;
        } | null;
        if (!response.ok || envelope?.code !== 0) {
          throw new Error(envelope?.message || t("docs.load.failed", { status: response.status }));
        }
        // 服务端数据不可信：有界归一化后才交给渲染器。
        const payload = normalizeDocSitePayload(envelope.data);
        if (!payload) throw new Error(t("docs.load.badData"));
        setState({ status: "ready", payload });
        document.title = `${payload.title} · Reqora`;
      } catch (error) {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    };
    void load();
    return () => controller.abort();
  }, [token]);

  // 网页版没有桌面端 workspace，单独跟随系统深浅色偏好。
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.documentElement.classList.toggle("dark", media.matches);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);

  if (state.status === "loading") return <StatusPage>{t("docs.loading")}</StatusPage>;
  if (state.status === "error") {
    return <StatusPage error>{state.message}</StatusPage>;
  }
  return (
    <div className="wb-docsite-page">
      <DocSiteViewer payload={state.payload} mode="public" />
    </div>
  );
}
