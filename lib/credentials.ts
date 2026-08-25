/**
 * Symmetric encryption for stored provider credentials.
 *
 * Provider passwords have to survive a round trip — the collector re-logs in on
 * its own schedule — so hashing is not an option and this is reversible
 * encryption. AES-256-GCM via WebCrypto, which is what the Workers runtime
 * gives us; no Node `crypto` import, so the same code runs in the edge runtime
 * and in tests.
 *
 * The key comes from the `GRIDLINE_CREDENTIAL_KEY` secret and never appears in
 * the repo, in logs, or in any response body. Generate one with:
 *
 *     openssl rand -base64 32
 *
 * IV DISCIPLINE: a username and a password are two plaintexts. Encrypting both
 * under the same key with the same IV is the classic GCM failure — the
 * keystream repeats and XORing the two ciphertexts leaks their XOR. So each
 * field gets its own random 12-byte IV, and `credential_iv` stores both joined
 * by a colon: `<usernameIv>:<passwordIv>`, base64 each.
 */

const IV_BYTES = 12;
const KEY_BYTES = 32;

export class CredentialError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CredentialError";
  }
}

export type EncryptedCredentials = {
  encryptedUsername: string;
  encryptedPassword: string;
  credentialIv: string;
};

const keyCache = new Map<string, Promise<CryptoKey>>();

function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Reads the secret without ever returning or logging it. */
export function credentialKeyMaterial(): string | null {
  const raw = process.env.GRIDLINE_CREDENTIAL_KEY;
  return raw && raw.trim().length > 0 ? raw.trim() : null;
}

export function credentialsConfigured() {
  return credentialKeyMaterial() !== null;
}

async function importKey(material: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = fromBase64(material);
  } catch {
    throw new CredentialError("GRIDLINE_CREDENTIAL_KEY must be base64. Generate one with: openssl rand -base64 32");
  }
  if (raw.byteLength !== KEY_BYTES) {
    throw new CredentialError(`GRIDLINE_CREDENTIAL_KEY must decode to ${KEY_BYTES} bytes, got ${raw.byteLength}. Generate one with: openssl rand -base64 32`);
  }
  return crypto.subtle.importKey("raw", raw as unknown as BufferSource, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function credentialKey(): Promise<CryptoKey> {
  const material = credentialKeyMaterial();
  if (!material) throw new CredentialError("GRIDLINE_CREDENTIAL_KEY is not set, so provider credentials cannot be stored or read");
  let pending = keyCache.get(material);
  if (!pending) {
    pending = importKey(material);
    keyCache.set(material, pending);
    // A rejected import must not be cached forever — the operator may fix the secret.
    pending.catch(() => keyCache.delete(material));
  }
  return pending;
}

async function encryptField(key: CryptoKey, value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as unknown as BufferSource }, key, new TextEncoder().encode(value));
  return { cipher: toBase64(new Uint8Array(cipher)), iv: toBase64(iv) };
}

async function decryptField(key: CryptoKey, cipher: string, iv: string) {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(iv) as unknown as BufferSource },
    key,
    fromBase64(cipher) as unknown as BufferSource,
  );
  return new TextDecoder().decode(plain);
}

export async function encryptCredentials(username: string, password: string): Promise<EncryptedCredentials> {
  if (!username || !password) throw new CredentialError("Both a username and a password are required");
  const key = await credentialKey();
  const [user, pass] = await Promise.all([encryptField(key, username), encryptField(key, password)]);
  return { encryptedUsername: user.cipher, encryptedPassword: pass.cipher, credentialIv: `${user.iv}:${pass.iv}` };
}

type StoredCredentialColumns = { [K in keyof EncryptedCredentials]?: string | null };

/** Accepts a raw database row: every credential column is nullable there. */
export async function decryptCredentials(record: StoredCredentialColumns | null | undefined): Promise<{ username: string; password: string } | null> {
  if (!record?.encryptedUsername || !record.encryptedPassword || !record.credentialIv) return null;
  const [usernameIv, passwordIv] = record.credentialIv.split(":");
  if (!usernameIv || !passwordIv) throw new CredentialError("Stored credential IV is malformed; re-add the account to repair it");
  const key = await credentialKey();
  try {
    const [username, password] = await Promise.all([
      decryptField(key, record.encryptedUsername, usernameIv),
      decryptField(key, record.encryptedPassword, passwordIv),
    ]);
    return { username, password };
  } catch (error) {
    // A GCM tag failure means the key changed or the row was tampered with.
    // Either way the plaintext is unrecoverable; say so without echoing bytes.
    throw new CredentialError("Stored credentials could not be decrypted with the current GRIDLINE_CREDENTIAL_KEY", { cause: error });
  }
}

/** Masks a username for display: `owner1234@example.com` -> `own••••••@example.com`. */
export function maskUsername(username: string) {
  const [local, domain] = username.split("@");
  if (!domain) return username.length <= 3 ? "•".repeat(username.length) : `${username.slice(0, 3)}${"•".repeat(Math.max(3, username.length - 3))}`;
  const head = local.slice(0, Math.min(3, local.length));
  return `${head}${"•".repeat(Math.max(3, local.length - head.length))}@${domain}`;
}
