import { loadStripeTerminal } from "@stripe/terminal-js";
import { FUNCTIONS_BASE_URL } from "./constants";

let terminalPromise;

async function postJson(path, body) {
  const response = await fetch(`${FUNCTIONS_BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(data.message || `Request to ${path} failed.`);
  }
  return data;
}

// Lazily create a single Stripe Terminal instance. The connection token is
// fetched from our Cloud Function, which holds the Stripe secret key.
async function getTerminal() {
  if (!FUNCTIONS_BASE_URL) {
    throw new Error("Set VITE_FUNCTIONS_BASE_URL to your Firebase Functions URL to use card readers.");
  }
  if (!terminalPromise) {
    terminalPromise = (async () => {
      const StripeTerminal = await loadStripeTerminal();
      if (!StripeTerminal) {
        throw new Error("Stripe Terminal could not be loaded.");
      }
      return StripeTerminal.create({
        onFetchConnectionToken: async () => {
          const data = await postJson("/stripeConnectionToken");
          if (!data.secret) throw new Error("No connection token returned.");
          return data.secret;
        },
        onUnexpectedReaderDisconnect: () => {
          // The POS shows a "reconnect reader" prompt when this happens.
        },
      });
    })();
  }
  return terminalPromise;
}

// Discover and connect to the first available reader. Pass simulated:true to
// use Stripe's built-in test reader (no hardware needed).
export async function connectReader({ simulated = false, location } = {}) {
  const terminal = await getTerminal();
  const discoverResult = await terminal.discoverReaders({ simulated, location });
  if (discoverResult.error) throw new Error(discoverResult.error.message);
  if (!discoverResult.discoveredReaders.length) {
    throw new Error("No card readers found. Check the reader is online on the same network.");
  }
  const connectResult = await terminal.connectReader(discoverResult.discoveredReaders[0]);
  if (connectResult.error) throw new Error(connectResult.error.message);
  return connectResult.reader;
}

export async function getConnectedReader() {
  const terminal = await getTerminal();
  return terminal.getConnectedReader();
}

// Full card-present charge: create the PaymentIntent on the server, collect the
// card on the reader (tap/dip/swipe), process it, then capture on the server.
export async function chargeOnReader({ amount, description, location, customerPhone }) {
  const terminal = await getTerminal();

  const intent = await postJson("/stripeCreatePaymentIntent", {
    amount,
    description,
    location,
    customerPhone,
  });

  const collect = await terminal.collectPaymentMethod(intent.clientSecret);
  if (collect.error) throw new Error(collect.error.message);

  const process = await terminal.processPayment(collect.paymentIntent);
  if (process.error) throw new Error(process.error.message);

  const captured = await postJson("/stripeCapturePaymentIntent", {
    paymentIntentId: process.paymentIntent.id,
  });

  return { paymentIntentId: captured.id, status: captured.status };
}

export async function cancelCollectPayment() {
  try {
    const terminal = await getTerminal();
    await terminal.cancelCollectPaymentMethod();
  } catch {
    // Nothing in progress to cancel.
  }
}
