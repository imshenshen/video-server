import assert from "node:assert/strict";
import test from "node:test";
import { resolveTenantForCredentials } from "../src/auth.js";
import { parseApiUsers } from "../src/config.js";

test("parses static API users as fixed tenant/token mappings", () => {
  assert.deepEqual(parseApiUsers('{"alice":"alice-token-123456","bob":"bob-token-12345678"}'), [
    { tenantId: "alice", token: "alice-token-123456" },
    { tenantId: "bob", token: "bob-token-12345678" }
  ]);
});

test("rejects duplicate tokens and invalid tenant IDs", () => {
  assert.throws(() => parseApiUsers('{"alice":"same-token-123456","bob":"same-token-123456"}'), /unique/);
  assert.throws(() => parseApiUsers('{"bad user":"valid-token-123456"}'), /Invalid tenant/);
});


test("static user token fixes tenant and ignores a forged tenant header", () => {
  const users = parseApiUsers('{"alice":"alice-token-123456","bob":"bob-token-12345678"}');
  assert.equal(resolveTenantForCredentials("alice-token-123456", "bob", users), "alice");
  assert.equal(resolveTenantForCredentials("bob-token-12345678", "alice", users), "bob");
  assert.equal(resolveTenantForCredentials("unknown-token-123", "alice", users), undefined);
});
