/**
 * 响应字段表的「对象层级」投影。
 *
 * 字段定义本身用点路径存（`data.orders[0].total`），这样 OpenAPI / Markdown /
 * 校验都能直接消费；但文档里平铺一串点路径很难读。这里把扁平行还原成树，
 * 交给文档标签、文档站预览与 HTML / Markdown 导出按缩进层级渲染：
 *
 * ```
 * data            object
 *   orders        array<object>
 *     total       number
 * ```
 *
 * 父级节点在字段表里往往没有独立一行（派生只产出叶子），所以树上会出现
 * `item === null` 的合成节点，渲染时按「对象 / 数组」只读行处理。
 *
 * 渲染契约统一收敛在这里：
 * - `isGroup`：父级只读行，判定统一为 `children > 0`；
 * - `indent`：`depth * TREE_INDENT`，所有 px 缩进渲染直接复用；
 * - `leafName`：该行的最后一层字段名（`splitPath` 已把 `[0]` 下标折叠进
 *   前一层的 array 标记，因此这里不含下标）；
 * - `TREE_INDENT`：缩进步长常量，消除各渲染器里的 `depth * 14` 魔法数。
 * `depth` / `item` / `containerType` / `label` 等字段继续保留，供既有调用方
 * 向后兼容使用。
 */

/** 每层缩进的像素步长；HTML / React 渲染直接取 `row.indent`。 */
export const TREE_INDENT = 14;

export interface ResponseParamTreeRow<T> {
  /** 稳定 key；文档渲染直接复用。 */
  key: string;
  /** 去掉数组下标后的层级路径，如 `data.orders.total`。 */
  path: string;
  /** 当前层级名，如 `orders`、`total`。保留供向后兼容。 */
  label: string;
  /** 最后一层字段名，含 `[0]` 折叠语义（下标已归入父层 array 标记）。 */
  leafName: string;
  depth: number;
  /** 缩进像素 = depth * TREE_INDENT。 */
  indent: number;
  /** 子节点数量；大于 0 即为对象 / 数组层级。 */
  children: number;
  /** 父级只读行（isGroup 判定统一为 children > 0）。 */
  isGroup: boolean;
  /** 叶子为空串，父级为 `object` / `array<object>`。 */
  containerType: string;
  /** 字段表里的原行；派生出的合成父级为 null。 */
  item: T | null;
}

interface TreeNode<T> {
  label: string;
  path: string;
  array: boolean;
  item: T | null;
  /** 容器行（name 无下标，来自合成容器字段）优先于同名的下标叶子行。 */
  containerItem?: T | null;
  children: TreeNode<T>[];
}

const MAX_TREE_DEPTH = 12;

/** `data.orders[0].total` → `[data, orders, total]`，并把数组下标折叠成标记。 */
function splitPath(name: string): { label: string; array: boolean }[] {
  const tokens: { label: string; array: boolean }[] = [];
  for (const chunk of name.split(".")) {
    const text = chunk.trim();
    if (text === "") continue;
    const bracket = text.indexOf("[");
    const base = bracket === -1 ? text : text.slice(0, bracket);
    const hasIndex = bracket !== -1 && /\[[^\]]*\]/.test(text.slice(bracket));
    if (base !== "") {
      tokens.push({ label: base, array: hasIndex });
    } else if (hasIndex && tokens.length > 0) {
      // `a[0][1]` 这种连续下标：数组标记落在前一个字段上。
      tokens[tokens.length - 1].array = true;
    }
  }
  return tokens;
}

/**
 * 扁平的响应字段表 → 带层级的展开行（深度优先，父级在前）。
 * `location === "header"` 的行不参与嵌套，原样排在字段树之后。
 */
export function responseParamTreeRows<T extends { name: string; location?: string }>(
  rows: readonly T[],
): ResponseParamTreeRow<T>[] {
  const roots: TreeNode<T>[] = [];
  const headers: ResponseParamTreeRow<T>[] = [];

  for (const item of rows) {
    const name = (item.name ?? "").trim();
    if (name === "") continue;
    if (item.location === "header") {
      headers.push({
        key: `h:${name}`,
        path: name,
        label: name,
        leafName: name,
        depth: 0,
        indent: 0,
        children: 0,
        isGroup: false,
        containerType: "",
        item,
      });
      continue;
    }
    const tokens = splitPath(name);
    if (tokens.length === 0) continue;
    let level = roots;
    let path = "";
    tokens.slice(0, MAX_TREE_DEPTH).forEach((token, index) => {
      path = path === "" ? token.label : `${path}.${token.label}`;
      let node = level.find((candidate) => candidate.label === token.label);
      if (!node) {
        node = { label: token.label, path, array: token.array, item: null, children: [] };
        level.push(node);
      } else if (token.array) {
        node.array = true;
      }
      if (index === Math.min(tokens.length, MAX_TREE_DEPTH) - 1) node.item = item;
      level = node.children;
    });
  }

  const out: ResponseParamTreeRow<T>[] = [];
  const walk = (nodes: TreeNode<T>[], depth: number) => {
    for (const node of nodes) {
      const children = node.children.length;
      out.push({
        key: `b:${node.path}`,
        path: node.path,
        label: node.label,
        leafName: node.label,
        depth,
        indent: depth * TREE_INDENT,
        children,
        isGroup: children > 0,
        containerType: children === 0 ? "" : node.array ? "array<object>" : "object",
        item: node.item,
      });
      walk(node.children, depth + 1);
    }
  };
  walk(roots, 0);
  return [...out, ...headers];
}

/**
 * 「请求参数」的字段树投影：把 `deriveParamSections` 里 JSON Body 被
 * `flattenJson` 展平的点路径（如 `specValueList[0].bid`）还原成层级视图。
 *
 * 与响应字段树共用 TreeNode / splitPath / 渲染契约（isGroup / indent /
 * leafName / TREE_INDENT），差别在容器的判定与类型标注：
 * - 带数组下标的节点（含只有 `[0]` 的标量数组）一律作为 array 容器行，
 *   不展示下标本身；对象数组则把对象字段作为缩进子节点。
 * - 容器行类型统一显示 `array` / `object` 这样的结构词，而不是从某个元素
 *   推导出的 `string`；用户看到的语义是「productBidList 是 array」。
 * - 只做形状投影：值与文档元数据从 `item` 读取。带合成容器行时，array /
 *   object 分组节点会以容器行作为 item（稳定 key 可编辑示例值 / 说明）；
 *   旧快照只有下标叶子时，分组节点 item 为 null，按只读结构行渲染。
 */
export function requestBodyFieldTreeRows<T extends { name: string; location?: string }>(
  rows: readonly T[],
): ResponseParamTreeRow<T>[] {
  const roots: TreeNode<T>[] = [];
  const headers: ResponseParamTreeRow<T>[] = [];

  for (const item of rows) {
    const name = (item.name ?? "").trim();
    if (name === "") continue;
    // Query / Header 是平铺键值，不参与嵌套；只有 Body 字段需要还原对象层级。
    if (item.location === "header" || item.location === "query") {
      headers.push({
        key: `${item.location}:${name}`,
        path: name,
        label: name,
        leafName: name,
        depth: 0,
        indent: 0,
        children: 0,
        isGroup: false,
        containerType: "",
        item,
      });
      continue;
    }
    const tokens = splitPath(name);
    if (tokens.length === 0) continue;
    let level = roots;
    let path = "";
    const capped = Math.min(tokens.length, MAX_TREE_DEPTH);
    tokens.slice(0, MAX_TREE_DEPTH).forEach((token, index) => {
      path = path === "" ? token.label : `${path}.${token.label}`;
      let node = level.find((candidate) => candidate.label === token.label);
      if (!node) {
        node = { label: token.label, path, array: token.array, item: null, containerItem: null, children: [] };
        level.push(node);
      } else if (token.array) {
        node.array = true;
      }
      if (index === capped - 1) {
        // 合成容器行的 name 与节点 path 一致且不含下标；下标叶子行 name 含 `[...]`。
        // 无论遍历顺序，容器行都优先成为分组行的可编辑 item。
        if (item.name === path) node.containerItem = item;
        else node.item = item;
      }
      level = node.children;
    });
  }

  const out: ResponseParamTreeRow<T>[] = [];
  const walk = (nodes: TreeNode<T>[], depth: number) => {
    for (const node of nodes) {
      const children = node.children.length;
      // 数组节点（含只有下标元素的标量数组）一律是容器；普通对象有子节点时也是容器。
      const isGroup = node.array || children > 0;
      out.push({
        key: `${node.array ? "arr" : "obj"}:${node.path}`,
        path: node.path,
        label: node.label,
        leafName: node.label,
        depth,
        indent: depth * TREE_INDENT,
        children,
        isGroup,
        containerType: isGroup ? (node.array ? "array" : "object") : "",
        // 容器行（由 containerFieldRows 合成）优先于下标叶子，成为分组行的可编辑
        // item；没有合成行时仍回退到叶子 item（旧快照兼容）。
        item: node.containerItem ?? node.item,
      });
      walk(node.children, depth + 1);
    }
  };
  walk(roots, 0);
  return [...out, ...headers];
}
