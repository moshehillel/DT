import {
  CardknoxGateway,
  FakePaymentGateway,
  FakeRcukClient,
  FakeSmsSender,
  FakeVoiceCaller,
  HttpRcukClient,
  TelebroadSmsSender,
  TwilioVoiceCaller,
  type PaymentGateway,
  type RcukClient,
  type SecretProvider,
  type SmsSender,
  type VoiceCaller,
} from "@pos/adapters";
import type { Pool } from "@pos/db";

export interface TenantRef {
  id: string;
  slug: string;
}

/** Providers are per tenant: every shop has its own SMS line, Twilio account and card gateway. */
export interface Providers {
  sms(tenant: TenantRef): Promise<SmsSender>;
  voice(tenant: TenantRef): Promise<VoiceCaller>;
  gateway(tenant: TenantRef): Promise<PaymentGateway>;
  rcuk(tenant: TenantRef): Promise<RcukClient>;
}

export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface WorkerDeps {
  pool: Pool;
  providers: Providers;
  now(): Date;
  log: Logger;
}

/** A provider is not configured for this tenant: nothing was sent, so this is safe to retry later. */
export class ProviderNotConfigured extends Error {}

export function fakeProviders(): Providers & {
  fakes: { sms: FakeSmsSender; voice: FakeVoiceCaller; gateway: FakePaymentGateway; rcuk: FakeRcukClient };
} {
  const fakes = { sms: new FakeSmsSender(), voice: new FakeVoiceCaller(), gateway: new FakePaymentGateway(), rcuk: new FakeRcukClient() };
  return {
    fakes,
    sms: async () => fakes.sms,
    voice: async () => fakes.voice,
    gateway: async () => fakes.gateway,
    rcuk: async () => fakes.rcuk,
  };
}

export function secretProviders(secrets: SecretProvider): Providers {
  const need = async (tenant: TenantRef, name: string) => {
    const value = await secrets.get(tenant.slug, name);
    if (!value) throw new ProviderNotConfigured(`Missing secret ${name} for ${tenant.slug}`);
    return value;
  };
  return {
    sms: async (t) =>
      new TelebroadSmsSender({
        baseUrl: (await secrets.get(t.slug, "TELEBROAD_BASE_URL")) ?? "https://webserv.telebroad.com/api/teleconsole/rest",
        username: await need(t, "TELEBROAD_USERNAME"),
        password: await need(t, "TELEBROAD_PASSWORD"),
        smsLine: await need(t, "TELEBROAD_SMS_LINE"),
      }),
    voice: async (t) =>
      new TwilioVoiceCaller({
        accountSid: await need(t, "TWILIO_ACCOUNT_SID"),
        authToken: await need(t, "TWILIO_AUTH_TOKEN"),
        from: await need(t, "TWILIO_FROM_NUMBER"),
      }),
    gateway: async (t) => new CardknoxGateway({ apiKey: await need(t, "SOLA_API_KEY") }),
    rcuk: async (t) => new HttpRcukClient({ apiKey: await need(t, "RCUK_API_KEY") }),
  };
}
