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
      allowedTenants: ["alice"],
      workflowFile: "edit.api.json",
      bindings: { prompt: { nodeId: "1", input: "text" }, assets: {}, parameters: {} }
    })
  );

  const registry = new WorkflowRegistry(workflowDir, manifestDir);
  await registry.load();
  const workflow = await registry.buildWorkflow(
    { workflow_id: "edit", inputs: [], prompt: "new prompt" },
    new Map(),
    "alice"
  );

  assert.equal(registry.list().length, 1);
  assert.equal(registry.capabilities("alice").length, 1);
  assert.equal(registry.capabilities("bob").length, 0);
  assert.throws(() => registry.validateRequest({ workflow_id: "edit", inputs: [], prompt: "x" }, "bob"), /Unknown or disabled/);
  assert.equal((workflow["1"] as { inputs: { text: string } }).inputs.text, "new prompt");
});


test("expands semantic presets into trusted overrides and prompt affixes", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "video-presets-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "api"));
  await mkdir(path.join(root, "manifests"));
  await writeFile(path.join(root, "api", "image.api.json"), JSON.stringify({
    "1": { class_type: "CLIPTextEncode", inputs: { text: "old" } },
    "2": { class_type: "LoraLoaderModelOnly", inputs: { lora_name: "old.safetensors", strength_model: 1 } },
    "3": { class_type: "LazySwitchKJ", inputs: { switch: false } }
  }));
  await writeFile(path.join(root, "manifests", "image.manifest.json"), JSON.stringify({
    id: "image", name: "Image", kind: "text_to_image", enabled: true,
    allowedTenants: ["alice"], workflowFile: "image.api.json",
    bindings: { prompt: { nodeId: "1", input: "text" }, assets: {}, randomSeeds: [], parameters: {} },
    presets: {
      style: { default: "anime", options: { anime: {
        promptPrefix: "anime, ",
        overrides: [
          { nodeId: "2", input: "lora_name", value: "anime.safetensors" },
          { nodeId: "2", input: "strength_model", value: 0.8 }
        ]
      } } },
      quality: { default: "fast", options: {
        fast: { overrides: [{ nodeId: "3", input: "switch", value: false }] },
        hd: { overrides: [{ nodeId: "3", input: "switch", value: true }] }
      } }
    }
  }));
  const registry = new WorkflowRegistry(path.join(root, "api"), path.join(root, "manifests"));
  await registry.load();
  const workflow = await registry.buildWorkflow(
    { workflow_id: "image", inputs: [], prompt: "forest", parameters: { quality: "hd" } },
    new Map(), "alice"
  );
  assert.equal((workflow["1"] as { inputs: { text: string } }).inputs.text, "anime, forest");
  assert.deepEqual((workflow["2"] as { inputs: object }).inputs, {
    lora_name: "anime.safetensors", strength_model: 0.8
  });
  assert.equal((workflow["3"] as { inputs: { switch: boolean } }).inputs.switch, true);
  const parameters = (registry.capabilities("alice")[0] as { parameters: Record<string, unknown> }).parameters;
  assert.deepEqual((parameters.style as { enum: string[] }).enum, ["anime"]);
  assert.throws(
    () => registry.validateRequest(
      { workflow_id: "image", inputs: [], prompt: "x", parameters: { style: "missing" } }, "alice"
    ), /Unknown style preset/
  );
});
