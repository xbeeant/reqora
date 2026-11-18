import assert from "node:assert/strict";
import test from "node:test";
import {
  EXPORT_FORMAT_GROUPS,
  EXPORT_FORMATS,
  exportFormatSpec,
  formatsOfFamily,
} from "../src/lib/exportFormats.ts";

/**
 * 导出面板只有一条选择路径：族导航（EXPORT_FORMAT_GROUPS）→ 该族的格式卡片
 * （formatsOfFamily）→ 底部唯一的导出按钮（exportSpec.id）。
 * 若注册表里存在族导航选不到的格式，面板就会再次出现「两套入口覆盖不一致」。
 */
test("族导航覆盖注册表中的全部导出格式", () => {
  const families = new Set(EXPORT_FORMAT_GROUPS.map((group) => group.family));
  assert.equal(families.size, EXPORT_FORMAT_GROUPS.length, "格式族不应重复");
  for (const spec of EXPORT_FORMATS) {
    assert.ok(families.has(spec.family), `${spec.id} 缺少族导航入口`);
    assert.ok(
      formatsOfFamily(spec.family).some((item) => item.id === spec.id),
      `${spec.id} 无法通过族导航选中`,
    );
    assert.equal(exportFormatSpec(spec.id).id, spec.id);
  }
});

test("切换到任意格式族都有默认选中项与有效文件名", () => {
  for (const group of EXPORT_FORMAT_GROUPS) {
    const first = formatsOfFamily(group.family)[0];
    assert.ok(first, `${group.label} 没有可选格式`);
    assert.ok(first.fileName.trim() !== "", `${group.label} 的默认格式缺少文件名`);
  }
});

test("需要密码的格式唯一，面板可据 encrypted 条件显示密码输入", () => {
  const encrypted = EXPORT_FORMATS.filter((spec) => spec.encrypted);
  assert.equal(encrypted.length, 1);
  assert.equal(encrypted[0].family, "doc");
});
