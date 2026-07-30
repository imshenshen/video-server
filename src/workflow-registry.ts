import { randomInt } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { config } from "./config.js";
import type { CreateJobRequest, NodeBinding, ParameterBinding, PresetBinding, ResolvedWorkflowSettings, WorkflowManifest } from "./types.js";

const nodeBindingSchema = z.object({ nodeId: z.string().min(1), input: z.string().min(1) });
const parameterBindingSchema = nodeBindingSchema.extend({
  type: z.enum(["integer", "number", "string", "boolean"]),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  enum: z.array(z.union([z.string(), z.number(), z.boolean()])).optional()
});
const presetValueSchema = z.union([z.string(), z.number(), z.boolean()]);
const presetBindingSchema = z.object({
  default: z.string().optional(),
  options: z.record(z.object({
    label: z.string().optional(),
    description: z.string().optional(),
    promptPrefix: z.string().optional(),
    promptSuffix: z.string().optional(),
    overrides: z.array(nodeBindingSchema.extend({ value: presetValueSchema }))
  }))
}).superRefine((preset, ctx) => {
  if (preset.default !== undefined && preset.options[preset.default] === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "default must reference a preset option", path: ["default"] });
  }
});
export const manifestSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_.-]+$/),
  name: z.string().min(1),
  description: z.string().optional(),
  kind: z.enum(["text_to_image", "image_to_image", "image_to_video"]),
  enabled: z.boolean().default(true),
  allowedTenants: z.array(z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/)).min(1),
  workflowFile: z.string().min(1),
  bindings: z.object({
    prompt: nodeBindingSchema.optional(),
    negativePrompt: nodeBindingSchema.optional(),
    assets: z.record(nodeBindingSchema.extend({ required: z.boolean().optional() })),
    randomSeeds: z.array(nodeBindingSchema).default([]),
    parameters: z.record(parameterBindingSchema).default({})
  }),
  presets: z.record(presetBindingSchema).default({})
});

export function parseWorkflowManifest(value: unknown): WorkflowManifest {
  return manifestSchema.parse(value) as WorkflowManifest;
}

function setInput(workflow: Record<string, unknown>, binding: NodeBinding, value: unknown): void {
  const node = workflow[binding.nodeId];
  if (!node || typeof node !== "object") throw new Error(`Workflow node ${binding.nodeId} does not exist`);
  const inputs = (node as Record<string, unknown>).inputs;
  if (!inputs || typeof inputs !== "object") throw new Error(`Workflow node ${binding.nodeId} has no inputs`);
  (inputs as Record<string, unknown>)[binding.input] = value;
}

function getInput(workflow: Record<string, unknown>, binding: NodeBinding): unknown {
  const node = workflow[binding.nodeId];
  if (!node || typeof node !== "object") throw new Error(`Workflow node  does not exist`);
  const inputs = (node as Record<string, unknown>).inputs;
  if (!inputs || typeof inputs !== "object") throw new Error(`Workflow node  has no inputs`);
  return (inputs as Record<string, unknown>)[binding.input];
}

function randomSeed(): number {
  const radix = 2 ** 24;
  return randomInt(radix) * radix + randomInt(radix);
}

function validateParameter(name: string, value: unknown, binding: ParameterBinding): unknown {
  if (binding.type === "integer" && (!Number.isInteger(value) || typeof value !== "number")) {
    throw new Error(`Parameter ${name} must be an integer`);
  }
  if (binding.type === "number" && typeof value !== "number") throw new Error(`Parameter ${name} must be a number`);
  if (binding.type === "string" && typeof value !== "string") throw new Error(`Parameter ${name} must be a string`);
  if (binding.type === "boolean" && typeof value !== "boolean") throw new Error(`Parameter ${name} must be a boolean`);
  if (typeof value === "number") {
    if (binding.minimum !== undefined && value < binding.minimum) throw new Error(`Parameter ${name} is below minimum`);
    if (binding.maximum !== undefined && value > binding.maximum) throw new Error(`Parameter ${name} is above maximum`);
  }
  if (binding.enum && !binding.enum.includes(value as never)) throw new Error(`Parameter ${name} is not allowed`);
  return value;
}

function selectedPreset(name: string, value: unknown, binding: PresetBinding) {
  if (typeof value !== "string") throw new Error(`Preset ${name} must be a string`);
  const option = binding.options[value];
  if (!option) throw new Error(`Unknown ${name} preset: ${value}`);
  return option;
}

export class WorkflowRegistry {
  private readonly manifests = new Map<string, WorkflowManifest>();

  constructor(
    private readonly workflowDir = config.workflowDir,
    private readonly manifestDir = config.manifestDir
  ) {}

  async load(): Promise<void> {
    this.manifests.clear();
    const entries = await readdir(this.manifestDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".manifest.json")) continue;
      const data = JSON.parse(await readFile(path.join(this.manifestDir, entry.name), "utf8"));
      const manifest = parseWorkflowManifest(data);
      if (!manifest.enabled) continue;
      if (this.manifests.has(manifest.id)) throw new Error(`Duplicate workflow ID: ${manifest.id}`);
      this.assertWorkflowPath(manifest.workflowFile);
      this.manifests.set(manifest.id, manifest);
    }
  }

  list(): WorkflowManifest[] {
    return [...this.manifests.values()];
  }

  capabilities(tenantId: string): unknown[] {
    return this.list().filter((manifest) => manifest.allowedTenants.includes(tenantId)).map((manifest) => ({
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      kind: manifest.kind,
      asset_inputs: Object.entries(manifest.bindings.assets).map(([role, binding]) => ({
        role,
        required: binding.required ?? false
      })),
      parameters: Object.fromEntries([
        ...Object.entries(manifest.bindings.parameters).map(([name, binding]) => [
          name,
          {
            type: binding.type,
            default: binding.default,
            minimum: binding.minimum,
            maximum: binding.maximum,
            enum: binding.enum
          }
        ] as const),
        ...Object.entries(manifest.presets).map(([name, preset]) => [
          name,
          {
            type: "string",
            default: preset.default,
            enum: Object.keys(preset.options),
            options: Object.fromEntries(Object.entries(preset.options).map(([id, option]) => [
              id,
              { label: option.label, description: option.description }
            ]))
          }
        ] as const)
      ])
    }));
  }

  get(id: string, tenantId: string): WorkflowManifest {
    const manifest = this.manifests.get(id);
    if (!manifest || !manifest.allowedTenants.includes(tenantId)) throw new Error(`Unknown or disabled workflow: ${id}`);
    return manifest;
  }

  validateRequest(request: CreateJobRequest, tenantId: string): WorkflowManifest {
    const manifest = this.get(request.workflow_id, tenantId);
    const roles = request.inputs.map((input) => input.role);
    if (new Set(roles).size !== roles.length) throw new Error("Each asset role may only be supplied once");
    const byRole = new Map(request.inputs.map((input) => [input.role, input]));
    for (const [role, binding] of Object.entries(manifest.bindings.assets)) {
      if (binding.required && !byRole.has(role)) throw new Error(`Workflow requires asset role: ${role}`);
    }
    for (const input of request.inputs) {
      if (Boolean(input.asset_id) === Boolean(input.media_ref)) {
        throw new Error(`Workflow input ${input.role} must provide exactly one media reference`);
      }
      if (!manifest.bindings.assets[input.role]) throw new Error(`Workflow does not accept asset role: ${input.role}`);
    }
    for (const [parameter, value] of Object.entries(request.parameters ?? {})) {
      const preset = manifest.presets[parameter];
      if (!manifest.bindings.parameters[parameter] && !preset) {
        throw new Error(`Unknown workflow parameter: ${parameter}`);
      }
      if (preset) selectedPreset(parameter, value, preset);
    }
    return manifest;
  }

  async buildWorkflow(
    request: CreateJobRequest,
    preparedAssets: ReadonlyMap<string, string>,
    tenantId: string
  ): Promise<Record<string, unknown>> {
    return (await this.buildWorkflowPlan(request, preparedAssets, tenantId)).workflow;
  }

  async buildWorkflowPlan(
    request: CreateJobRequest,
    preparedAssets: ReadonlyMap<string, string>,
    tenantId: string
  ): Promise<{ workflow: Record<string, unknown>; resolvedSettings: ResolvedWorkflowSettings }> {
    const manifest = this.validateRequest(request, tenantId);
    const filePath = this.assertWorkflowPath(manifest.workflowFile);
    const workflow = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    const presets: Record<string, string> = {};
    const parameters: Record<string, unknown> = {};
    const randomSeeds: ResolvedWorkflowSettings["randomSeeds"] = [];
    const presetOverrides: ResolvedWorkflowSettings["presetOverrides"] = [];
    let prompt = request.prompt;
    for (const [name, binding] of Object.entries(manifest.presets)) {
      const requested = request.parameters?.[name] ?? binding.default;
      if (requested === undefined) continue;
      const preset = selectedPreset(name, requested, binding);
      presets[name] = requested as string;
      prompt = `${preset.promptPrefix ?? ""}${prompt}${preset.promptSuffix ?? ""}`;
      for (const override of preset.overrides) {
        setInput(workflow, override, override.value);
        presetOverrides.push({ preset: name, option: requested as string, ...override });
      }
    }
    if (manifest.bindings.prompt) setInput(workflow, manifest.bindings.prompt, prompt);
    if (manifest.bindings.negativePrompt && request.negative_prompt !== undefined) {
      setInput(workflow, manifest.bindings.negativePrompt, request.negative_prompt);
    }
    for (const [role, value] of preparedAssets) {
      const binding = manifest.bindings.assets[role];
      if (!binding) throw new Error(`No binding for asset role: ${role}`);
      setInput(workflow, binding, value);
    }
    for (const binding of manifest.bindings.randomSeeds) {
      const value = randomSeed();
      setInput(workflow, binding, value);
      randomSeeds.push({ ...binding, value });
    }
    for (const [name, value] of Object.entries(request.parameters ?? {})) {
      const binding = manifest.bindings.parameters[name];
      if (!binding) continue;
      setInput(workflow, binding, validateParameter(name, value, binding));
    }
    for (const [name, binding] of Object.entries(manifest.bindings.parameters)) {
      parameters[name] = getInput(workflow, binding);
    }
    return {
      workflow,
      resolvedSettings: { effectivePrompt: prompt, presets, parameters, randomSeeds, presetOverrides }
    };
  }

  private assertWorkflowPath(filename: string): string {
    const filePath = path.resolve(this.workflowDir, filename);
    const relative = path.relative(this.workflowDir, filePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Workflow file escapes WORKFLOW_DIR");
    return filePath;
  }
}
