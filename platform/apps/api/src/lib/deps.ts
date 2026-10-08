import type { PaymentGateway, SecretProvider } from "@pos/adapters";
import type { Pool } from "@pos/db";
import type { Config } from "../config.js";
import type { OperatorTokens, TokenVerifier } from "./auth.js";
import type { FieldCipher } from "./crypto.js";

export interface Deps {
  config: Pick<Config, "NODE_ENV" | "LOG_LEVEL" | "CORS_ORIGINS" | "PUBLIC_BASE_URL">;
  pool: Pool;
  verifier: TokenVerifier;
  operatorTokens: OperatorTokens;
  cipher: FieldCipher;
  secrets: SecretProvider;
  /** Card gateway for a tenant (credentials differ per tenant). */
  gatewayFor: (tenantId: string) => Promise<PaymentGateway>;
  now: () => Date;
}
