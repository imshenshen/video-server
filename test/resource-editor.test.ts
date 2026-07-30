import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ResourceEditor } from "../src/resource-editor.js";
import { WorkflowRegistry } from "../src/workflow-registry.js";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "resource-editor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workflows = path.join(root, "comfyapi");
  const manifests = path.join(root, "manifests");
  await mkdir(workflows);
  await mkdir(manifests);
  await writeFile(path.join(workflows, "edit.api.json"), JSON.stringify({
    "1": { class_type: "CLIPTextEncode", inputs: { text: "old" } }
  }));
  await writeFile(path.join(manifests, "edit.manifest.json"), JSON.stringify({
    id: "edit", name: "Edit", kind: "text_to_image", enabled: true,
    allowedTenants: ["default"], workflowFile: "edit.api.json",
    bindings: { prompt: { nodeId: "1", input: "text" }, assets: {}, parameters: {} }
  }));
  const registry = new WorkflowRegistry(workflows, manifests);
  await registry.load();
  return { editor: new ResourceEditor(workflows, manifests, registry), registry, workflows, manifests };
}

test("lists, reads and saves resource files", async (t) => {
  const { editor, registry, manifests } = await fixture(t);
  assert.deepEqual(await editor.list(), [
    { kind: "comfyapi", filename: "edit.api.json" },
    { kind: "manifest", filename: "edit.manifest.json" }
  ]);
  const manifest = await editor.read("manifest", "edit.manifest.json") as Record<string, unknown>;
  manifest.name = "Edited";
  await editor.save("manifest", "edit.manifest.json", manifest);
  assert.equal(registry.list()[0].name, "Edited");
  assert.equal(JSON.parse(await readFile(path.join(manifests, "edit.manifest.json"), "utf8")).name, "Edited");
});

test("rejects unsafe names and malformed workflows without overwriting", async (t) => {
  const { editor, workflows } = await fixture(t);
  await assert.rejects(() => editor.read("comfyapi", "../edit.api.json"), /Invalid resource filename/);
  await assert.rejects(() => editor.save("comfyapi", "edit.api.json", { "1": { inputs: {} } }), /requires class_type/);
  const saved = JSON.parse(await readFile(path.join(workflows, "edit.api.json"), "utf8"));
  assert.equal(saved["1"].class_type, "CLIPTextEncode");
});
