import { useRef } from "react";
import { FileUp, Paperclip, X } from "lucide-react";
import { formatBytes, readFileAsBase64 } from "../lib/file";
import type { BinaryBody } from "../types";
import { inputClass } from "./ui";
import { useT } from "../i18n";

interface Props {
  body: BinaryBody;
  onChange: (body: BinaryBody) => void;
}

/** Send a single file as the raw request body (Postman "binary" body type). */
export function BinaryEditor({ body, onChange }: Props) {
  const t = useT();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hasFile = body.data.length > 0;

  const pick = async (file: File | undefined) => {
    if (!file) return;
    const data = await readFileAsBase64(file);
    onChange({
      type: "binary",
      data,
      fileName: file.name,
      contentType: file.type || "application/octet-stream",
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        {hasFile ? (
          <div className="flex items-center gap-2 rounded-md border border-surface-border bg-surface px-3 py-2 text-xs">
            <Paperclip className="h-3.5 w-3.5 text-brand-500" />
            <span className="font-mono text-ink">{body.fileName}</span>
            <span className="text-ink-faint">{formatBytes((body.data.length * 3) / 4)}</span>
            <button
              type="button"
              className="ml-1 text-ink-faint hover:text-danger"
              aria-label={t("response.binary.removeFile")}
              onClick={() => onChange({ type: "binary", data: "", fileName: "", contentType: "" })}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="wb-btn wb-btn-ghost"
            onClick={() => fileInputRef.current?.click()}
          >
            <FileUp className="h-3.5 w-3.5" />
            {t("response.binary.pick")}
          </button>
        )}
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={(event) => {
            void pick(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
      </div>

      <div className="max-w-sm">
        <label className="wb-label">Content-Type</label>
        <input
          className={`${inputClass} font-mono`}
          value={body.contentType}
          placeholder="application/octet-stream"
          onChange={(event) =>
            onChange({ ...body, contentType: event.target.value })
          }
        />
      </div>

      <p className="wb-hint">
        {t("response.binary.hint")}
        <code className="font-mono"> application/octet-stream</code>
        {t("response.binary.hintEnd")}
      </p>
    </div>
  );
}
