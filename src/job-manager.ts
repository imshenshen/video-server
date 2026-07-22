import { EventEmitter } from "node:events";
import { createReadStream } from "node:fs";
import { copyFile, link, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { AssetClient } from "./asset-client.js";
import { ComfyClient } from "./comfy-client.js";
import { config } from "./config.js";
import { JobStore } from "./job-store.js";
import type { ComfyOutputFile, CreateJobRequest, GenerationJob } from "./types.js";
import { WorkflowRegistry } from "./workflow-registry.js";

function assertWithin(root: string, candidate: string): string {
  const resolved = path.resolve(candidate);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Output path escapes configured root");
  return resolved;
}

export class JobManager extends EventEmitter {
  private readonly queue: string[] = [];
  private readonly jobs = new Map<string, GenerationJob>();
  private readonly active = new Set<string>();
  private stopping = false;

  constructor(
    private readonly registry: WorkflowRegistry,
    private readonly store = new JobStore(),
    private readonly assets = new AssetClient(),
    private readonly comfy = new ComfyClient()
  ) {
    super();
  }

  async initialize(): Promise<void> {
    await Promise.all([this.store.initialize(), mkdir(config.jobTempDir, { recursive: true })]);
    for (const job of await this.store.list()) {
      if (job.status === "running" || job.status === "preparing") {
        job.status = "queued";
        job.error = "Recovered after video-server restart";
        await this.store.save(job);
      }
      this.jobs.set(job.id, job);
      if (job.status === "queued") this.queue.push(job.id);
    }
    for (let index = 0; index < config.concurrency; index += 1) void this.worker();
  }

  async create(request: CreateJobRequest, tenantId: string): Promise<GenerationJob> {
    this.registry.validateRequest(request);
    const job = await this.store.create(request, tenantId);
    this.jobs.set(job.id, job);
    this.queue.push(job.id);
    this.emitJob(job);
    return structuredClone(job);
  }

  get(id: string, tenantId: string): GenerationJob {
    const job = this.jobs.get(id);
    if (!job || job.tenantId !== tenantId) throw new Error("Job not found");
    return structuredClone(job);
  }

  list(tenantId: string): GenerationJob[] {
    return [...this.jobs.values()].filter((job) => job.tenantId === tenantId).map((job) => structuredClone(job));
  }

  async cancel(id: string, tenantId: string): Promise<GenerationJob> {
    const job = this.jobs.get(id);
    if (!job || job.tenantId !== tenantId) throw new Error("Job not found");
    if (["completed", "failed", "cancelled"].includes(job.status)) return structuredClone(job);
    job.status = "cancelled";
    job.completedAt = new Date().toISOString();
    if (job.comfyPromptId) await this.comfy.cancel(job.comfyPromptId);
    await this.persist(job);
    return structuredClone(job);
  }

  stop(): void {
    this.stopping = true;
  }

  private async worker(): Promise<void> {
    while (!this.stopping) {
      const id = this.queue.shift();
      if (!id) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      const job = this.jobs.get(id);
      if (!job || job.status !== "queued") continue;
      this.active.add(id);
      try {
        await this.execute(job);
      } finally {
        this.active.delete(id);
      }
    }
  }

  private async execute(job: GenerationJob): Promise<void> {
    const temporaryDirectory = path.join(config.jobTempDir, job.id);
    try {
      job.status = "preparing";
      delete job.error;
      await this.persist(job);
      await mkdir(temporaryDirectory, { recursive: true });
      const prepared = new Map<string, string>();
      for (const input of job.request.inputs) {
        const source = await this.assets.materialize(input.asset_id, job.tenantId, temporaryDirectory);
        prepared.set(input.role, await this.prepareComfyInput(source, input.role, job.id));
      }
      const workflow = await this.registry.buildWorkflow(job.request, prepared);
      if (this.isCancelled(job.id)) return;
      job.status = "running";
      await this.persist(job);
      const outputs = await this.comfy.runWorkflow(workflow, {
        onQueued: (promptId) => {
          job.comfyPromptId = promptId;
          void this.persist(job);
        },
        onProgress: (progress, node) => {
          job.progress = Math.max(job.progress, Math.min(0.99, progress));
          if (node) job.currentNode = node;
          void this.persist(job);
        }
      });
      if (this.isCancelled(job.id)) return;
      for (const output of outputs) job.outputs.push(await this.registerOutput(output, job.tenantId));
      job.status = "completed";
      job.progress = 1;
      delete job.currentNode;
      job.completedAt = new Date().toISOString();
      await this.persist(job);
    } catch (error) {
      if (job.status !== "cancelled") {
        job.status = "failed";
        job.error = error instanceof Error ? error.message : String(error);
        job.completedAt = new Date().toISOString();
        await this.persist(job);
      }
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
      if (config.comfyInputRoot) {
        const stagedInput = assertWithin(config.comfyInputRoot, path.join(config.comfyInputRoot, "jobs", job.id));
        await rm(stagedInput, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  private async prepareComfyInput(source: string, role: string, jobId: string): Promise<string> {
    if (!config.comfyInputRoot) return this.comfy.uploadInput(source, jobId);
    const extension = path.extname(source).replace(/[^a-zA-Z0-9.]/g, "") || ".bin";
    const relative = path.posix.join("jobs", jobId, `${role}${extension}`);
    const destination = assertWithin(config.comfyInputRoot, path.join(config.comfyInputRoot, relative));
    await mkdir(path.dirname(destination), { recursive: true });
    await link(source, destination).catch(async () => copyFile(source, destination));
    return relative;
  }

  private async registerOutput(output: ComfyOutputFile, tenantId: string) {
    if (config.comfyOutputRoot) {
      const source = assertWithin(config.comfyOutputRoot, path.join(config.comfyOutputRoot, output.subfolder, output.filename));
      return this.assets.importLocal(source, output.filename, tenantId);
    }
    const downloaded = await this.comfy.downloadOutput(output);
    return this.assets.uploadStream(downloaded.stream, output.filename, downloaded.mimeType, tenantId);
  }

  private async persist(job: GenerationJob): Promise<void> {
    await this.store.save(job);
    this.emitJob(job);
  }

  private isCancelled(id: string): boolean {
    return this.jobs.get(id)?.status === "cancelled";
  }

  private emitJob(job: GenerationJob): void {
    this.emit(`job:${job.id}`, structuredClone(job));
    this.emit("job", structuredClone(job));
  }
}
