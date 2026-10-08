import { describe, expect, it } from "vitest";
import { CardknoxGateway, centsToGatewayAmount, EnvSecretProvider, tenantEnvName, TelebroadSmsSender } from "../src/index.js";

describe("adapters", () => {
  it("formats gateway amounts from cents", () => {
    expect(centsToGatewayAmount(2722)).toBe("27.22");
    expect(centsToGatewayAmount(5)).toBe("0.05");
    expect(() => centsToGatewayAmount(0)).toThrow();
  });

  it("interprets Cardknox results tri-state", () => {
    expect(CardknoxGateway.interpret({ xResult: "A", xRefnum: "123", xMaskedCardNumber: "4xxx1111", xCardType: "Visa" })).toMatchObject({
      status: "approved",
      gatewayRef: "123",
    });
    expect(CardknoxGateway.interpret({ xResult: "D" }).status).toBe("declined");
    expect(CardknoxGateway.interpret({ xResult: "I" }).status).toBe("pending");
    expect(CardknoxGateway.interpret({ xResult: "E", xError: "boom" }).status).toBe("unknown");
  });

  it("treats a terminal that never answers as unknown, not declined", async () => {
    const gateway = new CardknoxGateway({
      apiKey: "k",
      pollIntervalMs: 1,
      pollTimeoutMs: 20,
      fetchImpl: (async (url: string) =>
        new Response(JSON.stringify(String(url).endsWith("/result") ? { xResult: "I" } : { xSessionId: "s" }), {
          status: 200,
        })) as unknown as typeof fetch,
    });
    const outcome = await gateway.charge({ externalRequestId: "abc", amountCents: 100, deviceId: "d" });
    expect(outcome.status).toBe("unknown");
  });

  it("maps per-tenant secrets to env names", async () => {
    expect(tenantEnvName("diamant-telecom", "SOLA_API_KEY")).toBe("TENANT_DIAMANT_TELECOM__SOLA_API_KEY");
    const provider = new EnvSecretProvider({ TENANT_DIAMANT_TELECOM__SOLA_API_KEY: "x" });
    expect(await provider.get("diamant-telecom", "SOLA_API_KEY")).toBe("x");
    expect(await provider.get("other", "SOLA_API_KEY")).toBeNull();
  });

  it("telebroad 4xx is a permanent failure", async () => {
    const sender = new TelebroadSmsSender({
      baseUrl: "https://example.test",
      username: "u",
      password: "p",
      smsLine: "1",
      fetchImpl: (async () => new Response("bad number", { status: 400 })) as unknown as typeof fetch,
    });
    const result = await sender.sendSms({ to: "+13475550000", body: "hi", idempotencyKey: "k" });
    expect(result).toMatchObject({ status: "failed", retryable: false });
  });
});
