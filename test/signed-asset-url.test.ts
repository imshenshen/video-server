import assert from "node:assert/strict";
import test from "node:test";
import { createAssetAccessToken, verifyAssetAccessToken } from "../src/signed-asset-url.js";

const secret = "test-signing-secret-that-is-at-least-32-characters";
const assetId = "asset_1e2446d2e29e4f32bd7fc4d7f31cbabe";

test("signs tenant-bound expiring asset access tokens", () => {
  const token = createAssetAccessToken(assetId, "alice", 2_000, secret);
  assert.deepEqual(verifyAssetAccessToken(token, assetId, 1_000, secret), {
    version: 1,
    assetId,
    tenantId: "alice",
    expiresAt: 2_000
  });
});

test("rejects tampered, mismatched, and expired asset tokens", () => {
  const token = createAssetAccessToken(assetId, "alice", 2_000, secret);
  assert.throws(() => verifyAssetAccessToken(token + "x", assetId, 1_000, secret), /Invalid asset access token/);
  assert.throws(() => verifyAssetAccessToken(token, "asset_8dc4cfeae8a94e08bd3cbcd3b00e3daf", 1_000, secret), /Invalid asset access token/);
  assert.throws(() => verifyAssetAccessToken(token, assetId, 2_000, secret), /expired/);
});
