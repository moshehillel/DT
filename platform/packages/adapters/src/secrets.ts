/**
 * Secrets are looked up per tenant by name and never live in the database or
 * the repo. EnvSecretProvider maps ("diamant-telecom", "SOLA_API_KEY") to the
 * env var TENANT_DIAMANT_TELECOM__SOLA_API_KEY; a Google Secret Manager
 * provider can implement the same interface in production.
 */
export interface SecretProvider {
  get(tenantSlug: string, name: string): Promise<string | null>;
}

export function tenantEnvName(tenantSlug: string, name: string): string {
  return `TENANT_${tenantSlug.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}__${name}`;
}

export class EnvSecretProvider implements SecretProvider {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async get(tenantSlug: string, name: string): Promise<string | null> {
    return this.env[tenantEnvName(tenantSlug, name)] || null;
  }
}

export class StaticSecretProvider implements SecretProvider {
  constructor(private readonly values: Record<string, string>) {}

  async get(tenantSlug: string, name: string): Promise<string | null> {
    return this.values[`${tenantSlug}/${name}`] ?? null;
  }
}
