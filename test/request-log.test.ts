import assert from "node:assert/strict";
import test from "node:test";
import { redactLogValue } from "../src/request-log.js";

test("redacts credentials recursively while preserving MCP arguments", () => {
  assert.deepEqual(
    redactLogValue({
      token: "top-secret",
      params: {
        name: "create_media_job",
        arguments: {
          prompt: "keep this prompt",
          api_key: "hidden",
          inputs: [{ asset_id: "asset_123", role: "image" }]
        }
      }
    }),
    {
      token: "[REDACTED]",
      params: {
        name: "create_media_job",
        arguments: {
          prompt: "keep this prompt",
          api_key: "[REDACTED]",
          inputs: [{ asset_id: "asset_123", role: "image" }]
        }
      }
    }
  );
});
