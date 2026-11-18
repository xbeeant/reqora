/**
 * At-rest encryption for secrets kept in WebView localStorage.
 *
 * Tokens used to live in `reqora.cloudConnection.v1` as plain JSON —
 * readable by anyone who can open the WebView storage file, and included in
 * any localStorage dump. This module keeps the token pair in memory and only
 * writes an AES-256-GCM envelope to disk.
 *
 * The key is a **non-extractable** CryptoKey persisted in IndexedDB: its raw
 * bytes never exist in JS, so a copy of localStorage alone cannot be decrypted.
 * Where IndexedDB is unavailable (Node test runner, restricted WebViews) the
 * key is process-memory only and the secret is deliberately NOT persisted —
 * fail closed rather than writing plaintext.
 *
 * Envelope: `reqora.local.enc.v1.<base64(nonce[12] || ciphertext || tag[16])>`
 * AAD = "reqora/local-storage/v1" (deliberately different from the SQLite
 * vault in service/vault.rs).
 */

const PREFIX = "reqora.local.enc.v1.";
const AAD = new TextEncoder().encode("reqora/local-storage/v1");
const DB_NAME = "reqora-local-vault";
const STORE_NAME = "keys";
const KEY_ID = "master";
const NONCE_LEN = 12;
const KEY_TIMEOUT_MS = 2_000;

let cachedKey: CryptoKey | null = null;
let keyPromise: Promise<CryptoKey | null> | null = null;

export function isSealed(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(PREFIX);
}

function webCrypto(): Crypto | null {
  try {
    return typeof globalThis.crypto !== "undefined" && globalThis.crypto.subtle
      ? globalThis.crypto
      : null;
  } catch {
    return null;
  }
}

function withTimeout<T>(promise: Promise<T>): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), KEY_TIMEOUT_MS);
    }),
  ]);
}

function openDatabase(): Promise<IDBDatabase | null> {
  return withTimeout(
    new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
      request.onblocked = () => reject(new Error("IndexedDB blocked"));
    }),
  ).catch(() => null);
}

async function readPersistedKey(): Promise<CryptoKey | null> {
  if (typeof indexedDB === "undefined") return null;
  const db = await openDatabase();
  if (!db) return null;
  try {
    return await withTimeout(
      new Promise<CryptoKey | null>((resolve, reject) => {
        const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(KEY_ID);
        request.onsuccess = () => resolve((request.result as CryptoKey | undefined) ?? null);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB read failed"));
      }),
    );
  } finally {
    db.close();
  }
}

async function writePersistedKey(key: CryptoKey): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await openDatabase();
  if (!db) return;
  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        const request = db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(key, KEY_ID);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error ?? new Error("IndexedDB write failed"));
      }),
    );
  } finally {
    db.close();
  }
}

function generateKey(): Promise<CryptoKey> {
  return globalThis.crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false, // non-extractable: raw key bytes never appear in JS
    ["encrypt", "decrypt"],
  );
}

/** Load (or create) the non-extractable key. Never throws: returns null. */
export function localVaultKey(): Promise<CryptoKey | null> {
  if (cachedKey) return Promise.resolve(cachedKey);
  if (keyPromise) return keyPromise;
  keyPromise = (async () => {
    const crypto = webCrypto();
    if (!crypto) return null;
    try {
      const persisted = await readPersistedKey();
      if (persisted) {
        cachedKey = persisted;
        return persisted;
      }
      const key = await generateKey();
      await writePersistedKey(key);
      cachedKey = key;
      return key;
    } catch {
      // IndexedDB blocked: keep an in-memory key so the current session still
      // works, but do not let callers assume the secret was persisted.
      try {
        const key = await generateKey();
        cachedKey = key;
        return key;
      } catch {
        return null;
      }
    }
  })();
  return keyPromise;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Encrypt a UTF-8 string. Returns null when crypto is unavailable. */
export async function sealLocalSecret(plaintext: string): Promise<string | null> {
  const crypto = webCrypto();
  if (!crypto) return null;
  const key = await localVaultKey();
  if (!key) return null;
  try {
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LEN));
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce, additionalData: AAD },
        key,
        new TextEncoder().encode(plaintext),
      ),
    );
    const blob = new Uint8Array(NONCE_LEN + ciphertext.length);
    blob.set(nonce, 0);
    blob.set(ciphertext, NONCE_LEN);
    return PREFIX + toBase64(blob);
  } catch {
    return null;
  }
}

/** Decrypt an envelope. Returns null for missing/tampered/wrong-key inputs. */
export async function openLocalSecret(envelope: string): Promise<string | null> {
  if (!isSealed(envelope)) return null;
  const crypto = webCrypto();
  if (!crypto) return null;
  const key = await localVaultKey();
  if (!key) return null;
  try {
    const blob = fromBase64(envelope.slice(PREFIX.length));
    // An empty plaintext yields exactly nonce + tag (28 bytes); that is valid.
    if (blob.length < NONCE_LEN + 16) return null;
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: blob.slice(0, NONCE_LEN),
        additionalData: AAD,
      },
      key,
      blob.slice(NONCE_LEN),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}
