const test = require("node:test");
const assert = require("node:assert/strict");
const { requireEmployee } = require("../src/auth");

function fakeRes() {
  return {
    statusCode: 0,
    body: null,
    status(code) { this.statusCode = code; return this; },
    set() { return this; },
    send(body) { this.body = body; return this; },
  };
}

const verify = async (token) => {
  if (token === "good") return { uid: "employee-1" };
  throw new Error("bad token");
};

test("no token is refused", async () => {
  const res = fakeRes();
  const user = await requireEmployee({ headers: {} }, res, verify);
  assert.equal(user, null);
  assert.equal(res.statusCode, 401);
});

test("a bad token is refused", async () => {
  const res = fakeRes();
  const user = await requireEmployee({ headers: { authorization: "Bearer nope" } }, res, verify);
  assert.equal(user, null);
  assert.equal(res.statusCode, 401);
});

test("a signed-in employee gets through", async () => {
  const res = fakeRes();
  const user = await requireEmployee({ headers: { authorization: "Bearer good" } }, res, verify);
  assert.equal(user.uid, "employee-1");
  assert.equal(res.statusCode, 0);
});
