import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowToolDescription } from "../src/mcp.js";

test("embeds tenant workflow capabilities in create_media_job tool description", () => {
  const description = createWorkflowToolDescription([{
    id: "image-to-video",
    name: "Image to video",
    kind: "image_to_video",
    asset_inputs: [{ role: "start_frame", required: true }],
    parameters: { quality: { type: "string", default: "fast", enum: ["fast", "hd"] } }
  }]);
  assert.match(description, /image-to-video/);
  assert.match(description, /start_frame/);
  assert.match(description, /"default":"fast"/);
  assert.match(description, /"enum":\["fast","hd"\]/);
});
