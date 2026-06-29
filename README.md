# Diamant Telecom Reports

React front end for a phone store reporting system with Firebase sync and Cloud Functions integrations.

## Open the app

Install dependencies and start the Vite dev server:

```bash
npm install
npm run dev
```

The app keeps a `localStorage` copy of each collection and syncs to Firestore when Firebase Hosting config is available at `/__/firebase/init.json`. Without Firebase, it still works offline in the browser.

Set `VITE_FUNCTIONS_BASE_URL` to your deployed Functions base URL (for example `https://us-central1-PROJECT_ID.cloudfunctions.net`) before using RCUK rentals, Sola card charges, in-person terminal payments, or live SMS notifications.

### Backend environment variables

Set these on Firebase Functions (`firebase functions:secrets:set` or `.env`):

- `SOLA_API_KEY` — Sola / Cardknox API key (used for both online charges and the in-person terminal).
- `SOLA_DEVICE_API_BASE_URL` — optional, defaults to `https://device.cardknox.com/v2`. Each store's CloudIM terminal device ID is set in the app under Inventory → Stores; there is no global fallback.
- `TELEBROAD_USERNAME`, `TELEBROAD_PASSWORD` — Telebroad TeleConsole account credentials for sending SMS.
- `TELEBROAD_SMS_LINE` — the Telebroad line / DID texts are sent from (defaults to `13473887467`, the "Diamant Telecom" SMS line; override only if it changes). Look it up anytime with `GET /sms/lines`.
- `TELEBROAD_API_BASE_URL` — optional, defaults to `https://webserv.telebroad.com/api/teleconsole/rest`.
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` — still used for outgoing voice-call notifications (e.g. rental return reminders).

In-person card payments use **Sola BBPOS** against a **Verifone P200** terminal. BBPOS ("PaymentEngineExt") is a small tray app installed on each register that runs a local HTTPS server at `https://localemv.com:8887`; the browser POS posts the sale to it and it drives the P200 over USB/LAN. The Cardknox API key is configured inside the tray app, so it never reaches the browser, and there is no per-store device ID to set. SMS is sent through the **Telebroad REST API**; voice-call notifications remain on Twilio.

## Included features

- Employee selector and employee manager
- Login screen for employees
- Admin login mode (demo admin PIN: `admin123`)
- Admin page with employee activity totals and audit trail
- Employees only see their own reports after login
- Pending reports queue for Shopify POS imports and Telebroad answered calls
- Phone call, sale, repair, SIM activation, phone rental, and phone order reports
- RCUK rental flow with SIM check, add rental, get numbers, and Sola CC charging
- Canada and Israel simple rental pricing rules
- Scheduled rental return reminders (Cloud Function)
- Twilio repair status and phone inventory voice flows
- CSV export

## Project layout

```text
src/
  constants.js          App constants and report type definitions
  utils.js              Formatting, rental pricing, CSV export
  hooks/useCloudState.js Firestore sync hooks
  firebaseClient.js     Firebase init and batched collection sync
  main.jsx              React UI
functions/
  src/index.js          Cloud Functions entrypoint
  src/rcuk.js           RCUK payload helpers
  src/repairs.js        Repair lookup and IVR message helpers
  test/                 Node test runner unit tests
firestore.rules         Production security rules (wire up before launch)
twilio/                 Draft Twilio Studio voice flows
```

## Firebase deployment

```bash
npm run build
firebase deploy --only hosting,functions,firestore:rules,firestore:indexes
```

Deploy Firestore indexes before enabling the repair lookup and rental reminder functions.

## Production checklist

Before going live:

1. **Frontend env** — set `VITE_ADMIN_PIN` (don't ship the dev default) and `VITE_FUNCTIONS_BASE_URL` at build time. See `.env.example`.
2. **Functions secrets** — set on Firebase Functions:
   - `SOLA_API_KEY` (Sola/Cardknox CloudIM terminal; per-store device IDs are set in-app under Inventory → Stores)
   - `TELEBROAD_USERNAME`, `TELEBROAD_PASSWORD` (SMS; `TELEBROAD_SMS_LINE` defaults to the Diamant line)
   - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` (outgoing voice notifications)
   - `RCUK_API_KEY` (rentals), `SHOPIFY_WEBHOOK_SECRET` (Shopify import verification)
   - `ALLOWED_WEB_ORIGIN` — set to your site origin to lock down function CORS.
3. **Authentication:** the app uses Firebase Authentication (email/password). Admins are identified by a `role: 'admin'` custom claim, which the admin-only Firestore rules and Cloud Functions check. Enable the Email/Password provider in the Firebase console, then bootstrap the first admin (below). Admins create and manage all other accounts in-app under **Manage employees**.
4. **Build** — `npm run build` produces `dist/` with no source maps and split vendor chunks.
5. **Verify** — run `cd functions && npm test`, then smoke-test a sale, a card charge, an SMS, and a return on a staging project before pointing production traffic at it.

## First admin (bootstrap)

After deploying, create the owner account and grant it admin:

1. In the Firebase console, enable **Authentication → Email/Password**, and add the first user (or sign up via the app's login screen once a user exists).
2. Grant that user the admin claim (run from the `functions/` folder with credentials that can manage the project):

   ```bash
   cd functions
   node scripts/setAdmin.js owner@diamanttelecom.com
   ```

3. Sign out and back in so the new token carries the claim. That admin can now create all other employees from **Manage employees** (which calls the `createEmployee` / `setEmployeeAdmin` / `deleteEmployee` Cloud Functions).

## Twilio flows

Draft Twilio Studio voice flows are in `twilio/`. Point them at your deployed `repairStatus`, `phoneInventoryList`, and `phoneInventoryDetails` function URLs.

## Tests

```bash
cd functions
npm test
```
