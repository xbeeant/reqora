// Windows 共享的临时目录清理助手。
//
// 刚写完的文件偶尔仍被索引器 / 杀软 / 回收站删除机制短暂占用，rmSync 删掉
// 文件再 rmdir 时会抛 ENOTEMPTY / EPERM。node --test 多进程并行会放大这个竞态：
// 清理写在 finally / after 里时，抛出的异常会伪装成测试断言失败，让
// `bun release` 在前置校验阶段无辜中止。
//
// rmSync 自带的 maxRetries 只覆盖单次调用内部的重试；这里再包一层，处理
// 「整个调用都失败」的情况。测试用的临时目录删不掉只影响磁盘，不影响用例
// 结论，所以最终失败只告警；发布脚本里的产物目录清理必须失败即报错，不用此助手。
import { existsSync, rmSync } from "node:fs";

export function rmTemp(target, { attempts = 3, label = "临时目录", ...options } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      rmSync(target, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 50,
        ...options,
      });
      return;
    } catch (error) {
      // 上一轮其实已删干净，只是返回了错误：视为成功。
      if (!existsSync(target)) return;
      if (attempt === attempts - 1) {
        console.warn(`[rm-temp] ⚠ ${label} ${target} 清理失败（不影响用例结论）：${error.message}`);
      }
    }
  }
}
