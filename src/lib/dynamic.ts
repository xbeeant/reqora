/**
 * `{{$dynamic}}` request variables — built-in values evaluated at request
 * time, Mock.js-flavoured. Shared by the UI (template preview) and the CLI
 * (`bin/reqora.mjs`, where this is the authoritative substitution);
 * the desktop app's authoritative path is the mirrored Rust implementation
 * in `reqora-core/src/service/dynamic.rs`, which reuses the mock server's
 * generator. Both sides resolve the same token set; random values are of
 * course independent between the two.
 */
import { POSTMAN_DYNAMIC_VARIABLES, postmanValue } from "./dynamicPostman.ts";

export interface DynamicVariable {
  key: string;
  description: string;
  /** Postman reference section, shown as a hint in the autocomplete. */
  group?: string;
}

/**
 * Machine-readable catalogue backing the `{{` autocomplete in request
 * editors. Keep it in sync with the switch in `dynamicValue`. The Postman
 * catalogue is appended so built-ins stay first in an unfiltered menu.
 */
const BUILTIN_DYNAMIC_VARIABLES: readonly DynamicVariable[] = [
  { key: "$timestamp", description: "秒级 Unix 时间戳" },
  { key: "$timestampMs", description: "毫秒级 Unix 时间戳" },
  { key: "$isoDate", description: "ISO 8601 日期时间（UTC）" },
  { key: "$date", description: "YYYY-MM-DD" },
  { key: "$time", description: "HH:mm:ss" },
  { key: "$randomInt", description: "随机整数（默认 0–100）" },
  { key: "$randomInt(1,100)", description: "指定范围内的随机整数" },
  { key: "$randomFloat", description: "随机浮点数，两位小数" },
  { key: "$boolean", description: "true 或 false" },
  { key: "$string", description: "随机字母串（默认 8 位）" },
  { key: "$cname", description: "随机中文姓名" },
  { key: "$name", description: "随机英文姓名" },
  { key: "$email", description: "随机邮箱" },
  { key: "$phone", description: "随机手机号" },
  { key: "$idCard", description: "随机身份证号" },
  { key: "$ip", description: "随机 IPv4 地址" },
  { key: "$url", description: "随机 URL" },
  { key: "$guid", description: "随机 UUID v4" },
  { key: "$uuid", description: "随机 UUID v4（$guid 别名）" },
  { key: "$province", description: "随机省级行政区" },
  { key: "$city", description: "随机城市" },
  { key: "$ctitle", description: "随机中文标题" },
  { key: "$cparagraph", description: "随机中文段落" },
];

export const DYNAMIC_VARIABLES: readonly DynamicVariable[] = [
  ...BUILTIN_DYNAMIC_VARIABLES,
  ...POSTMAN_DYNAMIC_VARIABLES.map((item) => ({
    key: item.key,
    description: item.description,
    group: item.group,
  })),
];

/** Token names may include digits (`$randomIPV6`) and an optional `(args)`. */
const PATTERN = /^([a-zA-Z][a-zA-Z0-9_]*)(?:\(([^)]*)\))?$/;

/** Dependency-free xorshift* PRNG seeded from crypto randomness. */
export class Prng {
  private state: bigint;

  constructor() {
    const words = new Uint32Array(2);
    globalThis.crypto.getRandomValues(words);
    const seed = (BigInt(words[0]) << 32n) | BigInt(words[1]);
    this.state = seed | 1n; // never zero: xorshift collapses to 0
  }

  nextU64(): bigint {
    let state = this.state;
    state ^= state << 13n;
    state ^= state >> 7n;
    state ^= state << 17n;
    this.state = state;
    return state;
  }

  /** Inclusive integer in `[min, max]`. */
  range(min: number, max: number): number {
    if (max <= min) return min;
    const span = BigInt(max - min + 1);
    return min + Number(this.nextU64() % span);
  }

  pick<T>(items: readonly T[]): T {
    return items[this.range(0, items.length - 1)];
  }

  digits(count: number): string {
    let out = "";
    for (let i = 0; i < count; i += 1) out += this.range(0, 9);
    return out;
  }
}

const SURNAMES = ["赵", "钱", "孙", "李", "周", "吴", "郑", "王", "冯", "陈", "蒋", "沈", "韩", "杨", "刘", "林", "徐", "黄", "高", "谢"];
const GIVEN_NAMES = ["伟", "芳", "娜", "敏", "静", "磊", "军", "洋", "勇", "杰", "涛", "明", "超", "雪", "晨", "浩", "宇", "欣怡", "子轩", "一诺"];
const EN_FIRST = ["James", "Mary", "John", "Patricia", "Robert", "Jennifer", "Michael", "Linda", "David", "Elizabeth", "William", "Susan", "Thomas", "Sarah"];
const EN_LAST = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Wilson", "Anderson", "Taylor", "Moore", "Martin", "Lee"];
const EMAIL_DOMAINS = ["example.com", "example.org", "test.com", "demo.cn", "mock.io"];
const ID_AREAS = ["110101", "310104", "440305", "330102", "320105", "510107", "420106", "371002", "350203", "610103"];
const URL_SUBDOMAINS = ["api", "www", "cdn", "app", "demo"];
const URL_TLDS = ["com", "cn", "org", "io", "net"];
const URL_PATHS = ["users", "posts", "orders", "items", "api/v1/data", "profile", "articles", "search"];
const PROVINCES = ["北京市", "上海市", "广东省", "浙江省", "江苏省", "四川省", "湖北省", "湖南省", "山东省", "河南省", "福建省", "陕西省"];
const CITIES = ["北京市", "上海市", "广州市", "深圳市", "杭州市", "成都市", "武汉市", "南京市", "西安市", "重庆市", "苏州市", "厦门市", "长沙市", "青岛市", "郑州市"];
const C_WORDS = ["数据", "接口", "平台", "系统", "设计", "开发", "测试", "管理", "服务", "架构", "性能", "安全", "智能", "云端", "网络", "分析", "优化", "实践", "指南", "入门"];
const C_SENTENCES = ["这是一个用于测试的句子。", "接口返回了预期的数据结构。", "系统在高并发下依然保持稳定。", "我们使用自动化测试保障质量。", "这份文档描述了服务的核心能力。", "数据同步任务在凌晨按时完成。"];

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

function formatDate(now: Date, separator: string): string {
  return [pad(now.getFullYear(), 4), pad(now.getMonth() + 1), pad(now.getDate())].join(separator);
}

function formatTime(now: Date): string {
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function idcard(rng: Prng): string {
  const base = `${rng.pick(ID_AREAS)}${pad(rng.range(1960, 2005), 4)}${pad(rng.range(1, 12))}${pad(rng.range(1, 28))}${rng.digits(3)}`;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checksum = "10X98765432";
  const sum = [...base].reduce((total, digit, index) => total + Number(digit) * weights[index], 0);
  return `${base}${checksum[sum % 11]}`;
}

function evalToken(name: string, args: string | undefined, rng: Prng): string | null {
  const numbers = () => (args ?? "").split(",").map((part) => Number.parseInt(part.trim(), 10)).filter(Number.isFinite);
  const range = (fallbackMin: number, fallbackMax: number): [number, number] => {
    const [min, max] = numbers();
    if (Number.isFinite(min) && Number.isFinite(max)) return [min, max];
    if (Number.isFinite(min)) return [min, min];
    return [fallbackMin, fallbackMax];
  };
  switch (name) {
    case "cname":
      return rng.pick(SURNAMES) + rng.pick(GIVEN_NAMES);
    case "name":
      return `${rng.pick(EN_FIRST)} ${rng.pick(EN_LAST)}`;
    case "email":
      return `${rng.pick(EN_FIRST).toLowerCase()}.${rng.pick(EN_LAST).toLowerCase()}@${rng.pick(EMAIL_DOMAINS)}`;
    case "phone":
      return `1${rng.pick(["3", "4", "5", "6", "7", "8", "9"])}${rng.digits(9)}`;
    case "idCard":
      return idcard(rng);
    case "randomInt":
    case "integer": {
      const [min, max] = range(0, 100);
      return String(rng.range(min, max));
    }
    case "randomFloat":
    case "float": {
      const [min, max] = range(0, 100);
      // Two decimal places: scale the range so @float(0,100) spans 0.00–100.00.
      const scaled = min * 100 + rng.range(0, Math.max(0, max - min) * 100);
      return (scaled / 100).toFixed(2);
    }
    case "boolean":
      return rng.range(0, 1) === 1 ? "true" : "false";
    case "guid":
    case "uuid": {
      const hex = "0123456789abcdef";
      let out = "";
      for (let i = 0; i < 36; i += 1) {
        if (i === 8 || i === 13 || i === 18 || i === 23) out += "-";
        else if (i === 14) out += "4";
        else if (i === 19) out += rng.pick(["8", "9", "a", "b"]);
        else out += hex[rng.range(0, 15)];
      }
      return out;
    }
    case "url":
      return `https://${rng.pick(URL_SUBDOMAINS)}.${rng.pick(EN_LAST).toLowerCase()}.${rng.pick(URL_TLDS)}/${rng.pick(URL_PATHS)}`;
    case "ip":
      return `${rng.range(1, 255)}.${rng.range(0, 255)}.${rng.range(0, 255)}.${rng.range(1, 254)}`;
    case "province":
      return rng.pick(PROVINCES);
    case "city":
      return rng.pick(CITIES);
    case "ctitle": {
      const [min, max] = range(2, 4);
      const count = Math.min(8, Math.max(1, rng.range(min, max)));
      let title = "";
      for (let i = 0; i < count; i += 1) title += rng.pick(C_WORDS);
      return title;
    }
    case "cparagraph": {
      const [min, max] = range(1, 3);
      const count = Math.min(6, Math.max(1, rng.range(min, max)));
      const sentences: string[] = [];
      for (let i = 0; i < count; i += 1) sentences.push(rng.pick(C_SENTENCES).replace(/。$/, ""));
      return `${sentences.join("。")}。`;
    }
    case "string": {
      const count = Math.min(64, Math.max(1, numbers()[0] ?? 8));
      const letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
      let out = "";
      for (let i = 0; i < count; i += 1) out += letters[rng.range(0, letters.length - 1)];
      return out;
    }
    default:
      return null;
  }
}

/**
 * Resolve one placeholder key. Returns `null` when the key is not a dynamic
 * variable (plain variables are the caller's business) or the token is
 * unknown — unknown `$tokens` are kept verbatim, never reported missing.
 */
export function dynamicValue(key: string, rng: Prng = new Prng()): string | null {
  if (!key.startsWith("$")) return null;
  const match = key.slice(1).match(PATTERN);
  if (!match) return null;
  const [, name, args] = match;
  const now = new Date();
  switch (name) {
    case "timestamp":
      return String(Math.floor(now.getTime() / 1000));
    case "timestampMs":
      return String(now.getTime());
    case "isoDate":
    case "isoTimestamp":
      return `${formatDate(now, "-")}T${formatTime(now)}Z`;
    case "date":
      return formatDate(now, "-");
    case "time":
      return formatTime(now);
    default: {
      const canonical = name === "uuid" ? "guid" : name;
      return evalToken(canonical, args, rng) ?? postmanValue(name, args, rng);
    }
  }
}
