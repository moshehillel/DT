/**
 * Outbound customer messaging. Adapters return a definite result; a thrown
 * error or `unknown` means "may or may not have been delivered" and the worker
 * parks the message for review instead of sending it twice.
 */
export type SendResult =
  | { status: "sent"; providerMessageId: string | null }
  | { status: "failed"; error: string; retryable: boolean }
  | { status: "unknown"; error: string };

export interface SmsSender {
  readonly provider: string;
  sendSms(input: { to: string; body: string; idempotencyKey: string }): Promise<SendResult>;
}

export interface VoiceCaller {
  readonly provider: string;
  call(input: { to: string; say: string; idempotencyKey: string }): Promise<SendResult>;
}

export interface EmailSender {
  readonly provider: string;
  send(input: { to: string; subject: string; text: string; idempotencyKey: string }): Promise<SendResult>;
}

export class FakeSmsSender implements SmsSender {
  readonly provider = "fake-sms";
  readonly sent: { to: string; body: string; idempotencyKey: string }[] = [];
  failNext: SendResult | null = null;

  async sendSms(input: { to: string; body: string; idempotencyKey: string }): Promise<SendResult> {
    if (this.failNext) {
      const result = this.failNext;
      this.failNext = null;
      return result;
    }
    this.sent.push(input);
    return { status: "sent", providerMessageId: `fake-${this.sent.length}` };
  }
}

export class FakeVoiceCaller implements VoiceCaller {
  readonly provider = "fake-voice";
  readonly calls: { to: string; say: string }[] = [];
  async call(input: { to: string; say: string; idempotencyKey: string }): Promise<SendResult> {
    this.calls.push(input);
    return { status: "sent", providerMessageId: `call-${this.calls.length}` };
  }
}

export class FakeEmailSender implements EmailSender {
  readonly provider = "fake-email";
  readonly sent: { to: string; subject: string; text: string }[] = [];
  async send(input: { to: string; subject: string; text: string; idempotencyKey: string }): Promise<SendResult> {
    this.sent.push(input);
    return { status: "sent", providerMessageId: null };
  }
}

/** Telebroad POST /send/sms with HTTP Basic (ported from functions/src/telebroad.js). */
export class TelebroadSmsSender implements SmsSender {
  readonly provider = "telebroad";
  constructor(
    private readonly config: { baseUrl: string; username: string; password: string; smsLine: string; fetchImpl?: typeof fetch },
  ) {}

  async sendSms(input: { to: string; body: string; idempotencyKey: string }): Promise<SendResult> {
    const url = `${this.config.baseUrl.replace(/\/$/, "")}/send/sms`;
    const credentials = Buffer.from(`${this.config.username}:${this.config.password}`).toString("base64");
    const receiver = input.to.replace(/^\+/, "");
    try {
      const response = await (this.config.fetchImpl ?? fetch)(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Basic ${credentials}` },
        body: JSON.stringify({ sms_line: this.config.smsLine, receiver, msgdata: input.body }),
        signal: AbortSignal.timeout(15_000),
      });
      const text = await response.text();
      if (response.ok) {
        let id: string | null = null;
        try {
          const data = JSON.parse(text) as { result?: { id?: string }; id?: string };
          id = data.result?.id ?? data.id ?? null;
        } catch {
          id = null;
        }
        return { status: "sent", providerMessageId: id };
      }
      // 4xx: the request itself is wrong (bad number) — retrying will not help.
      return { status: "failed", error: `telebroad ${response.status}: ${text.slice(0, 200)}`, retryable: response.status >= 500 };
    } catch (error) {
      const err = error as Error;
      // Timeout after the request was sent: delivery is unknown.
      if (err.name === "TimeoutError" || err.name === "AbortError") return { status: "unknown", error: err.message };
      return { status: "failed", error: err.message, retryable: true };
    }
  }
}

/** Twilio outbound call with <Say>; uses the REST API directly to avoid the SDK dependency. */
export class TwilioVoiceCaller implements VoiceCaller {
  readonly provider = "twilio";
  constructor(private readonly config: { accountSid: string; authToken: string; from: string; fetchImpl?: typeof fetch }) {}

  async call(input: { to: string; say: string; idempotencyKey: string }): Promise<SendResult> {
    const twiml = `<Response><Say>${escapeXml(input.say)}</Say></Response>`;
    const body = new URLSearchParams({ To: input.to, From: this.config.from, Twiml: twiml });
    try {
      const response = await (this.config.fetchImpl ?? fetch)(
        `https://api.twilio.com/2010-04-01/Accounts/${this.config.accountSid}/Calls.json`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString("base64")}`,
            "Content-Type": "application/x-www-form-urlencoded",
            "I-Twilio-Idempotency-Token": input.idempotencyKey,
          },
          body,
          signal: AbortSignal.timeout(15_000),
        },
      );
      const data = (await response.json().catch(() => ({}))) as { sid?: string; message?: string };
      if (response.ok) return { status: "sent", providerMessageId: data.sid ?? null };
      return { status: "failed", error: data.message ?? `twilio ${response.status}`, retryable: response.status >= 500 };
    } catch (error) {
      return { status: "unknown", error: (error as Error).message };
    }
  }
}

export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
