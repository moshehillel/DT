function bearerToken(req) {
  const header = String(req.get?.("authorization") || req.headers?.authorization || "");
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

// HTTP functions that move money, run RCUK, send texts, or serve recordings
// answer only a signed-in employee. Returns the decoded user, or null after
// sending 401.
async function requireEmployee(req, res, verifyIdToken) {
  const token = bearerToken(req);
  if (!token) {
    res.status(401).set("Content-Type", "application/json").send({ ok: false, message: "Sign in again." });
    return null;
  }
  try {
    return await verifyIdToken(token);
  } catch {
    res.status(401).set("Content-Type", "application/json").send({ ok: false, message: "Sign in again." });
    return null;
  }
}

module.exports = { bearerToken, requireEmployee };
