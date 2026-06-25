// One-time bootstrap: grant the `admin` role claim to an existing user so they
// can manage employees from the app. Run with Application Default Credentials
// (e.g. `gcloud auth application-default login`, or a service-account key via
// GOOGLE_APPLICATION_CREDENTIALS).
//
//   node scripts/setAdmin.js owner@diamanttelecom.com
//
// The user must sign out and back in afterwards to refresh their token.

const admin = require("firebase-admin");

const email = process.argv[2];
if (!email) {
  console.error("Usage: node scripts/setAdmin.js <email>");
  process.exit(1);
}

admin.initializeApp();

admin
  .auth()
  .getUserByEmail(email)
  .then((user) => admin.auth().setCustomUserClaims(user.uid, { role: "admin" }))
  .then(() => {
    console.log(`Granted admin to ${email}. They must sign out and back in to refresh the token.`);
    process.exit(0);
  })
  .catch((error) => {
    console.error("Failed to set admin claim:", error.message || error);
    process.exit(1);
  });
