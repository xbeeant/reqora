// Shared CLI argument parsing for the out-of-app entry points
// (`bin/reqora.mjs` and `bin/mcp.mjs`). Both used to carry their own copy
// of parseArgs/usage; this module is the single, option-driven implementation.
//
// ----------------------------------------------------------------------------
// 用法（Usage）
// ----------------------------------------------------------------------------
//
//   import { parseArgs, formatUsage } from "./cliArgs.mjs";
//
//   // 1. 每个入口声明自己的选项 spec（defaults 为普通对象，可由调用方在
//   //    构造时把环境变量折算进去；options 决定 argv 如何映射到结果对象）。
//   const spec = {
//     defaults: {
//       workspace: null,
//       allowWrite: process.env.REQORA_MCP_ALLOW_WRITE === "1",
//       maxBodyBytes: 16_384,
//       environment: null,
//       revealSecrets: false,
//       config: false,
//       help: false,
//     },
//     options: [
//       { key: "workspace",     flags: ["--workspace", "-w"], value: true,
//         label: "<路径>",       description: "项目数据目录 / 项目 id / 项目名" },
//       { key: "allowWrite",    flags: ["--allow-write"],
//         description: "允许修改数据" },
//       { key: "maxBodyBytes",  flags: ["--max-body-bytes"], value: true,
//         label: "<n>",
//         coerce: (raw, args) => Number(raw) || args.maxBodyBytes,
//         description: "响应体截断字节数" },
//       { key: "environment",   flags: ["--env"], value: true,
//         label: "<名称>",       description: "默认环境" },
//       { key: "revealSecrets", flags: ["--reveal-secrets"],
//         description: "返回真实鉴权/变量值" },
//       { key: "config",        flags: ["--config"],
//         description: "打印客户端配置" },
//       { key: "help",          flags: ["--help", "-h"],
//         description: "显示帮助" },
//     ],
//     usage: {
//       title: "Reqora MCP 服务",
//       command: "reqora mcp [选项]",
//       env: [
//         ["REQORA_WORKSPACE", "同 --workspace"],
//         ["REQORA_MCP_ALLOW_WRITE=1", "同 --allow-write"],
//       ],
//       footer: "只读工具不需要 --allow-write。",
//     },
//   };
//
//   // 2. 解析（argv 一般是 process.argv.slice(2)）。
//   const args = parseArgs(process.argv.slice(2), spec);
//   if (args.help) process.stdout.write(`${formatUsage(spec)}\n`);
//
// `bin/reqora.mjs` 用同样的两个函数、换成自己的 spec 即可；`bin/mcp.mjs`
// 的接入由维护者随后完成。本模块不 import 任何入口，也不依赖 node: 之外的包。
// ----------------------------------------------------------------------------

/**
 * @typedef {object} ArgOption
 * @property {string} key                      结果对象上的属性名
 * @property {string[]} flags                 触发该选项的 flag（含别名）
 * @property {boolean} [value=false]          true = 消耗下一个 argv token 作为值
 * @property {boolean} [equals=true]          是否支持 --flag=value（value 选项默认开启）
 * @property {(raw: string, args: object) => any} [coerce]  值转换；args 为当前已解析结果
 * @property {string} [label]                 帮助里 <占位符> 文本，如 "<路径>"
 * @property {string} [description]           帮助里的说明文字
 *
 * @typedef {object} ArgSpec
 * @property {object} defaults                 解析前的默认值对象
 * @property {ArgOption[]} options            选项描述
 * @property {{title?: string, command?: string, intro?: string,
 *             env?: [string, string][], footer?: string}} [usage]  帮助文本素材
 */

/**
 * 解析 argv 为选项对象。
 *
 * - 未知 flag 直接忽略（与两个入口原有行为一致）。
 * - `value: true` 的选项支持 `--flag value` 与 `--flag=value`；值可经
 *   `coerce(raw, args)` 转换（args 含默认值与已解析值，便于「解析失败回退默认」）。
 * - 其余选项为布尔开关，出现即置 true。
 * - 返回的是 defaults 的浅拷贝，不会修改传入的 spec。
 *
 * @param {string[]} argv
 * @param {ArgSpec} spec
 * @returns {Record<string, any>}
 */
export function parseArgs(argv, spec) {
  const args = { ...(spec.defaults ?? {}) };
  const byFlag = new Map();
  for (const option of spec.options ?? []) {
    for (const flag of option.flags ?? []) byFlag.set(flag, option);
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const equalsAt = token.indexOf("=");
    const flag = equalsAt > 0 ? token.slice(0, equalsAt) : token;
    const inline = equalsAt > 0 ? token.slice(equalsAt + 1) : undefined;
    const option = byFlag.get(flag);
    if (!option) continue;

    if (!option.value) {
      args[option.key] = true;
      continue;
    }
    const allowEquals = option.equals !== false;
    const raw = allowEquals && inline !== undefined ? inline : argv[++index];
    args[option.key] = option.coerce ? option.coerce(raw, args) : raw;
  }
  return args;
}

/**
 * 由 spec 生成帮助文本（标题 / 用法 / 选项表 / 环境变量 / 附言）。
 * 入口可在 `usage.footer` 里放各自特有的示例段落；本函数只负责通用排版。
 *
 * @param {ArgSpec} spec
 * @returns {string}
 */
export function formatUsage(spec) {
  const usage = spec.usage ?? {};
  const lines = [];
  if (usage.title) lines.push(usage.title);
  if (usage.command) lines.push("", "用法：", `  ${usage.command}`);
  if (usage.intro) lines.push("", usage.intro);

  const options = spec.options ?? [];
  if (options.length) {
    lines.push("", "选项：");
    const entries = options.map((option) => {
      const label = option.label ? ` ${option.label}` : "";
      return [`  ${(option.flags ?? []).join(", ")}${label}`, option.description ?? ""];
    });
    const width = Math.max(...entries.map(([left]) => left.length));
    for (const [left, description] of entries) {
      lines.push(`${left.padEnd(width + 2)}${description}`.trimEnd());
    }
  }

  if (usage.env?.length) {
    lines.push("", "环境变量：");
    const width = Math.max(...usage.env.map(([name]) => name.length));
    for (const [name, description] of usage.env) {
      lines.push(`  ${name.padEnd(width + 2)}${description}`.trimEnd());
    }
  }

  if (usage.footer) lines.push("", usage.footer);
  return lines.join("\n");
}
