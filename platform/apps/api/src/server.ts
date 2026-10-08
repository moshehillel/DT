import { CardknoxGateway, EnvSecretProvider, FakePaymentGateway, type PaymentGateway } from "@pos/adapters";
import { createPool, withTenant } from "@pos/db";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { DevTokenVerifier, FirebaseTokenVerifier, OperatorTokens } from "./lib/auth.js";
import { EnvKeyProvider, FieldCipher } from "./lib/crypto.js";

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
const secrets = new EnvSecretProvider();
const fake = new FakePaymentGateway();

async function gatewayFor(tenantId: string): Promise<PaymentGateway> {
  if (config.PAYMENT_GATEWAY === "fake") return fake;
  const slug = await withTenant(pool, { tenantId }, async (tx) => {
    const row = await tx.client.query<{ slug: string }>(`SELECT slug FROM tenants LIMIT 1`);
    return row.rows[0]?.slug ?? "";
  });
  const apiKey = await secrets.get(slug, "SOLA_API_KEY");
  if (!apiKey) throw new Error(`No SOLA_API_KEY configured for tenant ${slug}`);
  return new CardknoxGateway({ apiKey });
}

const app = buildApp({
  config,
  pool,
  verifier:
    config.AUTH_MODE === "firebase" ? new FirebaseTokenVerifier(config.FIREBASE_PROJECT_ID) : new DevTokenVerifier(config.DEV_AUTH_SECRET),
  operatorTokens: new OperatorTokens(config.OPERATOR_TOKEN_SECRET),
  cipher: new FieldCipher(new EnvKeyProvider(config.FIELD_ENCRYPTION_KEYS, config.FIELD_ENCRYPTION_CURRENT_KEY)),
  secrets,
  gatewayFor,
  now: () => new Date(),
});

const shutdown = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await app.listen({ port: config.PORT, host: "0.0.0.0" });
