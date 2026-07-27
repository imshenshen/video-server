import assert from "node:assert/strict";
import test from "node:test";
import { formatUpstreamError } from "../src/upstream-error.js";

test("propagates safe upstream HTTP error details", () => {
  const error = formatUpstreamError("Asset service", "import generated output", {
    isAxiosError: true,
    message: "Request failed with status code 400",
    response: { status: 400, data: { error: { message: "Import path is outside configured roots" } } },
    config: { headers: { authorization: "Bearer secret" } }
  });
  assert.equal(
    error.message,
    "Asset service import generated output failed (HTTP 400): Import path is outside configured roots"
  );
  assert.doesNotMatch(error.message, /secret|authorization/i);
});

test("propagates network error codes without request internals", () => {
  const error = formatUpstreamError("ComfyUI", "read history", {
    isAxiosError: true,
    message: "connect ECONNREFUSED",
    code: "ECONNREFUSED"
  });
  assert.equal(error.message, "ComfyUI read history failed: ECONNREFUSED");
});
