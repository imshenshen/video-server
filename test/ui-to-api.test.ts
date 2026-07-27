import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const tool = path.resolve("skills/comfyui-manifest-builder/scripts/ui-to-api.mjs");

test("converts UI workflows, consumes connected widget values, and reroutes bypass nodes", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "ui-to-api-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const uiFile = path.join(root, "workflow.json");
  const schemaFile = path.join(root, "object-info.json");
  const outputFile = path.join(root, "workflow.api.json");
  await writeFile(uiFile, JSON.stringify({
    nodes: [
      { id: 1, type: "Number", mode: 0, widgets_values: [7], inputs: [{ name: "value", type: "INT", widget: { name: "value" }, link: null }], outputs: [{ name: "INT", type: "INT", links: [1, 3, 4] }] },
      { id: 2, type: "Pass", mode: 4, widgets_values: [], inputs: [{ name: "value", type: "INT", link: 1 }], outputs: [{ name: "INT", type: "INT", links: [2] }] },
      { id: 3, type: "Save", mode: 0, widgets_values: [], inputs: [{ name: "value", type: "INT", link: 2 }], outputs: [] },
      { id: 4, type: "Dimensions", mode: 0, widgets_values: [848, 1280, 1], inputs: [
        { name: "width", type: "INT", widget: { name: "width" }, link: 3 },
        { name: "height", type: "INT", widget: { name: "height" }, link: 4 },
        { name: "batch_size", type: "INT", widget: { name: "batch_size" }, link: null }
      ], outputs: [] }
    ],
    links: [[1, 1, 0, 2, 0, "INT"], [2, 2, 0, 3, 0, "INT"], [3, 1, 0, 4, 0, "INT"], [4, 1, 0, 4, 1, "INT"]]
  }));
  await writeFile(schemaFile, JSON.stringify({
    Number: { input: { required: { value: ["INT", {}] } }, input_order: { required: ["value"] }, output_node: false },
    Pass: { input: { required: { value: ["INT", {}] } }, input_order: { required: ["value"] }, output_node: false },
    Save: { input: { required: { value: ["INT", {}] } }, input_order: { required: ["value"] }, output_node: true },
    Dimensions: { input: { required: { width: ["INT", {}], height: ["INT", {}], batch_size: ["INT", {}] } }, input_order: { required: ["width", "height", "batch_size"] }, output_node: false }
  }));
  await run(process.execPath, [tool, uiFile, outputFile, "--object-info", schemaFile]);
  const api = JSON.parse(await readFile(outputFile, "utf8"));
  assert.equal(api["2"], undefined);
  assert.deepEqual(api["3"].inputs.value, ["1", 0]);
  assert.deepEqual(api["4"].inputs, { width: ["1", 0], height: ["1", 0], batch_size: 1 });
});
