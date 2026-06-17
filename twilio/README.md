# Twilio Studio Flows

This folder contains two draft Twilio Studio voice flows.

## Files

- `repair-status-lookup.flow.json`
  - Customer calls.
  - Enters the phone number on file.
  - Flow calls a backend endpoint to find repair/return status.
  - Customer hears the status or gets connected to the store.

- `phones-for-sale.flow.json`
  - Customer calls.
  - Flow loads current phone inventory from a backend endpoint.
  - Customer hears a numbered list.
  - Customer presses an option to hear details for that phone.

## Backend endpoints needed later

These URLs are placeholders inside the flow JSON files:

```text
https://YOUR_FIREBASE_FUNCTION_URL/twilio/repair-status
https://YOUR_FIREBASE_FUNCTION_URL/twilio/phones
https://YOUR_FIREBASE_FUNCTION_URL/twilio/phones/detail
```

Expected `repair-status` response:

```json
{
  "found": true,
  "model": "iPhone 13",
  "status": "Ready",
  "customerMessage": "Your phone is ready for pickup today."
}
```

Expected `phones` response:

```json
{
  "available": true,
  "menuText": "Press 1 for iPhone 13, 128 gigabytes, 399 dollars. Press 2 for Samsung Galaxy S22, 256 gigabytes, 349 dollars."
}
```

Expected `phones/detail` response:

```json
{
  "found": true,
  "detailText": "iPhone 13, 128 gigabytes, unlocked, battery health 89 percent, color black, price 399 dollars. Includes charger."
}
```

## Before publishing

Replace:

```text
+15555555555
```

with the real store phone number.

Replace:

```text
https://YOUR_FIREBASE_FUNCTION_URL
```

with the deployed Firebase Functions base URL.

Twilio Studio keeps execution data for a limited period, so the app/database should remain the long-term source of truth.
