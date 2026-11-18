//! Postman-style dynamic variables, mirroring src/lib/dynamicPostman.ts.
//! mock::eval_token forwards every token it does not know to eval(), so the
//! desktop app, the CLI and the UI preview resolve the same catalogue. Random
//! draws are independent between the JavaScript and Rust implementations.
//!
//! Word lists and the simple pick/image tables are kept byte-for-byte in sync
//! with `src/lib/dynamicPostman.ts`; `test/dynamic.test.mjs` fails if either
//! the token names or a word list drifts. Add new tokens on both sides.

use super::mock::{format_date, Prng, SmartVal};
use std::time::{SystemTime, UNIX_EPOCH};

const COLORS: &[&str] = &["red", "fuchsia", "grey", "green", "blue", "orange", "purple", "yellow", "cyan", "magenta", "teal", "silver", "maroon", "olive", "navy", "lime", "aqua", "white", "black"];
const ABBREVIATIONS: &[&str] = &["SQL", "PCI", "JSON", "REST", "API", "HTTP", "HTTPS", "XML", "HTML", "CSS", "SDK", "CLI", "CRUD", "ORM", "JWT", "OAuth", "URL", "URI", "TCP", "UDP", "DNS", "TLS", "SSH", "CSV", "YAML"];
const PROTOCOLS: &[&str] = &["http", "https"];
const LOCALES: &[&str] = &["ny", "sr", "si", "en", "zh", "fr", "de", "es", "ja", "ko", "ru", "pt", "it", "ar", "hi", "nl", "sv", "tr", "pl", "cs"];
const USER_AGENTS: &[&str] = &["Mozilla/5.0 (Macintosh; U; Intel Mac OS X 10.9.8; rv:15.6) Gecko/20100101 Firefox/15.6.6", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 Version/17.2 Mobile/15E148 Safari/604.1", "Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0", "PostmanRuntime/7.36.0"];
const FIRST_NAMES: &[&str] = &["Ethan", "Chandler", "Megane", "James", "Mary", "John", "Patricia", "Robert", "Jennifer", "Michael", "Linda", "David", "Elizabeth", "William", "Susan", "Thomas", "Sarah", "Pablo", "Ruthe", "Talon"];
const LAST_NAMES: &[&str] = &["Schaden", "Schneider", "Willms", "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Wilson", "Anderson", "Taylor", "Moore", "Martin", "Lee", "Kovacek", "Kassulke", "Gutkowski"];
const NAME_PREFIXES: &[&str] = &["Dr.", "Ms.", "Mr.", "Mrs.", "Prof."];
const NAME_SUFFIXES: &[&str] = &["I", "MD", "DDS", "Jr.", "II", "III", "PhD", "Sr."];
const JOB_AREAS: &[&str] = &["Mobility", "Intranet", "Configuration", "Integration", "Infrastructure", "Marketing", "Operations", "Security", "Analytics", "Compliance"];
const JOB_DESCRIPTORS: &[&str] = &["Forward", "Corporate", "Senior", "Lead", "Principal", "Dynamic", "Global", "Chief", "Regional", "Strategic"];
const JOB_TYPES: &[&str] = &["Supervisor", "Manager", "Coordinator", "Engineer", "Architect", "Specialist", "Director", "Consultant", "Analyst", "Liaison"];
const CITIES: &[&str] = &["Spinkahaven", "Korbinburgh", "Lefflerport", "Kuhicburgh", "West Alan", "New Kaitlin", "Port Kieran", "Lake Alfonzo", "East Jadyn", "Schadenstad"];
const STREET_SUFFIXES: &[&str] = &["Street", "Avenue", "Island", "Springs", "Orchard", "Road", "Lane", "Boulevard", "Court", "Drive", "Terrace", "Place"];
const COUNTRIES: &[&str] = &["Lao People's Democratic Republic", "Kazakhstan", "Austria", "Canada", "Japan", "Brazil", "France", "Germany", "India", "Kenya", "Mexico", "Norway", "Portugal", "Singapore", "Spain", "Switzerland", "Thailand", "Vietnam", "China", "United Kingdom"];
const COUNTRY_CODES: &[&str] = &["CV", "MD", "TD", "US", "CN", "JP", "DE", "FR", "GB", "BR", "IN", "CA", "AU", "KR", "SG", "NL", "SE", "NO", "CH", "ZA"];
const BANK_ACCOUNT_NAMES: &[&str] = &["Home Loan Account", "Checking Account", "Savings Account", "Auto Loan Account", "Personal Loan Account", "Credit Card Account", "Investment Account", "Money Market Account"];
const TRANSACTION_TYPES: &[&str] = &["invoice", "payment", "deposit", "withdrawal", "transfer", "refund", "chargeback"];
const CURRENCY_CODES: &[&str] = &["CDF", "ZMK", "GNF", "USD", "CNY", "EUR", "GBP", "JPY", "CHF", "AUD", "CAD", "INR", "KRW", "SGD", "BRL"];
const CURRENCY_NAMES: &[&str] = &["CFP Franc", "Cordoba Oro", "Pound Sterling", "US Dollar", "Chinese Yuan", "Euro", "Japanese Yen", "Swiss Franc", "Australian Dollar", "Indian Rupee"];
const CURRENCY_SYMBOLS: &[&str] = &["$", "£", "€", "¥", "₹", "₩", "₽", "R$"];
const COMPANY_SUFFIXES: &[&str] = &["Inc", "LLC", "Group", "Ltd", "PLC", "and Sons", "Partners"];
const BS_ADJECTIVES: &[&str] = &["viral", "24/7", "24/365", "seamless", "holistic", "proactive", "scalable", "robust", "agile", "frictionless"];
const BS_BUZZES: &[&str] = &["repurpose", "harness", "transition", "leverage", "syndicate", "monetize", "optimize", "streamline", "orchestrate", "unlock"];
const BS_NOUNS: &[&str] = &["e-services", "markets", "interfaces", "paradigms", "synergies", "platforms", "channels", "ecosystems", "initiatives", "frameworks"];
const CATCH_PHRASE_ADJECTIVES: &[&str] = &["Self-enabling", "Business-focused", "Down-sized", "Progressive", "Intuitive", "Visionary", "Adaptive", "Distributed", "Automated"];
const CATCH_PHRASE_DESCRIPTORS: &[&str] = &["bandwidth-monitored", "needs-based", "homogeneous", "user-centric", "fault-tolerant", "real-time", "cloud-native", "multi-layered", "open-source"];
const CATCH_PHRASE_NOUNS: &[&str] = &["secured line", "superstructure", "installation", "architecture", "interface", "pipeline", "matrix", "gateway", "workflow"];
const DATABASE_COLUMNS: &[&str] = &["updatedAt", "token", "group", "id", "createdAt", "email", "status", "name", "ownerId", "deletedAt", "version"];
const DATABASE_TYPES: &[&str] = &["tinyint", "text", "int", "varchar", "bigint", "boolean", "decimal", "timestamp", "json", "blob"];
const DATABASE_COLLATIONS: &[&str] = &["cp1250_bin", "utf8_general_ci", "cp1250_general_ci", "utf8mb4_unicode_ci", "latin1_swedish_ci", "utf8_bin"];
const DATABASE_ENGINES: &[&str] = &["MyISAM", "InnoDB", "Memory", "CSV", "Archive"];
const WEEKDAYS: &[&str] = &["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MONTHS: &[&str] = &["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DOMAIN_SUFFIXES: &[&str] = &["org", "net", "com", "io", "dev", "cn", "co", "app"];
const EMAIL_DOMAINS: &[&str] = &["gmail.com", "hotmail.com", "yahoo.com", "outlook.com", "icloud.com", "proton.me"];
const EXAMPLE_EMAIL_DOMAINS: &[&str] = &["example.com", "example.net", "example.org"];
const FILE_TYPES: &[&str] = &["model", "application", "video", "audio", "image", "text", "font", "message"];
const FILE_EXTS: &[&str] = &["war", "book", "fsc", "gdoc", "mpg4", "odt", "key", "bin", "dmg", "iso"];
const COMMON_FILE_TYPES: &[&str] = &["application", "audio", "video", "image", "text"];
const COMMON_FILE_EXTS: &[&str] = &["m2v", "wav", "png", "jpg", "pdf", "mp4", "zip", "gif", "csv", "txt"];
const DIRECTORY_PATHS: &[&str] = &["/usr/bin", "/root", "/usr/local/bin", "/home", "/var/log", "/etc", "/opt/app", "/tmp"];
const MIME_TYPES: &[&str] = &["audio/vnd.vmx.cvsd", "application/json", "text/plain", "image/png", "application/pdf", "video/mp4", "text/csv", "application/zip"];
const PRODUCTS: &[&str] = &["Towels", "Pizza", "Pants", "Chair", "Bacon", "Mouse", "Hat", "Soap", "Lamp", "Ball"];
const PRODUCT_ADJECTIVES: &[&str] = &["Unbranded", "Incredible", "Tasty", "Handmade", "Refined", "Ergonomic", "Durable", "Compact", "Organic", "Rustic"];
const PRODUCT_MATERIALS: &[&str] = &["Steel", "Plastic", "Frozen", "Concrete", "Cotton", "Wood", "Rubber", "Glass", "Leather", "Ceramic"];
const DEPARTMENTS: &[&str] = &["Tools", "Movies", "Electronics", "Books", "Home", "Garden", "Sports", "Toys", "Beauty", "Grocery"];
const NOUNS: &[&str] = &["matrix", "bus", "bandwidth", "monitor", "program", "interface", "mobile", "XML", "array", "protocol", "server", "schema", "client", "cache"];
const VERBS: &[&str] = &["parse", "quantify", "navigate", "program", "monitor", "synthesize", "generate", "compress", "index", "deploy", "validate", "serialize"];
const INGVERBS: &[&str] = &["synthesizing", "navigating", "backing up", "quantifying", "parsing", "monitoring", "generating", "compressing", "indexing", "deploying"];
const ADJECTIVES: &[&str] = &["auxiliary", "multi-byte", "back-end", "digital", "distributed", "virtual", "wireless", "dynamic", "primary", "redundant"];
const WORDS: &[&str] = &["withdrawal", "infrastructures", "IB", "Samoa", "Synergistic", "sticky", "copying", "Grocery", "Corporate", "Springs", "Christmas", "Island", "Ghana", "Quality", "protocol", "workflow", "cluster", "endpoint"];
const LOREM: &[&str] = &["lorem", "ipsum", "dolor", "sit", "amet", "consectetur", "adipiscing", "elit", "sed", "do", "eiusmod", "tempor", "incididunt", "ut", "labore", "et", "dolore", "magna", "aliqua", "enim", "ad", "minim", "veniam", "quis", "nostrud", "exercitation", "ullamco", "laboris", "nisi", "aliquip", "ex", "ea", "commodo", "consequat", "duis", "aute", "irure", "in", "reprehenderit", "voluptate", "velit", "esse", "cillum", "eu", "fugiat", "nulla", "pariatur", "excepteur", "sint", "occaecat", "cupidatat", "non", "proident", "sunt", "culpa", "qui", "officia", "deserunt", "mollit", "anim", "id", "est", "laborum"];

const ALNUM: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const UPPER: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const UPPER_ALNUM: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const HEX: &[u8] = b"0123456789abcdef";

fn pick_str(prng: &mut Prng, list: &'static [&'static str]) -> &'static str {
    *prng.pick(list)
}

fn chars(prng: &mut Prng, pool: &[u8], count: usize) -> String {
    (0..count)
        .map(|_| pool[prng.range(0, pool.len() as i64 - 1) as usize] as char)
        .collect()
}

fn hexs(prng: &mut Prng, count: usize) -> String {
    chars(prng, HEX, count)
}

/// Optional first numeric argument, clamped to a safe output size.
fn arg_count(args: Option<&str>, fallback: i64, max: i64) -> usize {
    let parsed = args
        .and_then(|text| text.split(',').next())
        .and_then(|part| part.trim().parse::<i64>().ok())
        .unwrap_or(fallback);
    parsed.clamp(1, max) as usize
}

fn lorem_sentence(prng: &mut Prng) -> String {
    let count = prng.range(6, 12) as usize;
    let mut parts = Vec::with_capacity(count);
    for _ in 0..count {
        parts.push(pick_str(prng, LOREM));
    }
    let text = parts.join(" ");
    let mut rest = text.chars();
    let first = rest
        .next()
        .map(|c| c.to_uppercase().collect::<String>())
        .unwrap_or_default();
    format!("{}{}.", first, rest.as_str())
}

fn lorem_paragraph(prng: &mut Prng) -> String {
    let count = prng.range(3, 6) as usize;
    let mut sentences = Vec::with_capacity(count);
    for _ in 0..count {
        sentences.push(lorem_sentence(prng));
    }
    sentences.join(" ")
}

fn shifted_iso_date(prng: &mut Prng, min_days: i64, max_days: i64) -> String {
    let now_days = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64 / 86_400)
        .unwrap_or(0);
    let date = format_date(now_days + prng.range(min_days, max_days), '-');
    format!(
        "{}T{:02}:{:02}:{:02}.{:03}Z",
        date,
        prng.range(0, 23),
        prng.range(0, 59),
        prng.range(0, 59),
        prng.range(0, 999)
    )
}

/// Resolve one Postman token. None = not in the catalogue, keep as-is.
pub(crate) fn eval(name: &str, args: Option<&str>, prng: &mut Prng) -> Option<SmartVal> {
    let picked: Option<String> = match name {
        "randomColor" => Some(pick_str(prng, COLORS).to_string()),
        "randomAbbreviation" => Some(pick_str(prng, ABBREVIATIONS).to_string()),
        "randomProtocol" => Some(pick_str(prng, PROTOCOLS).to_string()),
        "randomLocale" => Some(pick_str(prng, LOCALES).to_string()),
        "randomUserAgent" => Some(pick_str(prng, USER_AGENTS).to_string()),
        "randomFirstName" => Some(pick_str(prng, FIRST_NAMES).to_string()),
        "randomLastName" => Some(pick_str(prng, LAST_NAMES).to_string()),
        "randomNamePrefix" => Some(pick_str(prng, NAME_PREFIXES).to_string()),
        "randomNameSuffix" => Some(pick_str(prng, NAME_SUFFIXES).to_string()),
        "randomJobArea" => Some(pick_str(prng, JOB_AREAS).to_string()),
        "randomJobDescriptor" => Some(pick_str(prng, JOB_DESCRIPTORS).to_string()),
        "randomJobType" => Some(pick_str(prng, JOB_TYPES).to_string()),
        "randomCity" => Some(pick_str(prng, CITIES).to_string()),
        "randomCountry" => Some(pick_str(prng, COUNTRIES).to_string()),
        "randomCountryCode" => Some(pick_str(prng, COUNTRY_CODES).to_string()),
        "randomBankAccountName" => Some(pick_str(prng, BANK_ACCOUNT_NAMES).to_string()),
        "randomTransactionType" => Some(pick_str(prng, TRANSACTION_TYPES).to_string()),
        "randomCurrencyCode" => Some(pick_str(prng, CURRENCY_CODES).to_string()),
        "randomCurrencyName" => Some(pick_str(prng, CURRENCY_NAMES).to_string()),
        "randomCurrencySymbol" => Some(pick_str(prng, CURRENCY_SYMBOLS).to_string()),
        "randomCompanySuffix" => Some(pick_str(prng, COMPANY_SUFFIXES).to_string()),
        "randomBsAdjective" => Some(pick_str(prng, BS_ADJECTIVES).to_string()),
        "randomBsBuzz" => Some(pick_str(prng, BS_BUZZES).to_string()),
        "randomBsNoun" => Some(pick_str(prng, BS_NOUNS).to_string()),
        "randomCatchPhraseAdjective" => Some(pick_str(prng, CATCH_PHRASE_ADJECTIVES).to_string()),
        "randomCatchPhraseDescriptor" => Some(pick_str(prng, CATCH_PHRASE_DESCRIPTORS).to_string()),
        "randomCatchPhraseNoun" => Some(pick_str(prng, CATCH_PHRASE_NOUNS).to_string()),
        "randomDatabaseColumn" => Some(pick_str(prng, DATABASE_COLUMNS).to_string()),
        "randomDatabaseType" => Some(pick_str(prng, DATABASE_TYPES).to_string()),
        "randomDatabaseCollation" => Some(pick_str(prng, DATABASE_COLLATIONS).to_string()),
        "randomDatabaseEngine" => Some(pick_str(prng, DATABASE_ENGINES).to_string()),
        "randomWeekday" => Some(pick_str(prng, WEEKDAYS).to_string()),
        "randomMonth" => Some(pick_str(prng, MONTHS).to_string()),
        "randomDomainSuffix" => Some(pick_str(prng, DOMAIN_SUFFIXES).to_string()),
        "randomFileType" => Some(pick_str(prng, FILE_TYPES).to_string()),
        "randomFileExt" => Some(pick_str(prng, FILE_EXTS).to_string()),
        "randomCommonFileType" => Some(pick_str(prng, COMMON_FILE_TYPES).to_string()),
        "randomCommonFileExt" => Some(pick_str(prng, COMMON_FILE_EXTS).to_string()),
        "randomDirectoryPath" => Some(pick_str(prng, DIRECTORY_PATHS).to_string()),
        "randomMimeType" => Some(pick_str(prng, MIME_TYPES).to_string()),
        "randomProduct" => Some(pick_str(prng, PRODUCTS).to_string()),
        "randomProductAdjective" => Some(pick_str(prng, PRODUCT_ADJECTIVES).to_string()),
        "randomProductMaterial" => Some(pick_str(prng, PRODUCT_MATERIALS).to_string()),
        "randomDepartment" => Some(pick_str(prng, DEPARTMENTS).to_string()),
        "randomNoun" => Some(pick_str(prng, NOUNS).to_string()),
        "randomVerb" => Some(pick_str(prng, VERBS).to_string()),
        "randomIngverb" => Some(pick_str(prng, INGVERBS).to_string()),
        "randomAdjective" => Some(pick_str(prng, ADJECTIVES).to_string()),
        "randomWord" => Some(pick_str(prng, WORDS).to_string()),
        "randomLoremWord" => Some(pick_str(prng, LOREM).to_string()),
        _ => None,
    };
    if let Some(value) = picked {
        return Some(SmartVal::S(value));
    }

    let image: Option<&str> = match name {
        "randomAbstractImage" => Some("abstract"),
        "randomAnimalsImage" => Some("animals"),
        "randomBusinessImage" => Some("business"),
        "randomCatsImage" => Some("cats"),
        "randomCityImage" => Some("city"),
        "randomFoodImage" => Some("food"),
        "randomNightlifeImage" => Some("nightlife"),
        "randomFashionImage" => Some("fashion"),
        "randomPeopleImage" => Some("people"),
        "randomNatureImage" => Some("nature"),
        "randomSportsImage" => Some("sports"),
        "randomTransportImage" => Some("transport"),
        _ => None,
    };
    if let Some(category) = image {
        return Some(SmartVal::S(format!(
            "https://loremflickr.com/640/480/{}?lock={}",
            category,
            prng.digits(5)
        )));
    }

    let value = match name {
        "randomUUID" => format!(
            "{}-{}-4{}-{}{}-{}",
            hexs(prng, 8),
            hexs(prng, 4),
            hexs(prng, 3),
            chars(prng, b"89ab", 1),
            hexs(prng, 3),
            hexs(prng, 12)
        ),
        "randomAlphaNumeric" => chars(prng, ALNUM, 1),
        "randomBoolean" => (prng.range(0, 1) == 1).to_string(),
        "randomHexColor" => format!("#{}", hexs(prng, 6)),
        "randomIP" => format!(
            "{}.{}.{}.{}",
            prng.range(1, 255),
            prng.range(0, 255),
            prng.range(0, 255),
            prng.range(1, 254)
        ),
        "randomIPV6" => {
            let mut parts = Vec::with_capacity(8);
            for _ in 0..8 {
                parts.push(hexs(prng, 4));
            }
            parts.join(":")
        }
        "randomMACAddress" => {
            let mut parts = Vec::with_capacity(6);
            for _ in 0..6 {
                parts.push(hexs(prng, 2));
            }
            parts.join(":")
        }
        "randomPassword" => chars(prng, ALNUM, arg_count(args, 15, 64)),
        "randomSemver" => format!(
            "{}.{}.{}",
            prng.range(0, 9),
            prng.range(0, 20),
            prng.range(0, 20)
        ),
        "randomFullName" => format!(
            "{} {}",
            pick_str(prng, FIRST_NAMES),
            pick_str(prng, LAST_NAMES)
        ),
        "randomJobTitle" => format!(
            "{} {} {}",
            pick_str(prng, JOB_DESCRIPTORS),
            pick_str(prng, JOB_AREAS),
            pick_str(prng, JOB_TYPES)
        ),
        "randomPhoneNumber" => format!(
            "{}-{}-{}",
            prng.digits(3),
            prng.digits(3),
            prng.digits(4)
        ),
        "randomPhoneNumberExt" => format!(
            "{}-{}-{}-{}",
            prng.digits(2),
            prng.digits(3),
            prng.digits(3),
            prng.digits(4)
        ),
        "randomStreetName" => format!(
            "{} {}",
            pick_str(prng, LAST_NAMES),
            pick_str(prng, STREET_SUFFIXES)
        ),
        "randomStreetAddress" => format!(
            "{} {} {}",
            prng.range(1, 99_999),
            pick_str(prng, LAST_NAMES),
            pick_str(prng, STREET_SUFFIXES)
        ),
        "randomLatitude" => format!("{:.4}", prng.range(-900_000, 900_000) as f64 / 10_000.0),
        "randomLongitude" => {
            format!("{:.4}", prng.range(-1_800_000, 1_800_000) as f64 / 10_000.0)
        }
        "randomAvatarImage" => format!(
            "https://avatars.githubusercontent.com/u/{}",
            prng.range(1, 99_999_999)
        ),
        "randomImageUrl" => format!("https://picsum.photos/640/480?random={}", prng.digits(5)),
        "randomImageDataUri" => format!(
            "data:image/svg+xml;charset=UTF-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22{}%22%20height%3D%22{}%22%3E%3Crect%20width%3D%22100%25%22%20height%3D%22100%25%22%20fill%3D%22%23{}%22%2F%3E%3C%2Fsvg%3E",
            prng.range(16, 256),
            prng.range(16, 256),
            hexs(prng, 6)
        ),
        "randomBankAccount" => prng.digits(8),
        "randomCreditCardMask" => prng.digits(4),
        "randomBankAccountBic" => {
            format!("{}{}", chars(prng, UPPER, 7), prng.range(0, 9))
        }
        "randomBankAccountIban" => {
            let length = prng.range(15, 25) as usize;
            format!(
                "{}{}{}",
                chars(prng, UPPER, 2),
                prng.digits(2),
                chars(prng, UPPER_ALNUM, length)
            )
        }
        "randomBitcoin" => format!("3{}", chars(prng, ALNUM, 26)),
        "randomCompanyName" => {
            let last = pick_str(prng, LAST_NAMES);
            let tail = match prng.range(0, 2) {
                0 => format!("- {}", pick_str(prng, LAST_NAMES)),
                1 => format!(" {}", pick_str(prng, COMPANY_SUFFIXES)),
                _ => " and Sons".to_string(),
            };
            format!("{} {}", last, tail)
        }
        "randomBs" => format!(
            "{} {} {}",
            pick_str(prng, BS_ADJECTIVES),
            pick_str(prng, BS_BUZZES),
            pick_str(prng, BS_NOUNS)
        ),
        "randomCatchPhrase" => format!(
            "{} {} {}",
            pick_str(prng, CATCH_PHRASE_ADJECTIVES),
            pick_str(prng, CATCH_PHRASE_DESCRIPTORS),
            pick_str(prng, CATCH_PHRASE_NOUNS)
        ),
        "randomDateFuture" => shifted_iso_date(prng, 1, 365),
        "randomDatePast" => shifted_iso_date(prng, -365, -1),
        "randomDateRecent" => shifted_iso_date(prng, -30, 0),
        "randomDomainName" => format!(
            "{}.{}",
            pick_str(prng, LOREM).to_lowercase(),
            pick_str(prng, DOMAIN_SUFFIXES)
        ),
        "randomDomainWord" => pick_str(prng, LOREM).to_lowercase(),
        "randomEmail" => format!(
            "{}{}@{}",
            pick_str(prng, FIRST_NAMES).to_lowercase(),
            prng.range(1, 99),
            pick_str(prng, EMAIL_DOMAINS)
        ),
        "randomExampleEmail" => format!(
            "{}{}@{}",
            pick_str(prng, FIRST_NAMES),
            prng.range(1, 99),
            pick_str(prng, EXAMPLE_EMAIL_DOMAINS)
        ),
        "randomUserName" => format!(
            "{}.{}{}",
            pick_str(prng, FIRST_NAMES),
            pick_str(prng, LAST_NAMES),
            prng.range(1, 99)
        ),
        "randomUrl" => format!(
            "https://{}.{}",
            pick_str(prng, LOREM).to_lowercase(),
            pick_str(prng, DOMAIN_SUFFIXES)
        ),
        "randomFileName" => format!(
            "{}_{}.{}",
            pick_str(prng, LOREM),
            pick_str(prng, LOREM),
            pick_str(prng, FILE_EXTS)
        ),
        "randomCommonFileName" => format!(
            "{}.{}",
            pick_str(prng, LOREM),
            pick_str(prng, COMMON_FILE_EXTS)
        ),
        "randomFilePath" => format!(
            "{}/{}.{}",
            pick_str(prng, DIRECTORY_PATHS),
            pick_str(prng, LOREM),
            pick_str(prng, FILE_EXTS)
        ),
        "randomPrice" => format!("{:.2}", prng.range(0, 100_000) as f64 / 100.0),
        "randomProductName" => format!(
            "{} {} {}",
            pick_str(prng, PRODUCT_ADJECTIVES),
            pick_str(prng, PRODUCT_MATERIALS),
            pick_str(prng, PRODUCTS)
        ),
        "randomWords" => {
            let count = arg_count(args, prng.range(2, 5), 16);
            let mut parts = Vec::with_capacity(count);
            for _ in 0..count {
                parts.push(pick_str(prng, WORDS));
            }
            parts.join(" ")
        }
        "randomPhrase" => format!(
            "You can't {} the {} without {} the {} {}!",
            pick_str(prng, VERBS),
            pick_str(prng, NOUNS),
            pick_str(prng, INGVERBS),
            pick_str(prng, ADJECTIVES),
            pick_str(prng, NOUNS)
        ),
        "randomLoremWords" => {
            let count = arg_count(args, prng.range(2, 5), 16);
            let mut parts = Vec::with_capacity(count);
            for _ in 0..count {
                parts.push(pick_str(prng, LOREM));
            }
            parts.join(" ")
        }
        "randomLoremSentence" => lorem_sentence(prng),
        "randomLoremSentences" => {
            let count = prng.range(2, 6) as usize;
            let mut parts = Vec::with_capacity(count);
            for _ in 0..count {
                parts.push(lorem_sentence(prng));
            }
            parts.join(" ")
        }
        "randomLoremParagraph" => lorem_paragraph(prng),
        "randomLoremParagraphs" => {
            let mut parts = Vec::with_capacity(3);
            for _ in 0..3 {
                parts.push(lorem_paragraph(prng));
            }
            parts.join("\n\n")
        }
        "randomLoremText" => lorem_paragraph(prng),
        "randomLoremSlug" => {
            let mut parts = Vec::with_capacity(3);
            for _ in 0..3 {
                parts.push(pick_str(prng, LOREM));
            }
            parts.join("-")
        }
        "randomLoremLines" => {
            let count = prng.range(1, 5) as usize;
            let mut parts = Vec::with_capacity(count);
            for _ in 0..count {
                parts.push(lorem_sentence(prng));
            }
            parts.join("\n")
        }
        _ => return None,
    };
    Some(SmartVal::S(value))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn value(name: &str) -> Option<String> {
        let mut prng = Prng::from_time();
        eval(name, None, &mut prng).map(|item| item.text())
    }

    #[test]
    fn postman_tokens_resolve() {
        assert_eq!(value("randomUUID").unwrap().len(), 36);
        assert!(value("randomHexColor").unwrap().starts_with('#'));
        assert_eq!(value("randomIPV6").unwrap().split(':').count(), 8);
        assert_eq!(value("randomMACAddress").unwrap().split(':').count(), 6);
        assert_eq!(value("randomPassword").unwrap().len(), 15);
        assert!(value("randomAvatarImage").unwrap().starts_with("https://"));
        assert!(value("randomEmail").unwrap().contains('@'));
        assert!(value("randomBoolean").is_some());
        assert!(value("randomLoremParagraphs").unwrap().contains("\n\n"));
        assert!(value("randomDateFuture").unwrap().ends_with('Z'));
        assert_eq!(value("randomBankAccount").unwrap().len(), 8);
    }

    #[test]
    fn unknown_tokens_are_left_to_the_caller() {
        assert!(value("randomThingy").is_none());
    }

    #[test]
    fn request_variables_reach_postman_tokens() {
        use super::super::dynamic;
        assert!(dynamic::dynamic_value("$randomFirstName").is_some());
        assert_eq!(dynamic::dynamic_value("$randomUUID").unwrap().len(), 36);
        assert_eq!(dynamic::dynamic_value("$randomIPV6").unwrap().split(':').count(), 8);
        assert!(dynamic::is_dynamic("$randomIPV6"));
        assert!(dynamic::dynamic_value("$randomThingy").is_none());
    }
}
