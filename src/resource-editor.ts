import { readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { WorkflowRegistry } from "./workflow-registry.js";
import { parseWorkflowManifest } from "./workflow-registry.js";

export const resourceKindSchema = z.enum(["manifest", "comfyapi"]);
export type ResourceKind = z.infer<typeof resourceKindSchema>;
const filenameSchema = z.string().min(1).max(255).refine(
  (name) => path.basename(name) === name && !name.includes("\0"), "Invalid resource filename"
);
const suffix = (kind: ResourceKind): string => kind === "manifest" ? ".manifest.json" : ".api.json";

function validateComfyApi(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ComfyAPI workflow must be a JSON object");
  for (const [nodeId, node] of Object.entries(value)) {
    if (!node || typeof node !== "object" || Array.isArray(node)) throw new Error(`Node ${nodeId} must be an object`);
    const record = node as Record<string, unknown>;
    if (typeof record.class_type !== "string" || !record.class_type) throw new Error(`Node ${nodeId} requires class_type`);
    if (!record.inputs || typeof record.inputs !== "object" || Array.isArray(record.inputs)) throw new Error(`Node ${nodeId} requires an inputs object`);
  }
  return value as Record<string, unknown>;
}

export class ResourceEditor {
  constructor(private readonly workflowDir: string, private readonly manifestDir: string, private readonly registry: WorkflowRegistry) {}
  async list(): Promise<Array<{ kind: ResourceKind; filename: string }>> {
    const groups = await Promise.all((["manifest", "comfyapi"] as const).map(async (kind) =>
      (await readdir(this.directory(kind), { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith(suffix(kind)))
        .map((entry) => ({ kind, filename: entry.name }))
    ));
    return groups.flat().sort((a, b) => a.kind.localeCompare(b.kind) || a.filename.localeCompare(b.filename));
  }
  async read(kind: ResourceKind, filename: string): Promise<unknown> {
    return JSON.parse(await readFile(this.resolve(kind, filename), "utf8"));
  }
  async save(kind: ResourceKind, filename: string, value: unknown): Promise<void> {
    const validated = kind === "manifest" ? parseWorkflowManifest(value) : validateComfyApi(value);
    const target = this.resolve(kind, filename);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    const previous = await readFile(target, "utf8");
    await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { encoding: "utf8", mode: 0o640 });
    await rename(temporary, target);
    if (kind !== "manifest") return;
    try { await this.registry.load(); }
    catch (error) {
      await writeFile(temporary, previous, { encoding: "utf8", mode: 0o640 });
      await rename(temporary, target);
      await this.registry.load();
      throw error;
    } finally { await unlink(temporary).catch(() => undefined); }
  }
  private directory(kind: ResourceKind): string { return kind === "manifest" ? this.manifestDir : this.workflowDir; }
  private resolve(kind: ResourceKind, filename: string): string {
    const safeName = filenameSchema.parse(filename);
    if (!safeName.endsWith(suffix(kind))) throw new Error(`Filename must end with ${suffix(kind)}`);
    return path.join(this.directory(kind), safeName);
  }
}
