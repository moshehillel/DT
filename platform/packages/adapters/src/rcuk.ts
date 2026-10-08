/**
 * RCUK SIM rental API. Interface + fake; the HTTP client mirrors the paths
 * used by functions/src/index.js (add-rental, get-rental, check-sim,
 * cancel-rental) with the api-key header.
 */
export interface RcukRentalRequest {
  simNumber: string;
  startDate: string;
  endDate: string;
  region: string;
  serviceType: string;
  addSms: boolean;
  reference: string;
}

export interface RcukClient {
  checkSim(simNumber: string): Promise<{ ok: boolean; message: string }>;
  addRental(request: RcukRentalRequest): Promise<{ ok: boolean; rentalId: string | null; message: string }>;
  getRental(rentalId: string): Promise<{ ok: boolean; numbers: string[]; message: string }>;
  cancelRental(rentalId: string): Promise<{ ok: boolean; message: string }>;
}

export class FakeRcukClient implements RcukClient {
  readonly added: RcukRentalRequest[] = [];
  async checkSim() {
    return { ok: true, message: "ok" };
  }
  async addRental(request: RcukRentalRequest) {
    this.added.push(request);
    return { ok: true, rentalId: `rcuk-${this.added.length}`, message: "ok" };
  }
  async getRental() {
    return { ok: true, numbers: ["+447700900123"], message: "ok" };
  }
  async cancelRental() {
    return { ok: true, message: "ok" };
  }
}

const FAILURE = ["failed", "fail", "error", "declined", "rejected", "invalid"];

export class HttpRcukClient implements RcukClient {
  constructor(private readonly config: { apiKey: string; baseUrl?: string; fetchImpl?: typeof fetch }) {}

  private async call(path: string, body: Record<string, unknown>) {
    const response = await (this.config.fetchImpl ?? fetch)(`${this.config.baseUrl ?? "https://myaccount.rcuk.com/api"}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": this.config.apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const status = String(data.status ?? "").toLowerCase();
    return { ok: response.ok && !FAILURE.includes(status), data };
  }

  async checkSim(simNumber: string) {
    const { ok, data } = await this.call("/check-sim", { sim: simNumber });
    return { ok, message: String(data.message ?? "") };
  }

  async addRental(request: RcukRentalRequest) {
    const { ok, data } = await this.call("/add-rental", { ...request });
    return { ok, rentalId: data.rental_id ? String(data.rental_id) : null, message: String(data.message ?? "") };
  }

  async getRental(rentalId: string) {
    const { ok, data } = await this.call("/get-rental", { rental_id: rentalId });
    const numbers = Array.isArray(data.numbers) ? data.numbers.map(String) : data.cli ? [String(data.cli)] : [];
    return { ok, numbers, message: String(data.message ?? "") };
  }

  async cancelRental(rentalId: string) {
    const { ok, data } = await this.call("/cancel-rental", { rental_id: rentalId });
    return { ok, message: String(data.message ?? "") };
  }
}
