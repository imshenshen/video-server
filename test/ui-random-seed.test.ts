import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const tool = path.resolve("skills/comfyui-manifest-builder/scripts/ui-to-api.mjs");

test("reports UI randomize seed controls for private manifest binding", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "ui-random-seed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const uiFile = path.join(root, "workflow.json");
  const schemaFile = path.join(root, "object-info.json");
  const outputFile = path.join(root, "workflow.api.json");
  await writeFile(uiFile, JSON.stringify({
    nodes: [
      { id: 1, type: "Sampler", mode: 0, widgets_values: [42, "randomize", 6], inputs: [
        { name: "seed", type: "INT", widget: { name: "seed" }, link: null },
        { name: "steps", type: "INT", widget: { name: "steps" }, link: null }
      ], outputs: [{ name: "OUT", type: "INT", links: [1] }] },
      { id: 2, type: "Save", mode: 0, widgets_values: [], inputs: [{ name: "value", type: "INT", link: 1 }], outputs: [] }
    ],
    links: [[1, 1, 0, 2, 0, "INT"]]
  }));
  await writeFile(schemaFile, JSON.stringify({
    Sampler: { input: { required: { seed: ["INT", {}], steps: ["INT", {}] } }, input_order: { required: ["seed", "steps"] }, output_node: false },
    Save: { input: { required: { value: ["INT", {}] } }, input_order: { required: ["value"] }, output_node: true }
  }));
  const { stdout } = await run(process.execPath, [tool, uiFile, outputFile, "--object-info", schemaFile]);
  const report = JSON.parse(stdout) as { warnings: string[] };
  const api = JSON.parse(await readFile(outputFile, "utf8"));
  assert.deepEqual(api["1"].inputs, { seed: 42, steps: 6 });
  assert.match(report.warnings.join("\n"), /bindings\.randomSeeds/);
});
