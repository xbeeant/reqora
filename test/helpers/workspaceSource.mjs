// 聚合 workspace store 的源码文本：`src/store/workspace.ts` 组合根 +
// `src/store/workspace/**/*.ts` 的全部模块，按路径排序后拼接。
// store 被拆成多个 slice 后，源码文本断言仍需看到完整实现。
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const STORE_DIR = resolve(HERE, "..", "..", "src", "store");

function collectTs(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTs(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

export function readWorkspaceSource() {
  const files = [join(STORE_DIR, "workspace.ts"), ...collectTs(join(STORE_DIR, "workspace"))];
  files.sort();
  return files.map((file) => readFileSync(file, "utf8")).join("\n");
}
