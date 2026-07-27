#!/usr/bin/env node
import { access, readFile, writeFile } from "node:fs/promises";
import process from "node:process";

function fail(message) { throw new Error(message); }
function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
async function readJson(file) { return JSON.parse(await readFile(file, "utf8")); }
function inputType(spec) {
  if (!Array.isArray(spec)) return undefined;
  if (typeof spec[0] === "string") return spec[0];
  if (Array.isArray(spec[0])) return "COMBO";
  return undefined;
}
function valueMatches(value, spec) {
  const type = inputType(spec);
  if (type === "INT") return typeof value === "number" && Number.isInteger(value);
  if (type === "FLOAT" || type === "NUMBER") return typeof value === "number";
  if (type === "BOOLEAN") return typeof value === "boolean";
  if (["STRING", "COMBO"].includes(type)) return typeof value === "string" || typeof value === "number";
  return value !== undefined;
}
async function loadSchemas(nodes, options) {
  if (options.objectInfo) return readJson(options.objectInfo);
  const schemas = {};
  const types = [...new Set(nodes.map((node) => node.type))];
  await Promise.all(types.map(async (type) => {
    const response = await fetch(`${options.comfyUrl}/object_info/${encodeURIComponent(type)}`);
    if (response.status === 404) return;
    if (!response.ok) fail(`Cannot load ComfyUI schema for ${type}: HTTP ${response.status}`);
    Object.assign(schemas, await response.json());
  }));
  return schemas;
}
function parseArgs(args) {
  const [input, output, ...rest] = args;
  if (!input || !output) fail("Usage: ui-to-api.mjs <workflow.json> <output.api.json> [--comfy-url URL] [--object-info FILE] [--force]");
  const options = { input, output, comfyUrl: "http://127.0.0.1:8188", force: false };
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--force") options.force = true;
    else if (rest[i] === "--comfy-url" && rest[i + 1]) options.comfyUrl = rest[++i].replace(/\/$/, "");
    else if (rest[i] === "--object-info" && rest[i + 1]) options.objectInfo = rest[++i];
    else fail(`Unknown option: ${rest[i]}`);
  }
  return options;
}
function convert(workflow, schemas) {
  if (!isObject(workflow) || !Array.isArray(workflow.nodes) || !Array.isArray(workflow.links)) {
    fail("Input is not a ComfyUI UI Format workflow");
  }
  const nodes = new Map(workflow.nodes.map((node) => [String(node.id), node]));
  const links = new Map(workflow.links.map((link) => [link[0], link]));
  const warnings = [];

  function upstream(linkId, wantedType, seen = new Set()) {
    const link = links.get(linkId);
    if (!link) fail(`Missing workflow link ${linkId}`);
    const originId = String(link[1]);
    const originSlot = link[2];
    const node = nodes.get(originId);
    if (!node) fail(`Link ${linkId} references missing origin node ${originId}`);
    if (seen.has(originId)) fail(`Bypass cycle detected at node ${originId}`);
    if (node.mode !== 4) {
      if (node.mode === 2) fail(`Input depends on muted node ${originId}`);
      return [originId, originSlot];
    }
    seen.add(originId);
    const output = node.outputs?.[originSlot];
    const type = output?.type ?? wantedType;
    const candidates = (node.inputs ?? []).filter((input) => input.link !== null && input.link !== undefined);
    const matching = candidates.filter((input) => input.type === type || input.type === "*" || type === "*");
    const selected = matching.length === 1 ? matching[0] : candidates.length === 1 ? candidates[0] : undefined;
    if (!selected) fail(`Cannot safely bypass node ${originId} (${node.type}) output ${originSlot}`);
    return upstream(selected.link, selected.type, seen);
  }

  const api = {};
  for (const [id, node] of nodes) {
    if (node.mode === 2 || node.mode === 4) continue;
    const schema = schemas[node.type];
    if (!schema) {
      const connected = (node.inputs ?? []).some((input) => input.link != null) || (node.outputs ?? []).some((output) => output.links?.length);
      if (connected) fail(`Active connected node ${id} (${node.type}) has no ComfyUI object_info schema`);
      warnings.push(`Skipped UI-only node ${id} (${node.type})`);
      continue;
    }
    const specByName = { ...(schema.input?.required ?? {}), ...(schema.input?.optional ?? {}) };
    const uiInputs = new Map((node.inputs ?? []).map((input) => [input.name, input]));
    const values = Array.isArray(node.widgets_values) ? node.widgets_values : [];
    let valueIndex = 0;
    const inputs = {};
    const orderedNames = [
      ...(schema.input_order?.required ?? Object.keys(schema.input?.required ?? {})),
      ...(schema.input_order?.optional ?? Object.keys(schema.input?.optional ?? {}))
    ];
    for (const name of orderedNames) {
      const uiInput = uiInputs.get(name);
      const spec = specByName[name];
      let widgetValue;
      if (uiInput?.widget) {
        while (valueIndex < values.length && !valueMatches(values[valueIndex], spec)) valueIndex += 1;
        if (valueIndex < values.length) widgetValue = values[valueIndex++];
      }
      if (uiInput?.link !== null && uiInput?.link !== undefined) {
        inputs[name] = upstream(uiInput.link, uiInput.type);
        continue;
      }
      if (widgetValue !== undefined) inputs[name] = widgetValue;
      else if (schema.input?.required?.[name] !== undefined) fail(`Missing widget value for required input ${id}.${name}`);
    }
    if ((node.widgets_values ?? []).includes("randomize")) {
      warnings.push("Node " + id + " (" + node.type + ") uses randomize; add its seed input to bindings.randomSeeds and do not expose seed as a public parameter");
    }
    api[id] = { inputs, class_type: node.type, _meta: { title: node.title || node.properties?.["Node name for S&R"] || node.type } };
  }
  const outputs = Object.entries(api).filter(([, node]) => schemas[node.class_type]?.output_node === true);
  if (outputs.length === 0) fail("Converted workflow has no active output node");
  return { api, warnings };
}

const options = parseArgs(process.argv.slice(2));
if (!options.force) await access(options.output).then(() => fail(`Output exists: ${options.output}; use --force to overwrite`), () => undefined);
const workflow = await readJson(options.input);
const schemas = await loadSchemas(workflow.nodes ?? [], options);
const { api, warnings } = convert(workflow, schemas);
await writeFile(options.output, `${JSON.stringify(api, null, 2)}\n`, { flag: options.force ? "w" : "wx" });
process.stdout.write(`${JSON.stringify({ written: options.output, nodeCount: Object.keys(api).length, warnings }, null, 2)}\n`);
