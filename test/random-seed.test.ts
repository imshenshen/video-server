import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkflowRegistry } from "../src/workflow-registry.js";

test("randomizes private seeds while preserving tuned API settings", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "random-seed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workflowDir = path.join(root, "api");
  const manifestDir = path.join(root, "manifests");
  await mkdir(workflowDir);
  await mkdir(manifestDir);
  await writeFile(path.join(workflowDir, "image.api.json"), JSON.stringify({
    "1": { class_type: "KSampler", inputs: { seed: 7, steps: 6, cfg: 1, denoise: 1 } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: "old" } }
  }));
  await writeFile(path.join(manifestDir, "image.manifest.json"), JSON.stringify({
    id: "image",
    name: "Image",
    kind: "text_to_image",
    enabled: true,
    allowedTenants: ["alice"],
    workflowFile: "image.api.json",
    bindings: {
      prompt: { nodeId: "2", input: "text" },
      assets: {},
      randomSeeds: [{ nodeId: "1", input: "seed" }],
      parameters: {}
    }
  }));
  const registry = new WorkflowRegistry(workflowDir, manifestDir);
  await registry.load();
  const request = { workflow_id: "image", inputs: [], prompt: "new" };
  const first = await registry.buildWorkflow(request, new Map(), "alice");
  const second = await registry.buildWorkflow(request, new Map(), "alice");
  const firstInputs = (first["1"] as { inputs: Record<string, number> }).inputs;
  const secondInputs = (second["1"] as { inputs: Record<string, number> }).inputs;
  assert.ok(Number.isSafeInteger(firstInputs.seed));
  assert.ok(firstInputs.seed >= 0);
  assert.notEqual(firstInputs.seed, secondInputs.seed);
  assert.deepEqual(
    { steps: firstInputs.steps, cfg: firstInputs.cfg, denoise: firstInputs.denoise },
    { steps: 6, cfg: 1, denoise: 1 }
  );
  assert.deepEqual((registry.capabilities("alice")[0] as { parameters: object }).parameters, {});
  assert.throws(
    () => registry.validateRequest({ ...request, parameters: { steps: 20 } }, "alice"),
    /Unknown workflow parameter: steps/
  );
});
