import { createCipheriv, createDecipheriv, randomBytes, scrypt, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";

/**
 * Application-level encryption for sensitive intake fields (device passcode,
 * carrier account PIN). AES-256-GCM, key chosen by id so keys can rotate:
 * new writes use the current key, old envelopes still decrypt. The AAD binds
 * each envelope to its tenant and field, so a value copied into another
 * tenant's row (or another column) fails to decrypt.
 *
 * KeyProvider is the KMS seam: EnvKeyProvider for dev, a Cloud KMS-backed
 * provider (envelope-encrypted data keys) in production.
 */
export interface KeyProvider {
  currentKeyId(): string;
  key(keyId: string): Buffer;
}

export class EnvKeyProvider implements KeyProvider {
  private readonly keys = new Map<string, Buffer>();

  constructor(
    spec: string,
    private readonly current: string,
  ) {
    for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
      const [id, b64] = part.split(":");
      if (!id || !b64) throw new Error("FIELD_ENCRYPTION_KEYS must look like keyId:base64key");
      const key = Buffer.from(b64, "base64");
      if (key.length !== 32) throw new Error(`encryption key ${id} must be 32 bytes`);
      this.keys.set(id, key);
    }
    if (!this.keys.has(current)) throw new Error(`current encryption key ${current} is not configured`);
  }

  currentKeyId() {
    return this.current;
  }

  key(keyId: string) {
    const key = this.keys.get(keyId);
    if (!key) throw new Error(`unknown encryption key ${keyId}`);
    return key;
  }
}

export class FieldCipher {
  constructor(private readonly keys: KeyProvider) {}

  encrypt(plaintext: string, aad: { tenantId: string; field: string }): string {
    const keyId = this.keys.currentKeyId();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.keys.key(keyId), iv);
    cipher.setAAD(Buffer.from(`${aad.tenantId}:${aad.field}`));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ["v1", keyId, iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(".");
  }

  decrypt(envelope: string, aad: { tenantId: string; field: string }): string {
    const [version, keyId, iv, tag, ciphertext] = envelope.split(".");
    if (version !== "v1" || !keyId || !iv || !tag || ciphertext === undefined) throw new Error("bad envelope");
    const decipher = createDecipheriv("aes-256-gcm", this.keys.key(keyId), Buffer.from(iv, "base64"));
    decipher.setAAD(Buffer.from(`${aad.tenantId}:${aad.field}`));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
  }
}

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

/** Till PINs are short, so they are slow-hashed (scrypt) and attempts are rate limited by the caller. */
export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(pin, salt, 32);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPin(pin: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await scryptAsync(pin, Buffer.from(salt, "base64"), expected.length);
  return timingSafeEqual(expected, actual);
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Stable JSON for request hashing (key order independent). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}
