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
- `SOLA_DEFAULT_DEVICE_ID` — fallback CloudIM terminal device ID. Per-store device IDs are set in the app under Inventory → Stores.
- `SOLA_DEVICE_API_BASE_URL` — optional, defaults to `https://device.cardknox.com/v2`.
- `TELEBROAD_USERNAME`, `TELEBROAD_PASSWORD` — Telebroad TeleConsole account credentials for sending SMS.
- `TELEBROAD_SMS_LINE` — the Telebroad line / DID texts are sent from (defaults to `13473887467`, the "Diamant Telecom" SMS line; override only if it changes). Look it up anytime with `GET /sms/lines`.
- `TELEBROAD_API_BASE_URL` — optional, defaults to `https://webserv.telebroad.com/api/teleconsole/rest`.
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` — still used for outgoing voice-call notifications (e.g. rental return reminders).

In-person card payments use the **Sola CloudIM** cloud API against a **PAX A80** terminal — no per-register software install. SMS is sent through the **Telebroad REST API**; voice-call notifications remain on Twilio.

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

## Twilio flows

Draft Twilio Studio voice flows are in `twilio/`. Point them at your deployed `repairStatus`, `phoneInventoryList`, and `phoneInventoryDetails` function URLs.

## Tests

```bash
cd functions
npm test
```
