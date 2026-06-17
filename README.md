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
- Phone call, sale, repair, and SIM activation reports
- Automatic date/time and served-by tracking
- Payment amount and payment method
- Editable repair status
- Queued delivery notification record when a repair is marked Delivered
- Fast search plus filters for type, employee, status, payment, date range, and amount range
- Password reset request workflow for employees
- CSV export

## Later Firebase path

When ready, replace the local storage layer in `app.js` with:

- Firebase Authentication for employee sign-in
- Firebase Auth password reset emails
- Firestore for reports and employees
- Cloud Functions plus an SMS/voice provider for automatic Delivered notifications
- Firebase Hosting for deployment

## Twilio flows

Draft Twilio Studio voice flows are in `twilio/`.

- `twilio/repair-status-lookup.flow.json`
- `twilio/phones-for-sale.flow.json`

They need Firebase Function webhook URLs before they can return live repair status or phone inventory.
