/**
 * SOAP 1.1 / 1.2 + WSDL 1.1 + WS-Security —— 纯逻辑核心。
 *
 * 设计约束：
 * - 零依赖，浏览器与 Node 均可运行；不使用 DOMParser、Buffer、WebCrypto、node:crypto。
 * - 用轻量的字符串 XML 扫描器 + 小型树结构替代 DOM，支持属性单/双引号、
 *   命名空间前缀、自闭合标签、CDATA、注释、处理指令。
 * - 不解析 DTD / ENTITY（防 XXE）：实体解码只处理 5 个预定义实体与数字引用。
 * - SHA-256 / Base64 全部用同步纯 JS 实现，便于发送前同步拼装 WSSE 摘要。
 *
 * Node 22 会原生剥离 TypeScript 类型，故本文件只使用「可擦除」语法
 * （type / interface / 类型注解 / 类型断言），不使用 enum、namespace、参数属性等。
 */

/* -------------------------------------------------------------------------- */
/* 公共类型                                                                    */
/* -------------------------------------------------------------------------- */

export type SoapVersion = "1.1" | "1.2";

export interface SoapPart {
  name: string;
  type?: string;
  element?: string;
}

export interface SoapOperation {
  name: string;
  soapAction: string;
  namespace: string;
  endpoint?: string;
  style: "rpc" | "document";
  version: SoapVersion;
  inputParts: SoapPart[];
  inputElement?: string;
}

export interface WsdlInfo {
  targetNamespace: string;
  version: SoapVersion;
  endpoint?: string;
  operations: SoapOperation[];
  warnings: string[];
}

export interface SoapEnvelopeSpec {
  version: SoapVersion;
  operation?: string;
  namespace?: string;
  parameters?: Record<string, unknown>;
  bodyXml?: string;
  headerXml?: string;
  wsSecurity?: boolean;
  username?: string;
  password?: string;
  passwordType?: "PasswordText" | "PasswordDigest";
  nonce?: string;
  created?: string;
}

/** SOAP 1.1 / 1.2 的 Envelope 命名空间。 */
const ENV_NS_11 = "http://schemas.xmlsoap.org/soap/envelope/";
const ENV_NS_12 = "http://www.w3.org/2003/05/soap-envelope";

/* -------------------------------------------------------------------------- */
/* XML 转义 / 实体                                                             */
/* -------------------------------------------------------------------------- */

/**
 * XML 文本/属性转义：& < > " ' 五个字符，单次扫描避免重复转义。
 */
export function escapeXml(text: string): string {
  return String(text).replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&apos;";
      default: return c;
    }
  });
}

/**
 * 只解码 5 个预定义实体与数字字符引用（单次扫描，不做二次解码）。
 * 绝不会展开自定义实体 —— 这是防 XXE 的关键。
 */
function decodeEntities(s: string): string {
  return s.replace(/&(?:lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (m) => {
    switch (m) {
      case "&lt;": return "<";
      case "&gt;": return ">";
      case "&amp;": return "&";
      case "&quot;": return '"';
      case "&apos;": return "'";
      default: {
        const hex = m[2] === "x" || m[2] === "X";
        const code = hex ? parseInt(m.slice(3, -1), 16) : parseInt(m.slice(2, -1), 10);
        try {
          return String.fromCodePoint(code);
        } catch {
          return m;
        }
      }
    }
  });
}

/* -------------------------------------------------------------------------- */
/* 轻量 XML 扫描器 + 树                                                        */
/* -------------------------------------------------------------------------- */

interface XmlNode {
  type: "root" | "element" | "text" | "cdata" | "comment" | "pi";
  name?: string;
  prefix?: string;
  local?: string;
  attrs?: Record<string, string>;
  rawAttrs?: string;
  selfClose?: boolean;
  text?: string;
  children?: XmlNode[];
}

/** 找到标签结束的 `>`，跳过引号内的 `>`。 */
function findTagEnd(xml: string, start: number): number {
  let quote: string | null = null;
  for (let i = start + 1; i < xml.length; i++) {
    const c = xml[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return i;
    }
  }
  return -1;
}

/** 解析开始标签内部：返回标签名、属性表（已解码）、原始属性串（用于无损回写）。 */
function parseTagInner(inner: string): {
  name: string;
  attrs: Record<string, string>;
  rawAttrs: string;
} {
  const nameMatch = inner.match(/^\s*([^\s/>]+)/);
  const name = nameMatch ? nameMatch[1] : "";
  const rest = nameMatch ? inner.slice(nameMatch[0].length) : inner;
  const attrs: Record<string, string> = {};
  // 属性名允许 `: / - . _` 等；值支持双引号、单引号、无引号。
  const re = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest)) !== null) {
    const raw = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
    attrs[m[1]] = decodeEntities(raw);
  }
  return { name, attrs, rawAttrs: rest.trim() };
}

type Token =
  | { kind: "start"; name: string; attrs: Record<string, string>; rawAttrs: string; selfClose: boolean }
  | { kind: "end"; name: string }
  | { kind: "text" | "cdata" | "comment" | "pi"; text: string };

/** 线性扫描 XML，产出扁平 token 流。不展开 DTD / ENTITY。 */
function tokenize(xml: string, emit: (t: Token) => void): void {
  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      if (i < n) emit({ kind: "text", text: xml.slice(i) });
      break;
    }
    if (lt > i) emit({ kind: "text", text: xml.slice(i, lt) });

    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      const stop = end < 0 ? n : end;
      emit({ kind: "comment", text: xml.slice(lt + 4, stop) });
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      const stop = end < 0 ? n : end;
      emit({ kind: "cdata", text: xml.slice(lt + 9, stop) });
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      const stop = end < 0 ? n : end + 2;
      emit({ kind: "pi", text: xml.slice(lt, stop) });
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (xml.startsWith("<!", lt)) {
      // DOCTYPE / ENTITY / 其它声明：只读跳过，绝不展开。
      const end = xml.indexOf(">", lt + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (xml[lt + 1] === "/") {
      const end = xml.indexOf(">", lt + 2);
      const name = end < 0 ? xml.slice(lt + 2).trim() : xml.slice(lt + 2, end).trim();
      emit({ kind: "end", name });
      i = end < 0 ? n : end + 1;
      continue;
    }
    // 开始标签
    const gt = findTagEnd(xml, lt);
    if (gt < 0) {
      emit({ kind: "text", text: xml.slice(lt) });
      break;
    }
    let inner = xml.slice(lt + 1, gt);
    const selfClose = /\/\s*$/.test(inner);
    if (selfClose) inner = inner.replace(/\/\s*$/, "");
    const { name, attrs, rawAttrs } = parseTagInner(inner);
    emit({ kind: "start", name, attrs, rawAttrs, selfClose });
    i = gt + 1;
  }
}

/** 由 token 流构建一棵宽容的 XML 树（对未闭合标签尽量容错）。 */
function parseXmlTree(xml: string): XmlNode {
  const root: XmlNode = { type: "root", children: [] };
  const stack: XmlNode[] = [root];
  tokenize(xml, (tok) => {
    const parent = stack[stack.length - 1];
    if (tok.kind === "start") {
      const idx = tok.name.indexOf(":");
      const el: XmlNode = {
        type: "element",
        name: tok.name,
        prefix: idx >= 0 ? tok.name.slice(0, idx) : "",
        local: idx >= 0 ? tok.name.slice(idx + 1) : tok.name,
        attrs: tok.attrs,
        rawAttrs: tok.rawAttrs,
        selfClose: tok.selfClose,
        children: [],
      };
      parent.children!.push(el);
      if (!tok.selfClose) stack.push(el);
    } else if (tok.kind === "end") {
      if (stack.length > 1) {
        let match = -1;
        for (let k = stack.length - 1; k >= 1; k--) {
          if (stack[k].name === tok.name) { match = k; break; }
        }
        if (match >= 1) stack.length = match;
      }
    } else {
      parent.children!.push({ type: tok.kind, text: tok.text });
    }
  });
  return root;
}

/** 取直接子元素中 local name 匹配的元素。 */
function childrenByLocal(el: XmlNode | undefined | null, local: string): XmlNode[] {
  if (!el || !el.children) return [];
  return el.children.filter((c) => c.type === "element" && c.local === local);
}

/** 深度优先查找（不含自身）第一个 local name 匹配的后代元素。 */
function findDescendant(el: XmlNode, local: string): XmlNode | null {
  for (const c of el.children || []) {
    if (c.type === "element") {
      if (c.local === local) return c;
      const found = findDescendant(c, local);
      if (found) return found;
    }
  }
  return null;
}

/** 读取属性：先精确匹配，再按去前缀的 local name 匹配（排除 xmlns 声明）。 */
function getAttr(el: XmlNode | undefined | null, key: string): string {
  if (!el || !el.attrs) return "";
  const attrs = el.attrs;
  if (Object.prototype.hasOwnProperty.call(attrs, key)) return attrs[key];
  for (const k of Object.keys(attrs)) {
    if (k.startsWith("xmlns")) continue;
    const idx = k.indexOf(":");
    const local = idx >= 0 ? k.slice(idx + 1) : k;
    if (local === key) return attrs[k];
  }
  return "";
}

/** 收集元素及其后代的文本（实体解码，CDATA 视为字面量）。 */
function elementText(el: XmlNode | null): string {
  let out = "";
  const walk = (node: XmlNode): void => {
    if (node.type === "text") out += decodeEntities(node.text || "");
    else if (node.type === "cdata") out += node.text || "";
    else if (node.type === "element") for (const c of node.children || []) walk(c);
  };
  if (el) for (const c of el.children || []) walk(c);
  return out.trim();
}

/** 无损回写节点（不改动任何文本/属性，供 prettify 与 fault detail 使用）。 */
function rawXml(node: XmlNode): string {
  switch (node.type) {
    case "element": {
      const open = `<${node.name}${node.rawAttrs ? " " + node.rawAttrs : ""}`;
      if (node.selfClose) return `${open}/>`;
      return `${open}>${(node.children || []).map(rawXml).join("")}</${node.name}>`;
    }
    case "text": return node.text || "";
    case "cdata": return `<![CDATA[${node.text || ""}]]>`;
    case "comment": return `<!--${node.text || ""}-->`;
    case "pi": return node.text || "";
    default: return (node.children || []).map(rawXml).join("");
  }
}

/* -------------------------------------------------------------------------- */
/* WSDL 解析                                                                   */
/* -------------------------------------------------------------------------- */

const SOAP11_BINDING_NS = "http://schemas.xmlsoap.org/wsdl/soap/";
const SOAP12_BINDING_NS = "http://schemas.xmlsoap.org/wsdl/soap12/";

function qnameLocal(q: string): string {
  const s = String(q || "").trim();
  const idx = s.lastIndexOf(":");
  return idx >= 0 ? s.slice(idx + 1) : s;
}

/** 收集整篇文档的 xmlns 声明：prefix -> uri。 */
function collectAllNamespaces(tree: XmlNode): Record<string, string> {
  const map: Record<string, string> = {};
  const walk = (node: XmlNode): void => {
    if (node.type === "element" && node.attrs) {
      for (const [k, v] of Object.entries(node.attrs)) {
        if (k === "xmlns") map[""] = v;
        else if (k.startsWith("xmlns:")) map[k.slice(6)] = v;
      }
    }
    for (const c of node.children || []) walk(c);
  };
  walk(tree);
  return map;
}

/** 依据 soap:binding / soap12:binding 扩展判断 SOAP 版本。 */
function detectVersion(soapBinding: XmlNode, nsOf: (p: string) => string): SoapVersion {
  const uri = nsOf(soapBinding.prefix || "") || "";
  if (/soap12/i.test(uri) || /\/2003\/05/.test(uri) || /12/.test(soapBinding.prefix || "")) {
    return "1.2";
  }
  if (uri === SOAP11_BINDING_NS) return "1.1";
  if (uri === SOAP12_BINDING_NS) return "1.2";
  return "1.1";
}

/** soapAction 缺省时的回退：命名空间 + 操作名。 */
function fallbackSoapAction(namespace: string, name: string): string {
  if (!namespace) return name;
  return /[/#:]$/.test(namespace) ? namespace + name : namespace + "/" + name;
}

/**
 * 解析 WSDL 1.1：把 operation → binding → portType → message/part 串起来。
 * 缺失信息时写入 warnings，而不是抛错（唯一例外：DTD/ENTITY 直接拒绝）。
 * @throws 文档包含 <!DOCTYPE> 或 <!ENTITY> 时抛中文错误（XXE 防护）。
 */
export function parseWsdl(xml: string): WsdlInfo {
  if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(xml)) {
    throw new Error("出于 XXE 防护，parseWsdl 拒绝包含 <!DOCTYPE> 或 <!ENTITY> 的文档");
  }

  const tree = parseXmlTree(xml);
  const warnings: string[] = [];
  const definitions = findDescendant(tree, "definitions");
  const root: XmlNode = definitions || tree;
  if (!definitions) warnings.push("未找到 <definitions> 根元素，按空文档处理");

  const targetNamespace = getAttr(definitions, "targetNamespace");
  if (!targetNamespace) warnings.push("缺少 definitions/@targetNamespace");

  const nsMap = collectAllNamespaces(tree);
  const nsOf = (p: string): string => nsMap[p] || "";

  // message -> parts
  const messages = new Map<string, SoapPart[]>();
  for (const msg of childrenByLocal(root, "message")) {
    const name = getAttr(msg, "name");
    const parts: SoapPart[] = childrenByLocal(msg, "part").map((p) => {
      const part: SoapPart = { name: getAttr(p, "name") };
      const t = getAttr(p, "type");
      const e = getAttr(p, "element");
      if (t) part.type = t;
      if (e) part.element = e;
      return part;
    });
    messages.set(name, parts);
  }

  // portType -> operation -> input/output message
  const portTypes = new Map<string, Map<string, { inputMessage: string; outputMessage: string }>>();
  for (const pt of childrenByLocal(root, "portType")) {
    const ops = new Map<string, { inputMessage: string; outputMessage: string }>();
    for (const op of childrenByLocal(pt, "operation")) {
      const input = childrenByLocal(op, "input")[0];
      const output = childrenByLocal(op, "output")[0];
      ops.set(getAttr(op, "name"), {
        inputMessage: input ? getAttr(input, "message") : "",
        outputMessage: output ? getAttr(output, "message") : "",
      });
    }
    portTypes.set(getAttr(pt, "name"), ops);
  }

  // binding -> operations
  const bindingContainers = childrenByLocal(root, "binding");
  if (bindingContainers.length === 0) {
    warnings.push("未发现任何 <binding>，无法生成 SOAP 操作");
  }

  const operations: Array<{ op: SoapOperation; bindingName: string }> = [];
  let firstVersion: SoapVersion = "1.1";
  let versionSet = false;

  for (const binding of bindingContainers) {
    const bName = getAttr(binding, "name");
    const soapBinding = childrenByLocal(binding, "binding")[0];
    let version: SoapVersion = "1.1";
    let bindingStyle: "rpc" | "document" = "document";
    if (soapBinding) {
      version = detectVersion(soapBinding, nsOf);
      if (getAttr(soapBinding, "style") === "rpc") bindingStyle = "rpc";
      if (!versionSet) { firstVersion = version; versionSet = true; }
    } else {
      warnings.push(`binding「${bName || "(未命名)"}」缺少 soap:binding/soap12:binding 扩展，版本默认按 SOAP 1.1 处理`);
    }

    const typeAttr = getAttr(binding, "type");
    const ptOps = typeAttr ? portTypes.get(qnameLocal(typeAttr)) : undefined;
    if (!typeAttr) {
      warnings.push(`binding「${bName || "(未命名)"}」缺少 @type，无法关联 portType`);
    } else if (!ptOps) {
      warnings.push(`binding「${bName || "(未命名)"}」引用的 portType「${qnameLocal(typeAttr)}」未找到`);
    }

    for (const bop of childrenByLocal(binding, "operation")) {
      const opName = getAttr(bop, "name");
      const soapOp = childrenByLocal(bop, "operation")[0];
      let rawAction = "";
      let opStyle = bindingStyle;
      if (soapOp) {
        rawAction = getAttr(soapOp, "soapAction");
        const st = getAttr(soapOp, "style");
        if (st === "rpc" || st === "document") opStyle = st;
      }

      const input = childrenByLocal(bop, "input")[0];
      let bodyNs = "";
      if (input) {
        const body = childrenByLocal(input, "body")[0];
        if (body) bodyNs = getAttr(body, "namespace");
      }
      const namespace = bodyNs || targetNamespace || "";
      const soapAction = rawAction || fallbackSoapAction(namespace, opName);

      let inputParts: SoapPart[] = [];
      let inputElement: string | undefined;
      const ptOp = ptOps ? ptOps.get(opName) : undefined;
      if (ptOp && ptOp.inputMessage) {
        const mName = qnameLocal(ptOp.inputMessage);
        const parts = messages.get(mName);
        if (parts) {
          inputParts = parts;
          if (parts.length === 1 && parts[0].element) inputElement = parts[0].element;
        } else {
          warnings.push(`操作「${opName}」引用的输入 message「${mName}」未找到`);
        }
      } else if (ptOps && !ptOp) {
        warnings.push(`portType 中未找到与绑定操作「${opName}」对应的 operation`);
      } else if (!ptOps) {
        warnings.push(`操作「${opName}」无法解析输入 message（portType 未关联）`);
      }

      const op: SoapOperation = {
        name: opName,
        soapAction,
        namespace,
        style: opStyle,
        version,
        inputParts,
      };
      if (inputElement) op.inputElement = inputElement;
      operations.push({ op, bindingName: bName });
    }
  }

  // service/port -> soap:address@location
  const endpoints = new Map<string, string>();
  for (const svc of childrenByLocal(root, "service")) {
    for (const port of childrenByLocal(svc, "port")) {
      const bindingRef = qnameLocal(getAttr(port, "binding"));
      const addr = childrenByLocal(port, "address")[0];
      const location = addr ? getAttr(addr, "location") : "";
      if (bindingRef && location) endpoints.set(bindingRef, location);
    }
  }
  for (const entry of operations) {
    const ep = endpoints.get(entry.bindingName);
    if (ep) entry.op.endpoint = ep;
  }
  if (endpoints.size === 0) {
    warnings.push("未发现 service/port 下的 soap:address，endpoint 未知");
  }

  const info: WsdlInfo = {
    targetNamespace: targetNamespace || "",
    version: firstVersion,
    operations: operations.map((e) => e.op),
    warnings,
  };
  if (endpoints.size > 0) info.endpoint = endpoints.values().next().value;
  return info;
}

/* -------------------------------------------------------------------------- */
/* Content-Type / SOAPAction                                                   */
/* -------------------------------------------------------------------------- */

export function soapContentType(version: SoapVersion): string {
  return version === "1.2"
    ? "application/soap+xml; charset=utf-8"
    : "text/xml; charset=utf-8";
}

export function soapActionHeader(
  op: Pick<SoapOperation, "soapAction" | "version">,
): { key: string; value: string } {
  if (op.version === "1.2") {
    return {
      key: "Content-Type",
      value: `application/soap+xml; charset=utf-8; action="${op.soapAction}"`,
    };
  }
  return { key: "SOAPAction", value: op.soapAction };
}

/* -------------------------------------------------------------------------- */
/* 同步 SHA-256 + Base64（纯 JS）                                              */
/* -------------------------------------------------------------------------- */

const K256: number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** UTF-8 编码（自行处理代理对，避免依赖 TextEncoder / Buffer）。 */
function utf8Bytes(str: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let cp = str.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < str.length) {
      const lo = str.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    }
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return out;
}

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/** 同步 SHA-256，返回 32 字节数组。 */
function sha256Bytes(message: string): number[] {
  const bytes = utf8Bytes(message);
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  bytes.push(
    (hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff,
    (lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff,
  );

  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Array<number>(64);
  for (let off = 0; off < bytes.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = (bytes[off + 4 * i] << 24) | (bytes[off + 4 * i + 1] << 16) | (bytes[off + 4 * i + 2] << 8) | bytes[off + 4 * i + 3];
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K256[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }
  const out: number[] = [];
  for (const x of H) out.push((x >>> 24) & 0xff, (x >>> 16) & 0xff, (x >>> 8) & 0xff, x & 0xff);
  return out;
}

/** SHA-256 十六进制（附加导出，便于已知向量测试）。 */
export function sha256Hex(message: string): string {
  return sha256Bytes(message).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64Encode(bytes: number[]): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    const has1 = b1 !== undefined;
    const has2 = b2 !== undefined;
    const n = (b0 << 16) | ((has1 ? b1 : 0) << 8) | (has2 ? b2 : 0);
    out += chars[(n >>> 18) & 63] + chars[(n >>> 12) & 63]
      + (has1 ? chars[(n >>> 6) & 63] : "=")
      + (has2 ? chars[n & 63] : "=");
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* WS-Security                                                                 */
/* -------------------------------------------------------------------------- */

const WSSE_NS = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd";
const WSU_NS = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd";
const TOKEN_PROFILE = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0";

function defaultNonce(): string {
  const n = Math.floor(Math.random() * 0xffffffff);
  return base64Encode([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff])
    + Date.now().toString(16);
}

/**
 * 生成 <wsse:Security> 片段（同步）。
 * PasswordDigest = Base64(SHA256(nonce + created + password))。
 */
export function buildWsseHeader(
  username: string,
  password: string,
  options?: { passwordType?: "PasswordText" | "PasswordDigest"; nonce?: string; created?: string },
): string {
  const opts = options || {};
  const passwordType = opts.passwordType || "PasswordText";
  let nonce = opts.nonce;
  let created = opts.created;
  let passwordValue = password;

  if (passwordType === "PasswordDigest") {
    if (!nonce) nonce = defaultNonce();
    if (!created) created = new Date().toISOString();
    passwordValue = base64Encode(sha256Bytes(String(nonce) + String(created) + String(password)));
  }

  const showNonce = passwordType === "PasswordDigest" || (!!opts.nonce && opts.nonce.length > 0);
  const showCreated = passwordType === "PasswordDigest" || (!!opts.created && opts.created.length > 0);

  let s = `<wsse:Security xmlns:wsse="${WSSE_NS}" xmlns:wsu="${WSU_NS}">`;
  s += "<wsse:UsernameToken>";
  s += `<wsse:Username>${escapeXml(username)}</wsse:Username>`;
  s += `<wsse:Password Type="${TOKEN_PROFILE}#${passwordType}">${escapeXml(passwordValue)}</wsse:Password>`;
  if (showNonce) s += `<wsse:Nonce>${escapeXml(String(nonce || ""))}</wsse:Nonce>`;
  if (showCreated) s += `<wsu:Created>${escapeXml(String(created || ""))}</wsu:Created>`;
  s += "</wsse:UsernameToken></wsse:Security>";
  return s;
}

/* -------------------------------------------------------------------------- */
/* Envelope 构建                                                               */
/* -------------------------------------------------------------------------- */

/** 把 {name: value} 递归序列化为 XML 元素；@ 前缀键作为属性；数组→重复元素。 */
function valueToElements(name: string, value: unknown, indent: string): string {
  if (Array.isArray(value)) {
    return value.map((v) => valueToElements(name, v, indent)).join("");
  }
  if (value !== null && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    let attrs = "";
    let children = "";
    for (const [k, v] of Object.entries(rec)) {
      if (k.startsWith("@")) attrs += ` ${k.slice(1)}="${escapeXml(String(v ?? ""))}"`;
      else children += valueToElements(k, v, indent + "  ");
    }
    if (children === "") return `${indent}<${name}${attrs}/>\n`;
    return `${indent}<${name}${attrs}>\n${children}${indent}</${name}>\n`;
  }
  if (value === null || value === undefined) return `${indent}<${name}/>\n`;
  return `${indent}<${name}>${escapeXml(String(value))}</${name}>\n`;
}

function indentLines(str: string, pad: string): string {
  return String(str).split(/\r?\n/).map((line) => pad + line).join("\n");
}

/**
 * 构建格式良好的 SOAP Envelope（1.1 / 1.2）。
 * bodyXml 优先；否则按 parameters 生成方法元素。headerXml / WSSE 插入 Header。
 */
export function buildSoapEnvelope(spec: SoapEnvelopeSpec): string {
  const version: SoapVersion = spec.version || "1.1";
  const envNs = version === "1.2" ? ENV_NS_12 : ENV_NS_11;
  const p = "soap";

  let out = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  out += `<${p}:Envelope xmlns:${p}="${envNs}">\n`;

  const headerParts: string[] = [];
  if (spec.wsSecurity) {
    headerParts.push(buildWsseHeader(spec.username || "", spec.password || "", {
      passwordType: spec.passwordType,
      nonce: spec.nonce,
      created: spec.created,
    }));
  }
  if (spec.headerXml && spec.headerXml.trim() !== "") headerParts.push(spec.headerXml);
  if (headerParts.length > 0) {
    out += `  <${p}:Header>\n`;
    for (const part of headerParts) out += `    ${part}\n`;
    out += `  </${p}:Header>\n`;
  }

  out += `  <${p}:Body>\n`;
  if (spec.bodyXml !== undefined && spec.bodyXml !== null && String(spec.bodyXml).trim() !== "") {
    out += indentLines(String(spec.bodyXml), "    ") + "\n";
  } else {
    const params = spec.parameters;
    const opName = spec.operation;
    if (opName) {
      const nsAttr = spec.namespace ? ` xmlns="${escapeXml(spec.namespace)}"` : "";
      let attrs = "";
      let childXml = "";
      if (params && typeof params === "object") {
        for (const [k, v] of Object.entries(params)) {
          if (k.startsWith("@")) attrs += ` ${k.slice(1)}="${escapeXml(String(v ?? ""))}"`;
        }
        for (const [k, v] of Object.entries(params)) {
          if (k.startsWith("@")) continue;
          childXml += valueToElements(k, v, "      ");
        }
      }
      if (childXml === "") {
        out += `    <${opName}${nsAttr}${attrs}/>\n`;
      } else {
        out += `    <${opName}${nsAttr}${attrs}>\n${childXml}    </${opName}>\n`;
      }
    } else if (params && typeof params === "object") {
      for (const [k, v] of Object.entries(params)) {
        if (k.startsWith("@")) continue;
        out += valueToElements(k, v, "    ");
      }
    }
  }
  out += `  </${p}:Body>\n`;
  out += `</${p}:Envelope>`;
  return out;
}

/* -------------------------------------------------------------------------- */
/* Fault 解析                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 解析 SOAP Fault，兼容 1.1（faultcode/faultstring/detail）与
 * 1.2（Code/Value + Reason/Text + Detail）。非 Fault 返回 null。
 */
export function parseSoapFault(xml: string): { code: string; message: string; detail?: string } | null {
  const tree = parseXmlTree(xml);
  const fault = findDescendant(tree, "Fault");
  if (!fault) return null;

  const code = elementText(findDescendant(fault, "faultcode")) || elementText(findDescendant(fault, "Value"));
  const message = elementText(findDescendant(fault, "faultstring")) || elementText(findDescendant(fault, "Text"));
  const detailEl = findDescendant(fault, "detail") || findDescendant(fault, "Detail");

  const result: { code: string; message: string; detail?: string } = { code, message };
  if (detailEl) {
    const inner = (detailEl.children || []).map(rawXml).join("").trim();
    if (inner) result.detail = inner;
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* prettifyXml                                                                 */
/* -------------------------------------------------------------------------- */

function prettyNode(node: XmlNode, level: number): string {
  const pad = "  ".repeat(level);
  if (node.type === "element") {
    const open = `<${node.name}${node.rawAttrs ? " " + node.rawAttrs : ""}`;
    if (node.selfClose) return `${pad}${open}/>`;
    const kids = node.children || [];
    const hasElementChild = kids.some((c) => c.type === "element");
    const hasMeaningfulText = kids.some(
      (c) => (c.type === "text" && (c.text || "").trim() !== "") || c.type === "cdata",
    );
    // 简单内容 / 混合内容：原样内联，绝不往文本内容里插入空白。
    if (!hasElementChild || hasMeaningfulText) {
      const inner = kids.map(rawXml).join("");
      return `${pad}${open}>${inner}</${node.name}>`;
    }
    // 仅元素子节点：重新缩进，丢弃纯空白文本节点。
    const significant = kids.filter(
      (c) => c.type !== "text" || (c.text || "").trim() !== "",
    );
    const inner = significant.map((c) => prettyNode(c, level + 1)).join("\n");
    return `${pad}${open}>\n${inner}\n${pad}</${node.name}>`;
  }
  return pad + rawXml(node);
}

/** 轻量缩进格式化：不改动任何文本/属性内容，且不往文本节点内部注入空白。 */
export function prettifyXml(xml: string): string {
  const tree = parseXmlTree(xml);
  const parts: string[] = [];
  for (const child of tree.children || []) {
    if (child.type === "text" && (child.text || "").trim() === "") continue;
    parts.push(prettyNode(child, 0));
  }
  return parts.join("\n");
}

/* -------------------------------------------------------------------------- */
/* WSDL -> HTTP 请求草稿                                                        */
/* -------------------------------------------------------------------------- */

export function wsdlOperationsToRequests(
  info: WsdlInfo,
): Array<{
  name: string;
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
  soap: SoapOperation;
}> {
  return info.operations.map((op) => {
    const action = soapActionHeader(op);
    const headers: Record<string, string> = {};
    if (op.version === "1.2") {
      headers["Content-Type"] = action.value; // 1.2 的 action 拼进 Content-Type
    } else {
      headers["Content-Type"] = soapContentType(op.version);
      headers[action.key] = action.value;
    }
    return {
      name: op.name,
      url: op.endpoint || info.endpoint || "",
      method: "POST" as const,
      headers,
      body: buildSoapEnvelope({ version: op.version, operation: op.name, namespace: op.namespace }),
      soap: op,
    };
  });
}
