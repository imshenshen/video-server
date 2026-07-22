import assert from "node:assert/strict";
import test from "node:test";
import { collectOutputs } from "../src/comfy-client.js";

test("collects image and video descriptors from ComfyUI history", () => {
  const outputs = collectOutputs({
    outputs: {
      "10": {
        images: [{ filename: "preview.png", subfolder: "jobs/a", type: "output" }]
      },
      "20": {
        gifs: [{ filename: "result.mp4", subfolder: "jobs/a", type: "output" }]
      }
    }
  });
  assert.deepEqual(outputs, [
    { filename: "preview.png", subfolder: "jobs/a", type: "output", mediaKind: "images" },
    { filename: "result.mp4", subfolder: "jobs/a", type: "output", mediaKind: "gifs" }
  ]);
});
