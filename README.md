# Diamant Telecom Reports

React front end for a phone store reporting system.

## Open the app

Install dependencies and start the Vite dev server:

```bash
npm install
npm run dev
```

The current version stores reports in this browser with `localStorage`, so it does not require Firebase or a Google project yet.

## Included in version 1

- Employee selector and employee manager
- Login screen for employees
- Admin login mode. Demo admin PIN: `admin123`
- Admin page with employee activity totals and audit trail
- Employees only see their own reports after login
- Phone call, sale, repair, SIM activation, and phone rental reports
- Phone rentals track voice/data plan, inclusive day count, UK/EU/WTS days, SMS, USA number, device kind, return deadline, RCUK rental ID, CLI, US DDI, and calculated total
- Rental submit is disabled until required fields are complete and UK/EU/WTS days match total days
- RCUK rentals have a 4-day minimum
- Canada rentals are simple reports with a 4-day minimum and pricing at `$45/week` or `$30/weekend`
- Israel rentals are simple reports with a 7-day minimum and pricing at `$5/day`
- Rental report save is disabled until Get numbers has been tried at least once after RCUK submission
- In-app notifications show rentals that are past their return due date
- Automatic date/time and served-by tracking
- Payment amount and payment method
- Automatic repair ticket numbers, like `DR-20260617-0001`
- Repair paid/not-paid status
- Editable repair status
- Queued delivery notification record when a repair is marked Delivered
- Fast search plus filters for type, employee, status, payment, date range, and amount range
- Password reset request workflow for employees
- CSV export

## Later Firebase path

Firebase scaffolding has been added:

- `firebase.json`
- `firestore.rules`
- `firestore.indexes.json`
- `functions/`

When ready, replace the local storage layer in `src/main.jsx` with:

- Firebase Authentication for employee sign-in
- Firebase Auth password reset emails
- Firestore for reports and employees
- Cloud Functions plus an SMS/voice provider for automatic Delivered notifications
- Firebase Hosting for deployment

Rental reports call Firebase Function proxies for the RCUK API. Set `VITE_FUNCTIONS_BASE_URL` before using the real rental submit/get-numbers flow.

## Twilio flows

Draft Twilio Studio voice flows are in `twilio/`.

- `twilio/repair-status-lookup.flow.json`
- `twilio/phones-for-sale.flow.json`

They need Firebase Function webhook URLs before they can return live repair status or phone inventory. The repair lookup flow is ready to search by customer phone number or repair ticket number.
