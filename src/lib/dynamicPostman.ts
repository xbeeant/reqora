/**
 * Postman-style `{{$randomXxx}}` request variables.
 *
 * The catalogue below mirrors the "Dynamic variables" reference in Postman's
 * documentation (Common / Text, numbers and colors / Internet and IP / … /
 * Lorem ipsum). It is deliberately kept separate from the Mock.js-flavoured
 * built-ins in `dynamic.ts`: those predate this list and keep their original
 * semantics (notably `$timestamp` = seconds, whereas Postman's is ms).
 *
 * `postmanValue` is called by `dynamicValue` only after the built-in
 * generator declined a token, so the two namespaces can never shadow each
 * other. The desktop app has a mirror in
 * `src-tauri/crates/reqora-core/src/service/postman.rs`; both sides resolve
 * the same token set, random draws are independent.
 */
import type { Prng } from "./dynamic.ts";

export interface PostmanVariable {
  /** Full token, including the leading `$`. */
  key: string;
  /** One-line Chinese explanation shown in the `{{` autocomplete. */
  description: string;
  /** Reference section in Postman's documentation. */
  group: string;
}

/** Word lists shared by the simple `pick` tokens and the composite ones. */
const WORDS = {
  colors: ["red", "fuchsia", "grey", "green", "blue", "orange", "purple", "yellow", "cyan", "magenta", "teal", "silver", "maroon", "olive", "navy", "lime", "aqua", "white", "black"],
  abbreviations: ["SQL", "PCI", "JSON", "REST", "API", "HTTP", "HTTPS", "XML", "HTML", "CSS", "SDK", "CLI", "CRUD", "ORM", "JWT", "OAuth", "URL", "URI", "TCP", "UDP", "DNS", "TLS", "SSH", "CSV", "YAML"],
  protocols: ["http", "https"],
  locales: ["ny", "sr", "si", "en", "zh", "fr", "de", "es", "ja", "ko", "ru", "pt", "it", "ar", "hi", "nl", "sv", "tr", "pl", "cs"],
  userAgents: ["Mozilla/5.0 (Macintosh; U; Intel Mac OS X 10.9.8; rv:15.6) Gecko/20100101 Firefox/15.6.6", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 Version/17.2 Mobile/15E148 Safari/604.1", "Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0", "PostmanRuntime/7.36.0"],
  firstNames: ["Ethan", "Chandler", "Megane", "James", "Mary", "John", "Patricia", "Robert", "Jennifer", "Michael", "Linda", "David", "Elizabeth", "William", "Susan", "Thomas", "Sarah", "Pablo", "Ruthe", "Talon"],
  lastNames: ["Schaden", "Schneider", "Willms", "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Wilson", "Anderson", "Taylor", "Moore", "Martin", "Lee", "Kovacek", "Kassulke", "Gutkowski"],
  namePrefixes: ["Dr.", "Ms.", "Mr.", "Mrs.", "Prof."],
  nameSuffixes: ["I", "MD", "DDS", "Jr.", "II", "III", "PhD", "Sr."],
  jobAreas: ["Mobility", "Intranet", "Configuration", "Integration", "Infrastructure", "Marketing", "Operations", "Security", "Analytics", "Compliance"],
  jobDescriptors: ["Forward", "Corporate", "Senior", "Lead", "Principal", "Dynamic", "Global", "Chief", "Regional", "Strategic"],
  jobTypes: ["Supervisor", "Manager", "Coordinator", "Engineer", "Architect", "Specialist", "Director", "Consultant", "Analyst", "Liaison"],
  cities: ["Spinkahaven", "Korbinburgh", "Lefflerport", "Kuhicburgh", "West Alan", "New Kaitlin", "Port Kieran", "Lake Alfonzo", "East Jadyn", "Schadenstad"],
  streetSuffixes: ["Street", "Avenue", "Island", "Springs", "Orchard", "Road", "Lane", "Boulevard", "Court", "Drive", "Terrace", "Place"],
  countries: ["Lao People's Democratic Republic", "Kazakhstan", "Austria", "Canada", "Japan", "Brazil", "France", "Germany", "India", "Kenya", "Mexico", "Norway", "Portugal", "Singapore", "Spain", "Switzerland", "Thailand", "Vietnam", "China", "United Kingdom"],
  countryCodes: ["CV", "MD", "TD", "US", "CN", "JP", "DE", "FR", "GB", "BR", "IN", "CA", "AU", "KR", "SG", "NL", "SE", "NO", "CH", "ZA"],
  bankAccountNames: ["Home Loan Account", "Checking Account", "Savings Account", "Auto Loan Account", "Personal Loan Account", "Credit Card Account", "Investment Account", "Money Market Account"],
  transactionTypes: ["invoice", "payment", "deposit", "withdrawal", "transfer", "refund", "chargeback"],
  currencyCodes: ["CDF", "ZMK", "GNF", "USD", "CNY", "EUR", "GBP", "JPY", "CHF", "AUD", "CAD", "INR", "KRW", "SGD", "BRL"],
  currencyNames: ["CFP Franc", "Cordoba Oro", "Pound Sterling", "US Dollar", "Chinese Yuan", "Euro", "Japanese Yen", "Swiss Franc", "Australian Dollar", "Indian Rupee"],
  currencySymbols: ["$", "£", "€", "¥", "₹", "₩", "₽", "R$"],
  companySuffixes: ["Inc", "LLC", "Group", "Ltd", "PLC", "and Sons", "Partners"],
  bsAdjectives: ["viral", "24/7", "24/365", "seamless", "holistic", "proactive", "scalable", "robust", "agile", "frictionless"],
  bsBuzzes: ["repurpose", "harness", "transition", "leverage", "syndicate", "monetize", "optimize", "streamline", "orchestrate", "unlock"],
  bsNouns: ["e-services", "markets", "interfaces", "paradigms", "synergies", "platforms", "channels", "ecosystems", "initiatives", "frameworks"],
  catchPhraseAdjectives: ["Self-enabling", "Business-focused", "Down-sized", "Progressive", "Intuitive", "Visionary", "Adaptive", "Distributed", "Automated"],
  catchPhraseDescriptors: ["bandwidth-monitored", "needs-based", "homogeneous", "user-centric", "fault-tolerant", "real-time", "cloud-native", "multi-layered", "open-source"],
  catchPhraseNouns: ["secured line", "superstructure", "installation", "architecture", "interface", "pipeline", "matrix", "gateway", "workflow"],
  databaseColumns: ["updatedAt", "token", "group", "id", "createdAt", "email", "status", "name", "ownerId", "deletedAt", "version"],
  databaseTypes: ["tinyint", "text", "int", "varchar", "bigint", "boolean", "decimal", "timestamp", "json", "blob"],
  databaseCollations: ["cp1250_bin", "utf8_general_ci", "cp1250_general_ci", "utf8mb4_unicode_ci", "latin1_swedish_ci", "utf8_bin"],
  databaseEngines: ["MyISAM", "InnoDB", "Memory", "CSV", "Archive"],
  weekdays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
  months: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
  domainSuffixes: ["org", "net", "com", "io", "dev", "cn", "co", "app"],
  emailDomains: ["gmail.com", "hotmail.com", "yahoo.com", "outlook.com", "icloud.com", "proton.me"],
  exampleEmailDomains: ["example.com", "example.net", "example.org"],
  fileTypes: ["model", "application", "video", "audio", "image", "text", "font", "message"],
  fileExts: ["war", "book", "fsc", "gdoc", "mpg4", "odt", "key", "bin", "dmg", "iso"],
  commonFileTypes: ["application", "audio", "video", "image", "text"],
  commonFileExts: ["m2v", "wav", "png", "jpg", "pdf", "mp4", "zip", "gif", "csv", "txt"],
  directoryPaths: ["/usr/bin", "/root", "/usr/local/bin", "/home", "/var/log", "/etc", "/opt/app", "/tmp"],
  mimeTypes: ["audio/vnd.vmx.cvsd", "application/json", "text/plain", "image/png", "application/pdf", "video/mp4", "text/csv", "application/zip"],
  products: ["Towels", "Pizza", "Pants", "Chair", "Bacon", "Mouse", "Hat", "Soap", "Lamp", "Ball"],
  productAdjectives: ["Unbranded", "Incredible", "Tasty", "Handmade", "Refined", "Ergonomic", "Durable", "Compact", "Organic", "Rustic"],
  productMaterials: ["Steel", "Plastic", "Frozen", "Concrete", "Cotton", "Wood", "Rubber", "Glass", "Leather", "Ceramic"],
  departments: ["Tools", "Movies", "Electronics", "Books", "Home", "Garden", "Sports", "Toys", "Beauty", "Grocery"],
  nouns: ["matrix", "bus", "bandwidth", "monitor", "program", "interface", "mobile", "XML", "array", "protocol", "server", "schema", "client", "cache"],
  verbs: ["parse", "quantify", "navigate", "program", "monitor", "synthesize", "generate", "compress", "index", "deploy", "validate", "serialize"],
  ingverbs: ["synthesizing", "navigating", "backing up", "quantifying", "parsing", "monitoring", "generating", "compressing", "indexing", "deploying"],
  adjectives: ["auxiliary", "multi-byte", "back-end", "digital", "distributed", "virtual", "wireless", "dynamic", "primary", "redundant"],
  words: ["withdrawal", "infrastructures", "IB", "Samoa", "Synergistic", "sticky", "copying", "Grocery", "Corporate", "Springs", "Christmas", "Island", "Ghana", "Quality", "protocol", "workflow", "cluster", "endpoint"],
  lorem: ["lorem", "ipsum", "dolor", "sit", "amet", "consectetur", "adipiscing", "elit", "sed", "do", "eiusmod", "tempor", "incididunt", "ut", "labore", "et", "dolore", "magna", "aliqua", "enim", "ad", "minim", "veniam", "quis", "nostrud", "exercitation", "ullamco", "laboris", "nisi", "aliquip", "ex", "ea", "commodo", "consequat", "duis", "aute", "irure", "in", "reprehenderit", "voluptate", "velit", "esse", "cillum", "eu", "fugiat", "nulla", "pariatur", "excepteur", "sint", "occaecat", "cupidatat", "non", "proident", "sunt", "culpa", "qui", "officia", "deserunt", "mollit", "anim", "id", "est", "laborum"],
} as const;

type WordKey = keyof typeof WORDS;

/** Tokens that are just one random entry from a word list. */
const PICKS: Record<string, WordKey> = {
  randomColor: "colors",
  randomAbbreviation: "abbreviations",
  randomProtocol: "protocols",
  randomLocale: "locales",
  randomUserAgent: "userAgents",
  randomFirstName: "firstNames",
  randomLastName: "lastNames",
  randomNamePrefix: "namePrefixes",
  randomNameSuffix: "nameSuffixes",
  randomJobArea: "jobAreas",
  randomJobDescriptor: "jobDescriptors",
  randomJobType: "jobTypes",
  randomCity: "cities",
  randomCountry: "countries",
  randomCountryCode: "countryCodes",
  randomBankAccountName: "bankAccountNames",
  randomTransactionType: "transactionTypes",
  randomCurrencyCode: "currencyCodes",
  randomCurrencyName: "currencyNames",
  randomCurrencySymbol: "currencySymbols",
  randomCompanySuffix: "companySuffixes",
  randomBsAdjective: "bsAdjectives",
  randomBsBuzz: "bsBuzzes",
  randomBsNoun: "bsNouns",
  randomCatchPhraseAdjective: "catchPhraseAdjectives",
  randomCatchPhraseDescriptor: "catchPhraseDescriptors",
  randomCatchPhraseNoun: "catchPhraseNouns",
  randomDatabaseColumn: "databaseColumns",
  randomDatabaseType: "databaseTypes",
  randomDatabaseCollation: "databaseCollations",
  randomDatabaseEngine: "databaseEngines",
  randomWeekday: "weekdays",
  randomMonth: "months",
  randomDomainSuffix: "domainSuffixes",
  randomFileType: "fileTypes",
  randomFileExt: "fileExts",
  randomCommonFileType: "commonFileTypes",
  randomCommonFileExt: "commonFileExts",
  randomDirectoryPath: "directoryPaths",
  randomMimeType: "mimeTypes",
  randomProduct: "products",
  randomProductAdjective: "productAdjectives",
  randomProductMaterial: "productMaterials",
  randomDepartment: "departments",
  randomNoun: "nouns",
  randomVerb: "verbs",
  randomIngverb: "ingverbs",
  randomAdjective: "adjectives",
  randomWord: "words",
  randomLoremWord: "lorem",
};

/** `{{$randomXxxImage}}` → the category in the placeholder image URL. */
const IMAGE_CATEGORIES: Record<string, string> = {
  randomAbstractImage: "abstract",
  randomAnimalsImage: "animals",
  randomBusinessImage: "business",
  randomCatsImage: "cats",
  randomCityImage: "city",
  randomFoodImage: "food",
  randomNightlifeImage: "nightlife",
  randomFashionImage: "fashion",
  randomPeopleImage: "people",
  randomNatureImage: "nature",
  randomSportsImage: "sports",
  randomTransportImage: "transport",
};

function group(label: string, entries: readonly (readonly [string, string])[]): PostmanVariable[] {
  return entries.map(([key, description]) => ({ key: `$${key}`, description, group: label }));
}

/**
 * Catalogue backing the `{{` autocomplete. `$guid`, `$timestamp` and
 * `$randomInt` already live in `DYNAMIC_VARIABLES` and are intentionally
 * omitted here to avoid duplicate entries.
 */
export const POSTMAN_DYNAMIC_VARIABLES: readonly PostmanVariable[] = [
  ...group("通用", [
    ["isoTimestamp", "当前 UTC ISO 时间戳"],
    ["randomUUID", "随机 36 位 UUID"],
  ]),
  ...group("文本 / 数字 / 颜色", [
    ["randomAlphaNumeric", "随机字母或数字字符"],
    ["randomBoolean", "随机 true / false"],
    ["randomColor", "随机颜色名"],
    ["randomHexColor", "随机十六进制颜色值"],
    ["randomAbbreviation", "随机缩写（SQL、JSON…）"],
  ]),
  ...group("网络与 IP", [
    ["randomIP", "随机 IPv4 地址"],
    ["randomIPV6", "随机 IPv6 地址"],
    ["randomMACAddress", "随机 MAC 地址"],
    ["randomPassword", "随机 15 位字母数字密码"],
    ["randomLocale", "随机两位语言代码（ISO 639-1）"],
    ["randomUserAgent", "随机 User-Agent"],
    ["randomProtocol", "随机 http / https"],
    ["randomSemver", "随机语义化版本号"],
  ]),
  ...group("姓名", [
    ["randomFirstName", "随机英文名"],
    ["randomLastName", "随机英文姓"],
    ["randomFullName", "随机英文姓名"],
    ["randomNamePrefix", "随机姓名前缀（Dr.、Ms.…）"],
    ["randomNameSuffix", "随机姓名后缀（I、MD…）"],
  ]),
  ...group("职业", [
    ["randomJobArea", "随机工作领域"],
    ["randomJobDescriptor", "随机职位修饰词"],
    ["randomJobTitle", "随机职位名称"],
    ["randomJobType", "随机职位类型"],
  ]),
  ...group("电话 / 地址 / 位置", [
    ["randomPhoneNumber", "随机十位电话号码"],
    ["randomPhoneNumberExt", "随机带区号的电话号码"],
    ["randomCity", "随机城市名"],
    ["randomStreetName", "随机街道名"],
    ["randomStreetAddress", "随机街道地址"],
    ["randomCountry", "随机国家"],
    ["randomCountryCode", "随机两位国家代码（ISO 3166-1）"],
    ["randomLatitude", "随机纬度"],
    ["randomLongitude", "随机经度"],
  ]),
  ...group("图片", [
    ["randomAvatarImage", "随机头像 URL"],
    ["randomImageUrl", "随机图片 URL"],
    ["randomAbstractImage", "随机抽象图片 URL"],
    ["randomAnimalsImage", "随机动物图片 URL"],
    ["randomBusinessImage", "随机商务图片 URL"],
    ["randomCatsImage", "随机猫咪图片 URL"],
    ["randomCityImage", "随机城市图片 URL"],
    ["randomFoodImage", "随机食物图片 URL"],
    ["randomNightlifeImage", "随机夜景图片 URL"],
    ["randomFashionImage", "随机时尚图片 URL"],
    ["randomPeopleImage", "随机人物图片 URL"],
    ["randomNatureImage", "随机自然图片 URL"],
    ["randomSportsImage", "随机运动图片 URL"],
    ["randomTransportImage", "随机交通图片 URL"],
    ["randomImageDataUri", "随机图片 data URI"],
  ]),
  ...group("金融", [
    ["randomBankAccount", "随机 8 位银行账号"],
    ["randomBankAccountName", "随机银行账户名称"],
    ["randomCreditCardMask", "随机四位信用卡掩码"],
    ["randomBankAccountBic", "随机 BIC 银行识别码"],
    ["randomBankAccountIban", "随机 IBAN 国际银行账号"],
    ["randomTransactionType", "随机交易类型"],
    ["randomCurrencyCode", "随机三位货币代码（ISO 4217）"],
    ["randomCurrencyName", "随机货币名称"],
    ["randomCurrencySymbol", "随机货币符号"],
    ["randomBitcoin", "随机比特币地址"],
  ]),
  ...group("商业", [
    ["randomCompanyName", "随机公司名"],
    ["randomCompanySuffix", "随机公司后缀"],
    ["randomBs", "随机商业话术"],
    ["randomBsAdjective", "随机商业形容词"],
    ["randomBsBuzz", "随机商业流行词"],
    ["randomBsNoun", "随机商业名词"],
  ]),
  ...group("广告语", [
    ["randomCatchPhrase", "随机广告语"],
    ["randomCatchPhraseAdjective", "随机广告语形容词"],
    ["randomCatchPhraseDescriptor", "随机广告语描述词"],
    ["randomCatchPhraseNoun", "随机广告语名词"],
  ]),
  ...group("数据库", [
    ["randomDatabaseColumn", "随机数据库列名"],
    ["randomDatabaseType", "随机数据库字段类型"],
    ["randomDatabaseCollation", "随机数据库排序规则"],
    ["randomDatabaseEngine", "随机数据库引擎"],
  ]),
  ...group("日期", [
    ["randomDateFuture", "未来随机日期（ISO 8601）"],
    ["randomDatePast", "过去随机日期（ISO 8601）"],
    ["randomDateRecent", "近期随机日期（ISO 8601）"],
    ["randomWeekday", "随机星期"],
    ["randomMonth", "随机月份"],
  ]),
  ...group("域名 / 邮箱 / 用户名", [
    ["randomDomainName", "随机域名"],
    ["randomDomainSuffix", "随机域名后缀"],
    ["randomDomainWord", "随机域名主体"],
    ["randomEmail", "随机邮箱地址"],
    ["randomExampleEmail", "example 域名的随机邮箱"],
    ["randomUserName", "随机用户名"],
    ["randomUrl", "随机 URL"],
  ]),
  ...group("文件与目录", [
    ["randomFileName", "随机文件名"],
    ["randomFileType", "随机文件类型"],
    ["randomFileExt", "随机文件扩展名"],
    ["randomCommonFileName", "随机常见文件名"],
    ["randomCommonFileType", "随机常见文件类型"],
    ["randomCommonFileExt", "随机常见扩展名"],
    ["randomFilePath", "随机文件路径"],
    ["randomDirectoryPath", "随机目录路径"],
    ["randomMimeType", "随机 MIME 类型"],
  ]),
  ...group("零售", [
    ["randomPrice", "0.00–1000.00 随机价格"],
    ["randomProduct", "随机商品"],
    ["randomProductAdjective", "随机商品形容词"],
    ["randomProductMaterial", "随机商品材质"],
    ["randomProductName", "随机商品名称"],
    ["randomDepartment", "随机商品品类"],
  ]),
  ...group("语法", [
    ["randomNoun", "随机名词"],
    ["randomVerb", "随机动词"],
    ["randomIngverb", "随机动名词"],
    ["randomAdjective", "随机形容词"],
    ["randomWord", "随机单词"],
    ["randomWords", "若干随机单词"],
    ["randomPhrase", "随机短句"],
  ]),
  ...group("Lorem ipsum", [
    ["randomLoremWord", "随机 lorem 单词"],
    ["randomLoremWords", "若干 lorem 单词"],
    ["randomLoremSentence", "随机 lorem 句子"],
    ["randomLoremSentences", "2–6 句 lorem 文本"],
    ["randomLoremParagraph", "随机 lorem 段落"],
    ["randomLoremParagraphs", "3 段 lorem 文本"],
    ["randomLoremText", "随机长度 lorem 文本"],
    ["randomLoremSlug", "随机 lorem URL slug"],
    ["randomLoremLines", "1–5 行 lorem 文本"],
  ]),
];

const ALPHA = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ALNUM = `${ALPHA}0123456789`;
const HEX = "0123456789abcdef";

function chars(rng: Prng, pool: string, count: number): string {
  let out = "";
  for (let i = 0; i < count; i += 1) out += pool[rng.range(0, pool.length - 1)];
  return out;
}

function pick(rng: Prng, key: WordKey): string {
  return rng.pick(WORDS[key]);
}

function hexs(rng: Prng, count: number): string {
  return chars(rng, HEX, count);
}

/** Optional first numeric argument, clamped for safe output sizes. */
function argCount(args: string | undefined, fallback: number, max = 64): number {
  const parsed = Number.parseInt((args ?? "").split(",")[0]?.trim() ?? "", 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(1, parsed)) : fallback;
}

function loremSentence(rng: Prng): string {
  const count = rng.range(6, 12);
  const parts: string[] = [];
  for (let i = 0; i < count; i += 1) parts.push(pick(rng, "lorem"));
  const text = parts.join(" ");
  return `${text[0].toUpperCase()}${text.slice(1)}.`;
}

function loremParagraph(rng: Prng): string {
  const sentences: string[] = [];
  const count = rng.range(3, 6);
  for (let i = 0; i < count; i += 1) sentences.push(loremSentence(rng));
  return sentences.join(" ");
}

function shiftedIsoDate(rng: Prng, minDays: number, maxDays: number): string {
  return new Date(Date.now() + rng.range(minDays, maxDays) * 86_400_000).toISOString();
}

/** Resolve one Postman token. `null` when the token is not in the catalogue. */
export function postmanValue(name: string, args: string | undefined, rng: Prng): string | null {
  const list = PICKS[name];
  if (list) return pick(rng, list);

  const imageCategory = IMAGE_CATEGORIES[name];
  if (imageCategory) return `https://loremflickr.com/640/480/${imageCategory}?lock=${rng.digits(5)}`;

  switch (name) {
    case "randomUUID": {
      const uuid = `${hexs(rng, 8)}-${hexs(rng, 4)}-4${hexs(rng, 3)}-${rng.pick(["8", "9", "a", "b"])}${hexs(rng, 3)}-${hexs(rng, 12)}`;
      return uuid;
    }
    case "randomAlphaNumeric":
      return chars(rng, ALNUM, 1);
    case "randomBoolean":
      return rng.range(0, 1) === 1 ? "true" : "false";
    case "randomHexColor":
      return `#${hexs(rng, 6)}`;
    case "randomIP":
      return `${rng.range(1, 255)}.${rng.range(0, 255)}.${rng.range(0, 255)}.${rng.range(1, 254)}`;
    case "randomIPV6": {
      const parts: string[] = [];
      for (let i = 0; i < 8; i += 1) parts.push(hexs(rng, 4));
      return parts.join(":");
    }
    case "randomMACAddress": {
      const parts: string[] = [];
      for (let i = 0; i < 6; i += 1) parts.push(hexs(rng, 2));
      return parts.join(":");
    }
    case "randomPassword":
      return chars(rng, ALNUM, argCount(args, 15));
    case "randomSemver":
      return `${rng.range(0, 9)}.${rng.range(0, 20)}.${rng.range(0, 20)}`;
    case "randomFullName":
      return `${pick(rng, "firstNames")} ${pick(rng, "lastNames")}`;
    case "randomJobTitle":
      return `${pick(rng, "jobDescriptors")} ${pick(rng, "jobAreas")} ${pick(rng, "jobTypes")}`;
    case "randomPhoneNumber":
      return `${rng.digits(3)}-${rng.digits(3)}-${rng.digits(4)}`;
    case "randomPhoneNumberExt":
      return `${rng.digits(2)}-${rng.digits(3)}-${rng.digits(3)}-${rng.digits(4)}`;
    case "randomStreetName":
      return `${pick(rng, "lastNames")} ${pick(rng, "streetSuffixes")}`;
    case "randomStreetAddress":
      return `${rng.range(1, 99999)} ${pick(rng, "lastNames")} ${pick(rng, "streetSuffixes")}`;
    case "randomLatitude":
      return (rng.range(-900_000, 900_000) / 10_000).toFixed(4);
    case "randomLongitude":
      return (rng.range(-1_800_000, 1_800_000) / 10_000).toFixed(4);
    case "randomAvatarImage":
      return `https://avatars.githubusercontent.com/u/${rng.range(1, 99_999_999)}`;
    case "randomImageUrl":
      return `https://picsum.photos/640/480?random=${rng.digits(5)}`;
    case "randomImageDataUri":
      return `data:image/svg+xml;charset=UTF-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22${rng.range(16, 256)}%22%20height%3D%22${rng.range(16, 256)}%22%3E%3Crect%20width%3D%22100%25%22%20height%3D%22100%25%22%20fill%3D%22%23${hexs(rng, 6)}%22%2F%3E%3C%2Fsvg%3E`;
    case "randomBankAccount":
      return rng.digits(8);
    case "randomCreditCardMask":
      return rng.digits(4);
    case "randomBankAccountBic":
      return `${chars(rng, ALPHA.toUpperCase(), 7)}${rng.range(0, 9)}`;
    case "randomBankAccountIban":
      return `${chars(rng, ALPHA.toUpperCase(), 2)}${rng.digits(2)}${chars(rng, ALNUM.toUpperCase(), rng.range(15, 25))}`;
    case "randomBitcoin":
      return `3${chars(rng, ALNUM, 26)}`;
    case "randomCompanyName":
      return `${pick(rng, "lastNames")} ${rng.pick(["- " + pick(rng, "lastNames"), " " + pick(rng, "companySuffixes"), " and Sons"])}`;
    case "randomBs":
      return `${pick(rng, "bsAdjectives")} ${pick(rng, "bsBuzzes")} ${pick(rng, "bsNouns")}`;
    case "randomCatchPhrase":
      return `${pick(rng, "catchPhraseAdjectives")} ${pick(rng, "catchPhraseDescriptors")} ${pick(rng, "catchPhraseNouns")}`;
    case "randomDateFuture":
      return shiftedIsoDate(rng, 1, 365);
    case "randomDatePast":
      return shiftedIsoDate(rng, -365, -1);
    case "randomDateRecent":
      return shiftedIsoDate(rng, -30, 0);
    case "randomDomainName":
      return `${pick(rng, "lorem").toLowerCase()}.${pick(rng, "domainSuffixes")}`;
    case "randomDomainWord":
      return pick(rng, "lorem").toLowerCase();
    case "randomEmail":
      return `${pick(rng, "firstNames").toLowerCase()}${rng.range(1, 99)}@${pick(rng, "emailDomains")}`;
    case "randomExampleEmail":
      return `${pick(rng, "firstNames")}${rng.range(1, 99)}@${pick(rng, "exampleEmailDomains")}`;
    case "randomUserName":
      return `${pick(rng, "firstNames")}.${pick(rng, "lastNames")}${rng.range(1, 99)}`;
    case "randomUrl":
      return `https://${pick(rng, "lorem").toLowerCase()}.${pick(rng, "domainSuffixes")}`;
    case "randomFileName":
      return `${pick(rng, "lorem")}_${pick(rng, "lorem")}.${pick(rng, "fileExts")}`;
    case "randomCommonFileName":
      return `${pick(rng, "lorem")}.${pick(rng, "commonFileExts")}`;
    case "randomFilePath":
      return `${pick(rng, "directoryPaths")}/${pick(rng, "lorem")}.${pick(rng, "fileExts")}`;
    case "randomPrice":
      return (rng.range(0, 100_000) / 100).toFixed(2);
    case "randomProductName":
      return `${pick(rng, "productAdjectives")} ${pick(rng, "productMaterials")} ${pick(rng, "products")}`;
    case "randomWords": {
      const count = argCount(args, rng.range(2, 5), 16);
      const parts: string[] = [];
      for (let i = 0; i < count; i += 1) parts.push(pick(rng, "words"));
      return parts.join(" ");
    }
    case "randomPhrase":
      return `You can't ${pick(rng, "verbs")} the ${pick(rng, "nouns")} without ${pick(rng, "ingverbs")} the ${pick(rng, "adjectives")} ${pick(rng, "nouns")}!`;
    case "randomLoremWords": {
      const count = argCount(args, rng.range(2, 5), 16);
      const parts: string[] = [];
      for (let i = 0; i < count; i += 1) parts.push(pick(rng, "lorem"));
      return parts.join(" ");
    }
    case "randomLoremSentence":
      return loremSentence(rng);
    case "randomLoremSentences": {
      const count = rng.range(2, 6);
      const parts: string[] = [];
      for (let i = 0; i < count; i += 1) parts.push(loremSentence(rng));
      return parts.join(" ");
    }
    case "randomLoremParagraph":
      return loremParagraph(rng);
    case "randomLoremParagraphs": {
      const parts: string[] = [];
      for (let i = 0; i < 3; i += 1) parts.push(loremParagraph(rng));
      return parts.join("\n\n");
    }
    case "randomLoremText":
      return loremParagraph(rng);
    case "randomLoremSlug": {
      const parts: string[] = [];
      for (let i = 0; i < 3; i += 1) parts.push(pick(rng, "lorem"));
      return parts.join("-");
    }
    case "randomLoremLines": {
      const count = rng.range(1, 5);
      const parts: string[] = [];
      for (let i = 0; i < count; i += 1) parts.push(loremSentence(rng));
      return parts.join("\n");
    }
    default:
      return null;
  }
}
