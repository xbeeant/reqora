import { dirname, join } from "node:path";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

/**
 * 原子写入：先写同目录 .tmp 再 rename。写入失败时清理临时文件后原样抛错。
 * mode 仅作用于临时文件（rename 后保留），用于敏感产物落盘收紧权限。
 */
export function writeFileAtomic(target, data, { mode } = {}) {
  const parent = dirname(target);
  const temp = join(parent, `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, data, { encoding: "utf8", ...(mode ? { mode } : {}) });
    renameSync(temp, target);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // 忽略临时文件清理失败，保留原始错误
    }
    throw error;
  }
}
