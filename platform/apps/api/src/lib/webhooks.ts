import { createHmac, timingSafeEqual } from "node:crypto";

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Twilio: base64(HMAC-SHA1(authToken, fullUrl + concat(sorted POST params key+value))). */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

export function verifyTwilio(authToken: string, url: string, params: Record<string, string>, header: string | undefined): boolean {
  if (!authToken || !header) return false;
  return safeEqual(twilioSignature(authToken, url, params), header);
}

/** Shopify: base64(HMAC-SHA256(secret, rawBody)) in X-Shopify-Hmac-Sha256. */
export function shopifySignature(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
}

export function verifyShopify(secret: string, rawBody: string, header: string | undefined): boolean {
  if (!secret || !header) return false;
  return safeEqual(shopifySignature(secret, rawBody), header);
}

/** Providers that cannot sign (Telebroad) must present a per-tenant shared token. */
export function verifySharedToken(expected: string, presented: string | undefined): boolean {
  if (!expected || !presented) return false;
  return safeEqual(expected, presented);
}
