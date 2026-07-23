import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { collectOutputs } from "../src/comfy-client.js";
import { WorkflowRegistry } from "../src/workflow-registry.js";

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

test("loads manifests and API workflows from separate directories", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "video-workflows-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workflowDir = path.join(root, "api");
  const manifestDir = path.join(root, "manifests");
  await mkdir(workflowDir);
  await mkdir(manifestDir);
  await writeFile(
    path.join(workflowDir, "edit.api.json"),
    JSON.stringify({ "1": { class_type: "CLIPTextEncode", inputs: { text: "old" } } })
  );
  await writeFile(
    path.join(manifestDir, "edit.manifest.json"),
    JSON.stringify({
      id: "edit",
      name: "Edit",
      kind: "image_to_image",
      enabled: true,
      workflowFile: "edit.api.json",
      bindings: { prompt: { nodeId: "1", input: "text" }, assets: {}, parameters: {} }
    })
  );

  const registry = new WorkflowRegistry(workflowDir, manifestDir);
  await registry.load();
  const workflow = await registry.buildWorkflow(
    { workflow_id: "edit", inputs: [], prompt: "new prompt" },
    new Map()
  );

  assert.equal(registry.list().length, 1);
  assert.equal((workflow["1"] as { inputs: { text: string } }).inputs.text, "new prompt");
});
