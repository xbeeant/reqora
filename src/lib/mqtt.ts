/**
 * MQTT 3.1.1 / 5.0 报文编解码核心（纯逻辑，零依赖）。
 *
 * 运行环境：浏览器 + Node 22，仅使用 Uint8Array / TextEncoder / TextDecoder。
 * 文件只使用可擦除的 TypeScript 语法，可被 Node 22 的原生 TS 剥离直接加载。
 *
 * 约定：decodeConnack / decodeSuback / decodePublish 的 `payload` 参数为「报文体」，
 * 即固定头 + 剩余长度之后的部分，与 MqttPacketParser 产出的 MqttPacket.payload 一致。
 *
 * 5.0 的 properties 均写成 0 长度（单个 0x00 字节），位置按约定：
 *   CONNECT     协议名 / level / flags / keepAlive / properties / 载荷
 *   PUBLISH     topic / properties / [packetId] / 载荷   （properties 在 topic 之后）
 *   SUBSCRIBE   properties / packetId / 订阅项          （properties 在 packetId 之前）
 *   UNSUBSCRIBE properties / packetId / topic filters   （与 SUBSCRIBE 一致）
 *   PUBACK      packetId / properties
 *   DISCONNECT  properties
 */

export type MqttVersion = "3.1.1" | "5";
export type MqttQos = 0 | 1 | 2;

export interface MqttConnectOptions {
  clientId: string;
  username?: string;
  password?: string;
  version?: MqttVersion;
  keepAliveSecs?: number;
  cleanSession?: boolean;
  will?: { topic: string; payload: string; qos?: MqttQos; retain?: boolean };
}

export interface MqttPacket {
  type: number;
  flags: number;
  payload: Uint8Array;
}

export const MQTT_CONTROL_TYPES: Record<string, number> = {
  CONNECT: 1,
  CONNACK: 2,
  PUBLISH: 3,
  PUBACK: 4,
  PUBREC: 5,
  PUBREL: 6,
  PUBCOMP: 7,
  SUBSCRIBE: 8,
  SUBACK: 9,
  UNSUBSCRIBE: 10,
  UNSUBACK: 11,
  PINGREQ: 12,
  PINGRESP: 13,
  DISCONNECT: 14,
};

const MAX_REMAINING_LENGTH = 268435455; // 0x7FFFFFFF 的 VBI 上限
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8");

/* ------------------------------------------------------------------ *
 * 基础字节工具
 * ------------------------------------------------------------------ */

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function assertUint16(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new RangeError(`${name} 必须是 0..65535 的整数`);
  }
}

function assertQos(qos: number): void {
  if (qos !== 0 && qos !== 1 && qos !== 2) {
    throw new RangeError("qos 必须为 0、1 或 2");
  }
}

/** 2 字节大端整数 */
function uint16(value: number): Uint8Array {
  assertUint16(value, "value");
  return new Uint8Array([(value >>> 8) & 0xff, value & 0xff]);
}

/** 2 字节长度前缀 + 二进制内容 */
function encodeBinary(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 0xffff) throw new RangeError("字段长度超过 65535");
  const out = new Uint8Array(2 + bytes.length);
  out[0] = (bytes.length >>> 8) & 0xff;
  out[1] = bytes.length & 0xff;
  out.set(bytes, 2);
  return out;
}

function payloadBytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? textEncoder.encode(value) : value;
}

function buildPacket(headerFlags: number, body: Uint8Array): Uint8Array {
  return concat([
    new Uint8Array([headerFlags & 0xff]),
    encodeRemainingLength(body.length),
    body,
  ]);
}

function readUint16(bytes: Uint8Array, offset: number): [number, number] {
  if (offset < 0 || offset + 2 > bytes.length) {
    throw new Error("2 字节整数越界");
  }
  return [(bytes[offset] << 8) | bytes[offset + 1], offset + 2];
}

function readUtf(bytes: Uint8Array, offset: number): [string, number] {
  const [length, start] = readUint16(bytes, offset);
  const end = start + length;
  if (end > bytes.length) throw new Error("UTF-8 字段越界");
  return [textDecoder.decode(bytes.subarray(start, end)), end];
}

/**
 * 读取 VBI：返回 [值, 下一个 offset]；数据不足时返回 null（增量解析用），
 * 只在真正畸形（超过 4 字节）时抛错。
 */
function readRemainingLength(bytes: Uint8Array, offset: number): [number, number] | null {
  let multiplier = 1;
  let value = 0;
  let cursor = offset;
  let consumed = 0;
  while (true) {
    if (cursor >= bytes.length) return null;
    if (consumed >= 4) throw new Error("Malformed remaining length: 超过 4 字节");
    const digit = bytes[cursor];
    value += (digit & 0x7f) * multiplier;
    consumed++;
    cursor++;
    if ((digit & 0x80) === 0) break;
    multiplier *= 128;
  }
  if (value > MAX_REMAINING_LENGTH) {
    throw new Error("Malformed remaining length: 数值越界");
  }
  return [value, cursor];
}

/* ------------------------------------------------------------------ *
 * 剩余长度 / UTF-8 字段
 * ------------------------------------------------------------------ */

export function encodeRemainingLength(length: number): Uint8Array {
  if (!Number.isInteger(length) || length < 0 || length > MAX_REMAINING_LENGTH) {
    throw new RangeError(`remaining length 非法: ${length}`);
  }
  const digits: number[] = [];
  let n = length;
  do {
    let digit = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) digit |= 0x80;
    digits.push(digit);
  } while (n > 0);
  return new Uint8Array(digits);
}

export function decodeRemainingLength(bytes: Uint8Array, offset = 0): [number, number] {
  if (!Number.isInteger(offset) || offset < 0 || offset >= bytes.length) {
    throw new RangeError("offset 越界");
  }
  const result = readRemainingLength(bytes, offset);
  if (result === null) throw new Error("Incomplete remaining length");
  return result;
}

export function encodeUtf(value: string): Uint8Array {
  return encodeBinary(textEncoder.encode(value));
}

/* ------------------------------------------------------------------ *
 * CONNECT / CONNACK
 * ------------------------------------------------------------------ */

export function encodeConnect(o: MqttConnectOptions): Uint8Array {
  const version: MqttVersion = o.version ?? "3.1.1";
  const keepAlive = o.keepAliveSecs ?? 60;
  assertUint16(keepAlive, "keepAliveSecs");
  const will = o.will;
  const hasWill = will !== undefined;
  const willQos = hasWill ? (will?.qos ?? 0) : 0;
  if (hasWill) assertQos(willQos);

  let flags = 0;
  if (o.username !== undefined) flags |= 0x80;
  if (o.password !== undefined) flags |= 0x40;
  if (hasWill) {
    flags |= 0x04;
    if (will?.retain) flags |= 0x20;
    flags |= willQos << 3;
  }
  if (o.cleanSession ?? true) flags |= 0x02;

  const parts: Uint8Array[] = [
    encodeUtf("MQTT"),
    new Uint8Array([version === "5" ? 5 : 4]),
    new Uint8Array([flags]),
    uint16(keepAlive),
  ];
  if (version === "5") parts.push(new Uint8Array([0])); // properties length = 0

  parts.push(encodeUtf(o.clientId));
  if (will) {
    parts.push(encodeUtf(will.topic));
    parts.push(encodeBinary(textEncoder.encode(will.payload)));
  }
  if (o.username !== undefined) parts.push(encodeUtf(o.username));
  if (o.password !== undefined) parts.push(encodeBinary(textEncoder.encode(o.password)));

  return buildPacket(0x10, concat(parts));
}

export function decodeConnack(
  payload: Uint8Array,
  version: MqttVersion = "3.1.1",
): { sessionPresent: boolean; returnCode: number; reasonCode?: number } {
  if (payload.length < 2) throw new Error("CONNACK 报文体过短");
  const sessionPresent = (payload[0] & 0x01) !== 0;
  const code = payload[1];
  if (version === "5") {
    // 5.0 第二字节是 Reason Code；其后是 properties（本核心不需要解析其内容）。
    return { sessionPresent, returnCode: code, reasonCode: code };
  }
  return { sessionPresent, returnCode: code };
}

/* ------------------------------------------------------------------ *
 * SUBSCRIBE / UNSUBSCRIBE / SUBACK
 * ------------------------------------------------------------------ */

export function encodeSubscribe(
  packetId: number,
  topics: Array<{ topic: string; qos: MqttQos }>,
  version: MqttVersion = "3.1.1",
): Uint8Array {
  const parts: Uint8Array[] = [];
  if (version === "5") parts.push(new Uint8Array([0])); // properties length = 0（packetId 之前）
  parts.push(uint16(packetId));
  for (const entry of topics) {
    assertQos(entry.qos);
    parts.push(encodeUtf(entry.topic));
    parts.push(new Uint8Array([entry.qos & 0x03])); // Subscription Options
  }
  return buildPacket(0x82, concat(parts));
}

export function encodeUnsubscribe(
  packetId: number,
  topics: string[],
  version: MqttVersion = "3.1.1",
): Uint8Array {
  const parts: Uint8Array[] = [];
  if (version === "5") parts.push(new Uint8Array([0])); // properties length = 0（packetId 之前）
  parts.push(uint16(packetId));
  for (const topic of topics) parts.push(encodeUtf(topic));
  return buildPacket(0xa2, concat(parts));
}

export function decodeSuback(payload: Uint8Array, version: MqttVersion = "3.1.1"): number[] {
  if (payload.length < 2) throw new Error("SUBACK 报文体过短");
  let offset = 2; // 跳过 packet identifier
  if (version === "5") {
    const [propertiesLength, next] = decodeRemainingLength(payload, offset);
    offset = next + propertiesLength;
    if (offset > payload.length) throw new Error("SUBACK properties 越界");
  }
  return Array.from(payload.subarray(offset));
}

/* ------------------------------------------------------------------ *
 * PUBLISH / PUBACK
 * ------------------------------------------------------------------ */

export function encodePublish(o: {
  topic: string;
  payload: string | Uint8Array;
  qos?: MqttQos;
  retain?: boolean;
  dup?: boolean;
  packetId?: number;
  version?: MqttVersion;
}): Uint8Array {
  const qos = o.qos ?? 0;
  assertQos(qos);
  const version: MqttVersion = o.version ?? "3.1.1";

  let header = 0x30 | (qos << 1);
  if (o.dup) header |= 0x08;
  if (o.retain) header |= 0x01;

  const parts: Uint8Array[] = [encodeUtf(o.topic)];
  if (version === "5") parts.push(new Uint8Array([0])); // properties length = 0（topic 之后）
  if (qos > 0) parts.push(uint16(o.packetId ?? 1));
  parts.push(payloadBytes(o.payload));

  return buildPacket(header, concat(parts));
}

export function decodePublish(
  payload: Uint8Array,
  qos: MqttQos,
  version: MqttVersion = "3.1.1",
): { topic: string; payload: string; packetId?: number; propertiesLength?: number } {
  assertQos(qos);
  const [topic, afterTopic] = readUtf(payload, 0);
  let cursor = afterTopic;
  let propertiesLength: number | undefined;

  if (version === "5") {
    const [length, next] = decodeRemainingLength(payload, cursor);
    propertiesLength = length;
    cursor = next + length;
    if (cursor > payload.length) throw new Error("PUBLISH properties 越界");
  }

  let packetId: number | undefined;
  if (qos > 0) {
    const [id, next] = readUint16(payload, cursor);
    packetId = id;
    cursor = next;
  }

  const result: {
    topic: string;
    payload: string;
    packetId?: number;
    propertiesLength?: number;
  } = { topic, payload: textDecoder.decode(payload.subarray(cursor)) };
  if (packetId !== undefined) result.packetId = packetId;
  if (propertiesLength !== undefined) result.propertiesLength = propertiesLength;
  return result;
}

export function encodePuback(packetId: number, version: MqttVersion = "3.1.1"): Uint8Array {
  const parts: Uint8Array[] = [uint16(packetId)];
  if (version === "5") parts.push(new Uint8Array([0])); // properties length = 0
  return buildPacket(0x40, concat(parts));
}

/* ------------------------------------------------------------------ *
 * PINGREQ / DISCONNECT
 * ------------------------------------------------------------------ */

export function encodePingreq(): Uint8Array {
  return new Uint8Array([0xc0, 0x00]);
}

export function encodeDisconnect(version: MqttVersion = "3.1.1"): Uint8Array {
  return version === "5"
    ? new Uint8Array([0xe0, 0x01, 0x00]) // properties length = 0
    : new Uint8Array([0xe0, 0x00]);
}

/* ------------------------------------------------------------------ *
 * Topic 通配匹配
 * ------------------------------------------------------------------ */

export function topicMatches(filter: string, topic: string): boolean {
  if (typeof filter !== "string" || typeof topic !== "string" || filter.length === 0) {
    return false;
  }
  const filterLevels = filter.split("/");
  const topicLevels = topic.split("/");

  // 校验通配符合法性：# 必须独占最后一层，+ 必须独占一层。
  for (let i = 0; i < filterLevels.length; i++) {
    const level = filterLevels[i];
    if (level.indexOf("#") !== -1) {
      if (level !== "#" || i !== filterLevels.length - 1) return false;
    }
    if (level.indexOf("+") !== -1 && level !== "+") return false;
  }

  // $ 开头的系统主题不能被以通配符开头的过滤器匹配。
  if (topic.startsWith("$") && (filterLevels[0] === "#" || filterLevels[0] === "+")) {
    return false;
  }

  let t = 0;
  for (let f = 0; f < filterLevels.length; f++) {
    const level = filterLevels[f];
    if (level === "#") return true; // 匹配剩余任意层（含 0 层）
    if (t >= topicLevels.length) return false;
    if (level !== "+" && level !== topicLevels[t]) return false;
    t++;
  }
  return t === topicLevels.length;
}

/* ------------------------------------------------------------------ *
 * URL 解析
 * ------------------------------------------------------------------ */

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseMqttUrl(url: string): {
  host: string;
  port: number;
  useTls: boolean;
  transport: "tcp" | "ws";
  path?: string;
  username?: string;
  password?: string;
} {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`无效的 MQTT URL: ${url}`);
  }

  const scheme = parsed.protocol.slice(0, -1).toLowerCase();
  let port: number;
  let useTls: boolean;
  let transport: "tcp" | "ws";
  switch (scheme) {
    case "mqtt":
      port = 1883;
      useTls = false;
      transport = "tcp";
      break;
    case "mqtts":
      port = 8883;
      useTls = true;
      transport = "tcp";
      break;
    case "ws":
      port = 80;
      useTls = false;
      transport = "ws";
      break;
    case "wss":
      port = 443;
      useTls = true;
      transport = "ws";
      break;
    default:
      throw new Error(`不支持的 MQTT URL scheme: ${scheme}`);
  }
  if (parsed.port !== "") port = Number(parsed.port);
  if (!parsed.hostname) throw new Error("MQTT URL 缺少主机");

  const result: {
    host: string;
    port: number;
    useTls: boolean;
    transport: "tcp" | "ws";
    path?: string;
    username?: string;
    password?: string;
  } = { host: parsed.hostname, port, useTls, transport };

  const path = parsed.pathname + parsed.search;
  if (transport === "ws" || path !== "") result.path = path || "/";
  if (parsed.username !== "") result.username = safeDecode(parsed.username);
  if (parsed.password !== "") result.password = safeDecode(parsed.password);
  // 密码仅作为可选字段返回，不做任何日志/打印。
  return result;
}

/* ------------------------------------------------------------------ *
 * 增量报文解析器
 * ------------------------------------------------------------------ */

export class MqttPacketParser {
  buffer: Uint8Array = new Uint8Array(0);

  push(bytes: Uint8Array): MqttPacket[] {
    if (bytes.length > 0) this.buffer = concat([this.buffer, bytes]);
    const packets: MqttPacket[] = [];

    while (this.buffer.length >= 2) {
      const head = readRemainingLength(this.buffer, 1);
      if (head === null) break; // 剩余长度还没收齐
      const [remainingLength, bodyStart] = head;
      const end = bodyStart + remainingLength;
      if (end > this.buffer.length) break; // 报文体还没收齐

      const first = this.buffer[0];
      packets.push({
        type: first >> 4,
        flags: first & 0x0f,
        payload: this.buffer.slice(bodyStart, end),
      });
      this.buffer = this.buffer.slice(end);
    }
    return packets;
  }
}
