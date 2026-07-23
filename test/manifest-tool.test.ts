import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tool = path.join(projectRoot, "skills/comfyui-manifest-builder/scripts/manifest-tool.mjs");
const workflow = path.join(projectRoot, "workflows/example-image-to-video.api.json");
const manifest = path.join(projectRoot, "workflows/example-image-to-video.manifest.json");

test("manifest skill inspector reports ambiguous prompt nodes", async () => {
  const { stdout } = await run(process.execPath, [tool, "inspect", workflow]);
  const report = JSON.parse(stdout) as {
    format: string;
    candidates: { prompts: Array<{ hint: string }>; assets: unknown[]; parameters: unknown[] };
  };

  assert.equal(report.format, "api");
  assert.deepEqual(report.candidates.prompts.map((candidate) => candidate.hint), ["ambiguous", "ambiguous"]);
  assert.equal(report.candidates.assets.length, 1);
  assert.equal(report.candidates.parameters.length, 1);
});

test("manifest skill validator accepts the registered example", async () => {
  const { stdout } = await run(process.execPath, [tool, "validate", workflow, manifest]);
  assert.deepEqual(JSON.parse(stdout), {
    valid: true,
    id: "example-image-to-video",
    workflowFile: "example-image-to-video.api.json"
  });
});
