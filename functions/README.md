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
  - Firestore trigger. When a repair report status changes to `Ready`, it sends or queues a Twilio text/call.

- `shopifyOrderWebhook`
  - Draft Shopify POS order webhook importer. It writes Shopify POS sales into the `pendingReports` collection for employees to claim and complete.

- `telebroadCallWebhook`
  - Telebroad **Account real time calls** webhook importer. Answered inbound/outbound calls are written into `pendingReports` as `type: "call"` for employees to claim and complete.
  - Also accepts **User end call** webhooks when `talkDuration` is greater than zero.
  - Configure in Telebroad Admin Center under **App Integrations > Webhooks**. Use:
    `https://REGION-PROJECT_ID.cloudfunctions.net/telebroadCallWebhook/Account-real-time-calls`
  - Optional second webhook for richer talk duration on hang-up:
    `https://REGION-PROJECT_ID.cloudfunctions.net/telebroadCallWebhook/User-end-call`

- `rcukAddRental`
  - Frontend proxy for the RCUK add-rental endpoint.
  - Keeps the RCUK `api-key` on the backend.

- `rcukGetRental`
  - Frontend proxy for the RCUK get-rental endpoint.
  - Returns normalized `cli`, `usDdi`, and `pending` fields.

- `solaCreateCharge`
  - Frontend proxy for a Sola/Cardknox credit-card sale.
  - Posts to `https://x1.cardknox.com/gatewayjson` by default with `xCommand: cc:sale`.
  - The frontend sends a hosted-card token/SUT, not raw card numbers.
  - The app records the returned Sola reference before a CC rental can be saved.

- `sendRentalReturnReminders`
  - Scheduled function. Sends a text or phone call one day before the rental return due date.
  - Message: `Hi, this is a friendly reminder from Diamant Telecom to return the phone you rented from us by tomorrow to avoid extra charges.`

- `notifyPhoneOrderAssigned`
  - Sends a customer SMS when a manual phone order is assigned.
  - Sends the assigned handler an SMS with customer contact, address, order total, and whether payment was already collected.

- `notifyPhoneOrderDelivered`
  - Sends the customer an SMS when the assigned handler marks the phone order delivered.

## Environment variables

Set these after creating the Firebase project:

```bash
firebase functions:secrets:set TWILIO_ACCOUNT_SID
firebase functions:secrets:set TWILIO_AUTH_TOKEN
firebase functions:secrets:set TWILIO_FROM_NUMBER
firebase functions:secrets:set TWILIO_REQUEST_TOKEN
firebase functions:secrets:set SHOPIFY_WEBHOOK_SECRET
firebase functions:secrets:set RCUK_API_KEY
firebase functions:secrets:set SOLA_API_KEY
```

The current source reads `process.env.*`. Before production, wire these as v2 Function secrets or environment params.

If `TWILIO_REQUEST_TOKEN` is set, add an `authToken` parameter to the Twilio Studio HTTP widgets. This prevents random public requests from using the lookup endpoints.

Optional RCUK config:

```bash
RCUK_API_BASE_URL=https://myaccount.rcuk.com/api
RCUK_ADD_RENTAL_PATH=/add-rental
RCUK_GET_RENTAL_PATH=/get-rental
RCUK_CHECK_SIM_PATH=/check-sim
```

Per the [RCUK API docs](https://myaccount.rcuk.com/api-documentation): `add-rental`
and `check-sim` are `POST`; `get-rental` is a `GET` with a `rental_id` query
parameter. The `rcukAddRental` proxy maps the rental form fields to the required
RCUK params:

- `sim_number` — normalized SIM/ICCID.
- `country` — always `"UK"`.
- `rental_type` — `"daily"` (or `"monthly"` when `no_of_months` is supplied).
- `rental_package` — `"voice"`, `"data"`, or `"v&d"` (from the Service selector).
- `start_date`, and `end_date` (daily) or `no_of_months` (monthly).
- `uk_days`, `eu_days`, `wts_days` — ints. `tp_days` is always `0`.
- `il_ddi`, `us_ddi`, `sms` — int flags (`0` or `1`).
- `Notes` — set to the customer phone number.

Optional Sola config:

```bash
SOLA_API_BASE_URL=https://x1.cardknox.com
SOLA_CREATE_CHARGE_PATH=/gatewayjson
```

Optional reminder config:

```bash
RENTAL_REMINDER_TIME_ZONE=America/New_York
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

Rental reports should include:

```json
{
  "type": "rental",
  "customerPhone": "(555) 123-4567",
  "paymentAmount": "120",
  "paymentMethod": "CC",
  "details": {
    "rentalId": "RCUK rental id",
    "returnDueDate": "2026-06-25",
    "returnReminderPreference": "Text message",
    "solaStatus": "paid",
    "solaTransactionId": "Sola/Cardknox xRefNum"
  }
}
```

### `pendingReports`

Shopify POS and Telebroad call webhook imports land here before becoming completed store reports.

Shopify POS example:

```json
{
  "type": "sale",
  "source": "shopify_pos",
  "status": "pending",
  "shopifyOrderId": "123456789",
  "shopifyOrderName": "#1045",
  "paymentAmount": "499.00",
  "paymentMethod": "Shopify POS",
  "customerPhone": "(555) 123-4567",
  "imported": {
    "lineItemsText": "1x iPhone 13",
    "locationName": "Store"
  }
}
```

When Shopify POS or Telebroad data is imported, the pending report opens for completion without **Claim it**. **Served by** on the saved report is always the employee who clicks save. Shopify POS staff names are not imported.

### Shopify POS IMEI scanning

To auto-fill IMEI in pending sale reports, capture the scanned IMEI in Shopify as a **line item property** named `IMEI` (or containing `imei`).

Typical Shopify POS setup:

1. In Shopify admin, open the phone product used at POS.
2. Add a line item property / custom property called `IMEI`.
3. At checkout on POS, scan or type the IMEI into that property before completing the sale.
4. The order webhook sends `line_items[].properties[]` to `shopifyOrderWebhook`, and the app copies it into the pending sale `imei` field.

Supported property names: `IMEI`, `Device IMEI`, `Phone IMEI`, `Serial`, `Serial Number`, or any property name containing `imei`.

Telebroad answered call example:

```json
{
  "id": "telebroad-1743731655_796929",
  "type": "call",
  "source": "telebroad",
  "status": "pending",
  "title": "Inbound call John Customer (17329942081)",
  "servedBy": "Sally Edwards",
  "customerPhone": "17329942081",
  "customerPhoneDigits": "17329942081",
  "imported": {
    "callId": "1743731655.796929",
    "direction": "Incoming",
    "status": "ended",
    "employeeName": "Sally Edwards",
    "talkDuration": 42
  },
  "details": {
    "callerName": "John Customer",
    "reason": "",
    "outcome": "Answered",
    "handledBy": "Sally Edwards",
    "telebroadCallId": "1743731655.796929"
  }
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
