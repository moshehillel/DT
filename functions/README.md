# Firebase Functions

Backend scaffold for Diamant Telecom.

## Functions

- `repairStatus`
  - Twilio endpoint for repair status lookup by customer phone number or repair ticket digits.
  - Expected URL after deploy:
    `https://REGION-PROJECT_ID.cloudfunctions.net/repairStatus`

- `phoneInventoryList`
  - Twilio endpoint that returns a spoken menu of available phones.

- `phoneInventoryDetails`
  - Twilio endpoint that returns details for a selected phone menu option.

- `notifyRepairDelivered`
  - Firestore trigger. When a repair report status changes to `Delivered`, it sends or queues a Twilio text/call.

- `shopifyOrderWebhook`
  - Draft Shopify POS order webhook importer. It writes Shopify POS sales into the `reports` collection.

- `rcukAddRental`
  - Frontend proxy for the RCUK add-rental endpoint.
  - Keeps the RCUK `api-key` on the backend.

- `rcukGetRental`
  - Frontend proxy for the RCUK get-rental endpoint.
  - Returns normalized `cli`, `usDdi`, and `pending` fields.

## Environment variables

Set these after creating the Firebase project:

```bash
firebase functions:secrets:set TWILIO_ACCOUNT_SID
firebase functions:secrets:set TWILIO_AUTH_TOKEN
firebase functions:secrets:set TWILIO_FROM_NUMBER
firebase functions:secrets:set TWILIO_REQUEST_TOKEN
firebase functions:secrets:set STORE_PHONE_NUMBER
firebase functions:secrets:set SHOPIFY_WEBHOOK_SECRET
firebase functions:secrets:set RCUK_API_KEY
```

The current source reads `process.env.*`. Before production, wire these as v2 Function secrets or environment params.

If `TWILIO_REQUEST_TOKEN` is set, add an `authToken` parameter to the Twilio Studio HTTP widgets. This prevents random public requests from using the lookup endpoints.

Optional RCUK config:

```bash
RCUK_API_BASE_URL=https://myaccount.rcuk.com/api
RCUK_ADD_RENTAL_PATH=/rental/add-rental
RCUK_GET_RENTAL_PATH=/rental/get-rental
```

## Firestore collections

### `reports`

Repair reports should include:

```json
{
  "type": "repair",
  "createdAt": "2026-06-17T12:00:00.000Z",
  "servedBy": "Moshe",
  "servedByEmployeeId": "firebaseAuthUid",
  "customerPhone": "(555) 123-4567",
  "customerPhoneDigits": "5551234567",
  "paymentAmount": "80",
  "paymentMethod": "Cash",
  "details": {
    "ticketNumber": "DR-20260617-0001",
    "ticketDigits": "202606170001",
    "model": "iPhone 13",
    "damage": "Screen",
    "status": "Ready",
    "paymentStatus": "Not paid",
    "notificationPreference": "Text message"
  }
}
```

For easier lookup, also store top-level:

```json
{
  "ticketDigits": "202606170001"
}
```

### `inventoryPhones`

```json
{
  "status": "available",
  "listOrder": 1,
  "model": "iPhone 13",
  "storage": "128 GB",
  "color": "Black",
  "carrier": "Unlocked",
  "condition": "Good",
  "batteryHealth": "89 percent",
  "price": "399",
  "notes": "Includes charger"
}
```
