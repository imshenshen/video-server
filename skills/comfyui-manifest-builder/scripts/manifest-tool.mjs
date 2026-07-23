#!/usr/bin/env node

import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const parameterNames = new Set([
  "seed",
  "noise_seed",
  "steps",
  "cfg",
  "cfg_scale",
  "denoise",
  "strength",
  "width",
  "height",
  "batch_size",
  "frame_rate",
  "fps",
  "length",
  "num_frames"
]);

function fail(message) {
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readJson(filename) {
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read JSON ${filename}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function workflowFormat(workflow) {
  if (isObject(workflow) && Array.isArray(workflow.nodes)) return "ui";
  if (!isObject(workflow)) return "unknown";
  const nodes = Object.values(workflow);
  if (nodes.length > 0 && nodes.every((node) => isObject(node) && typeof node.class_type === "string" && isObject(node.inputs))) {
    return "api";
  }
  return "unknown";
}

function scalarType(value) {
  if (Number.isInteger(value)) return "integer";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  return undefined;
}

function inspect(workflow, filename) {
  const format = workflowFormat(workflow);
  if (format !== "api") {
    return {
      file: path.resolve(filename),
      format,
      error: format === "ui"
        ? "This is ComfyUI UI Format. Export the workflow using Export (API Format)."
        : "The root is not a recognized ComfyUI API Workflow object."
    };
  }

  const candidates = { prompts: [], assets: [], parameters: [], outputs: [] };
  const nodes = Object.entries(workflow).map(([nodeId, node]) => {
    const title = typeof node._meta?.title === "string" ? node._meta.title : "";
    const classType = node.class_type;
    const searchable = `${classType} ${title}`.toLowerCase();
    const inputs = Object.entries(node.inputs).map(([name, value]) => ({
      name,
      type: scalarType(value) ?? (Array.isArray(value) ? "connection" : typeof value)
    }));

    for (const [input, value] of Object.entries(node.inputs)) {
      const lower = input.toLowerCase();
      if (
        typeof value === "string" &&
        (lower === "text" || lower.includes("prompt")) &&
        /(text|prompt|encode|conditioning)/i.test(searchable)
      ) {
        candidates.prompts.push({
          nodeId,
          input,
          title,
          classType,
          hint: /negative|负面|反向/i.test(title) ? "negative" : /positive|正面|提示词/i.test(title) ? "positive" : "ambiguous"
        });
      }

      if (
        typeof value === "string" &&
        (/(load.*(image|video)|(image|video).*load)/i.test(searchable) ||
          ["image", "video", "filename", "path"].includes(lower))
      ) {
        candidates.assets.push({ nodeId, input, title, classType });
      }

      if (parameterNames.has(lower) && scalarType(value)) {
        candidates.parameters.push({
          name: lower,
          nodeId,
          input,
          type: scalarType(value),
          currentValue: value,
          title,
          classType
        });
      }
    }

    if (/(save|preview|combine|output).*(image|video|gif|webp)|(image|video).*(save|output)/i.test(searchable)) {
      candidates.outputs.push({ nodeId, title, classType });
    }

    return { nodeId, classType, title, inputs };
  });

  return {
    file: path.resolve(filename),
    format,
    nodeCount: nodes.length,
    candidates,
    nodes
  };
}

function validateBinding(binding, label, workflow, errors) {
  if (!isObject(binding)) {
    errors.push(`${label} must be an object`);
    return;
  }
  if (typeof binding.nodeId !== "string" || binding.nodeId.length === 0) {
    errors.push(`${label}.nodeId must be a non-empty string`);
    return;
  }
  if (typeof binding.input !== "string" || binding.input.length === 0) {
    errors.push(`${label}.input must be a non-empty string`);
    return;
  }
  const node = workflow[binding.nodeId];
  if (!isObject(node)) {
    errors.push(`${label} references missing node ${binding.nodeId}`);
    return;
  }
  if (!isObject(node.inputs) || !(binding.input in node.inputs)) {
    errors.push(`${label} references missing input ${binding.nodeId}.inputs.${binding.input}`);
  }
}

function valueMatchesType(value, type) {
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  return typeof value === type;
}

function validateManifest(workflow, manifest, workflowFilename) {
  const errors = [];
  const bindingTargets = [];
  if (workflowFormat(workflow) !== "api") errors.push("Workflow must be ComfyUI API Format");
  if (!isObject(manifest)) return ["Manifest root must be an object"];

  if (typeof manifest.id !== "string" || !/^[a-zA-Z0-9_.-]+$/.test(manifest.id)) {
    errors.push("id must match ^[a-zA-Z0-9_.-]+$");
  }
  if (typeof manifest.name !== "string" || manifest.name.length === 0) errors.push("name must be a non-empty string");
  if (manifest.description !== undefined && typeof manifest.description !== "string") errors.push("description must be a string");
  if (!["image_to_image", "image_to_video"].includes(manifest.kind)) {
    errors.push("kind must be image_to_image or image_to_video");
  }
  if (typeof manifest.enabled !== "boolean") errors.push("enabled must be a boolean");
  if (typeof manifest.workflowFile !== "string" || manifest.workflowFile.length === 0) {
    errors.push("workflowFile must be a non-empty relative path");
  } else {
    const normalized = path.normalize(manifest.workflowFile);
    if (path.isAbsolute(normalized) || normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
      errors.push("workflowFile must stay inside WORKFLOW_DIR");
    }
    if (path.basename(normalized) !== path.basename(workflowFilename)) {
      errors.push(`workflowFile basename must match inspected file ${path.basename(workflowFilename)}`);
    }
  }

  if (!isObject(manifest.bindings)) {
    errors.push("bindings must be an object");
    return errors;
  }
  if (manifest.bindings.prompt !== undefined) {
    validateBinding(manifest.bindings.prompt, "bindings.prompt", workflow, errors);
    bindingTargets.push(["bindings.prompt", manifest.bindings.prompt]);
  }
  if (manifest.bindings.negativePrompt !== undefined) {
    validateBinding(manifest.bindings.negativePrompt, "bindings.negativePrompt", workflow, errors);
    bindingTargets.push(["bindings.negativePrompt", manifest.bindings.negativePrompt]);
  }

  if (!isObject(manifest.bindings.assets)) {
    errors.push("bindings.assets must be an object");
  } else {
    for (const [role, binding] of Object.entries(manifest.bindings.assets)) {
      if (!role) errors.push("Asset role must not be empty");
      validateBinding(binding, `bindings.assets.${role}`, workflow, errors);
      bindingTargets.push([`bindings.assets.${role}`, binding]);
      if (isObject(binding) && binding.required !== undefined && typeof binding.required !== "boolean") {
        errors.push(`bindings.assets.${role}.required must be a boolean`);
      }
    }
  }

  if (!isObject(manifest.bindings.parameters)) {
    errors.push("bindings.parameters must be an object");
  } else {
    for (const [name, binding] of Object.entries(manifest.bindings.parameters)) {
      const label = `bindings.parameters.${name}`;
      validateBinding(binding, label, workflow, errors);
      bindingTargets.push([label, binding]);
      if (!isObject(binding)) continue;
      if (!["integer", "number", "string", "boolean"].includes(binding.type)) {
        errors.push(`${label}.type is invalid`);
        continue;
      }
      if (binding.default !== undefined && !valueMatchesType(binding.default, binding.type)) {
        errors.push(`${label}.default does not match type ${binding.type}`);
      }
      if (binding.minimum !== undefined && typeof binding.minimum !== "number") errors.push(`${label}.minimum must be a number`);
      if (binding.maximum !== undefined && typeof binding.maximum !== "number") errors.push(`${label}.maximum must be a number`);
      if (
        !["integer", "number"].includes(binding.type) &&
        (binding.minimum !== undefined || binding.maximum !== undefined)
      ) {
        errors.push(`${label} may only use minimum/maximum with a numeric type`);
      }
      if (typeof binding.minimum === "number" && typeof binding.maximum === "number" && binding.minimum > binding.maximum) {
        errors.push(`${label}.minimum must not exceed maximum`);
      }
      if (typeof binding.default === "number" && typeof binding.minimum === "number" && binding.default < binding.minimum) {
        errors.push(`${label}.default is below minimum`);
      }
      if (typeof binding.default === "number" && typeof binding.maximum === "number" && binding.default > binding.maximum) {
        errors.push(`${label}.default is above maximum`);
      }
      if (binding.enum !== undefined) {
        if (!Array.isArray(binding.enum)) {
          errors.push(`${label}.enum must be an array`);
        } else if (binding.enum.some((value) => !valueMatchesType(value, binding.type))) {
          errors.push(`${label}.enum contains a value that does not match type ${binding.type}`);
        } else if (binding.default !== undefined && !binding.enum.includes(binding.default)) {
          errors.push(`${label}.default is not included in enum`);
        }
      }
    }
  }

  const ownersByTarget = new Map();
  for (const [label, binding] of bindingTargets) {
    if (!isObject(binding) || typeof binding.nodeId !== "string" || typeof binding.input !== "string") continue;
    const target = `${binding.nodeId}.inputs.${binding.input}`;
    const previous = ownersByTarget.get(target);
    if (previous) {
      errors.push(`${label} and ${previous} both write to ${target}`);
    } else {
      ownersByTarget.set(target, label);
    }
  }
  return errors;
}

function usage() {
  process.stderr.write(
    "Usage:\n" +
    "  manifest-tool.mjs inspect <workflow.api.json>\n" +
    "  manifest-tool.mjs validate <workflow.api.json> <manifest.json>\n" +
    "  manifest-tool.mjs write <workflow.api.json> <draft.manifest.json> <output.manifest.json> [--force]\n"
  );
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "inspect" && args.length === 1) {
    const workflow = await readJson(args[0]);
    const report = inspect(workflow, args[0]);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.format !== "api") process.exitCode = 1;
    return;
  }

  if (command === "validate" && args.length === 2) {
    const [workflowFilename, manifestFilename] = args;
    const workflow = await readJson(workflowFilename);
    const manifest = await readJson(manifestFilename);
    const errors = validateManifest(workflow, manifest, workflowFilename);
    if (errors.length > 0) {
      errors.forEach((error) => process.stderr.write(`- ${error}\n`));
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${JSON.stringify({ valid: true, id: manifest.id, workflowFile: manifest.workflowFile })}\n`);
    return;
  }

  if (command === "write" && (args.length === 3 || (args.length === 4 && args[3] === "--force"))) {
    const [workflowFilename, draftFilename, outputFilename] = args;
    const workflow = await readJson(workflowFilename);
    const manifest = await readJson(draftFilename);
    const errors = validateManifest(workflow, manifest, workflowFilename);
    if (errors.length > 0) throw new Error(`Manifest is invalid:\n${errors.map((error) => `- ${error}`).join("\n")}`);
    if (!args.includes("--force")) {
      try {
        await access(outputFilename);
        throw new Error(`Refusing to overwrite existing file ${outputFilename}; pass --force after explicit confirmation`);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    await writeFile(outputFilename, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ written: path.resolve(outputFilename), id: manifest.id })}\n`);
    return;
  }

  usage();
  process.exitCode = 2;
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
