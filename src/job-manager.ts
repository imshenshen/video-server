import { EventEmitter } from "node:events";
import { createReadStream } from "node:fs";
import { copyFile, link, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { AssetClient } from "./asset-client.js";
import { ComfyClient } from "./comfy-client.js";
import { config } from "./config.js";
import { JobStore } from "./job-store.js";
import type { ComfyOutputFile, CreateJobRequest, GenerationJob } from "./types.js";
import { publicGenerationJob, WebhookCallbackClient } from "./webhook-callback.js";
import { WorkflowRegistry } from "./workflow-registry.js";

const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled"]);

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
  private readonly webhookTimers = new Map<string, NodeJS.Timeout>();
  private readonly webhookDeliveries = new Set<string>();
  private stopping = false;

  constructor(
    private readonly registry: WorkflowRegistry,
    private readonly store = new JobStore(),
    private readonly assets = new AssetClient(),
    private readonly comfy = new ComfyClient(),
    private readonly webhooks = new WebhookCallbackClient(undefined, config.webhookTimeoutMs)
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
      if (TERMINAL_JOB_STATUSES.has(job.status)) this.scheduleWebhookCallback(job);
    }
    for (let index = 0; index < config.concurrency; index += 1) void this.worker();
  }

  async create(request: CreateJobRequest, tenantId: string): Promise<GenerationJob> {
    this.registry.validateRequest(request, tenantId);
    const job = await this.store.create(request, tenantId);
    this.jobs.set(job.id, job);
    this.queue.push(job.id);
    this.emitJob(job);
    return publicGenerationJob(job);
  }

  get(id: string, tenantId: string): GenerationJob {
    const job = this.jobs.get(id);
    if (!job || job.tenantId !== tenantId) throw new Error("Job not found");
    return publicGenerationJob(job);
  }

  list(tenantId: string): GenerationJob[] {
    return [...this.jobs.values()]
      .filter((job) => job.tenantId === tenantId)
      .map((job) => publicGenerationJob(job));
  }

  async cancel(id: string, tenantId: string): Promise<GenerationJob> {
    const job = this.jobs.get(id);
    if (!job || job.tenantId !== tenantId) throw new Error("Job not found");
    if (TERMINAL_JOB_STATUSES.has(job.status)) return publicGenerationJob(job);
    job.status = "cancelled";
    job.completedAt = new Date().toISOString();
    if (job.comfyPromptId) await this.comfy.cancel(job.comfyPromptId);
    await this.persist(job);
    this.scheduleWebhookCallback(job);
    return publicGenerationJob(job);
  }

  stop(): void {
    this.stopping = true;
    for (const timer of this.webhookTimers.values()) clearTimeout(timer);
    this.webhookTimers.clear();
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
        const mediaRef = input.media_ref ?? input.asset_id;
        if (!mediaRef) throw new Error(`Missing media reference for role ${input.role}`);
        const source = await this.assets.materialize(mediaRef, job.tenantId, temporaryDirectory);
        prepared.set(input.role, await this.prepareComfyInput(source, input.role, job.id));
      }
      const { workflow, resolvedSettings } = await this.registry.buildWorkflowPlan(job.request, prepared, job.tenantId);
      job.resolvedSettings = resolvedSettings;
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
      for (const output of outputs) job.outputs.push(await this.registerOutput(output, job.tenantId, job.id));
      job.status = "completed";
      job.progress = 1;
      delete job.currentNode;
      job.completedAt = new Date().toISOString();
      await this.persist(job);
      this.scheduleWebhookCallback(job);
    } catch (error) {
      if (job.status !== "cancelled") {
        job.status = "failed";
        job.error = error instanceof Error ? error.message : String(error);
        job.completedAt = new Date().toISOString();
        await this.persist(job);
        this.scheduleWebhookCallback(job);
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

  private async registerOutput(output: ComfyOutputFile, tenantId: string, jobId: string) {
    if (config.comfyOutputRoot) {
      const source = assertWithin(config.comfyOutputRoot, path.join(config.comfyOutputRoot, output.subfolder, output.filename));
      return this.assets.importLocal(source, output.filename, tenantId, jobId);
    }
    const downloaded = await this.comfy.downloadOutput(output);
    return this.assets.uploadStream(downloaded.stream, output.filename, downloaded.mimeType, tenantId, jobId);
  }

  private async persist(job: GenerationJob): Promise<void> {
    await this.store.save(job);
    this.emitJob(job);
  }

  private isCancelled(id: string): boolean {
    return this.jobs.get(id)?.status === "cancelled";
  }

  private scheduleWebhookCallback(job: GenerationJob): void {
    const callback = job.webhookCallback;
    if (
      this.stopping ||
      !callback ||
      callback.deliveryStatus === "delivered" ||
      callback.deliveryStatus === "failed" ||
      !TERMINAL_JOB_STATUSES.has(job.status) ||
      this.webhookTimers.has(job.id) ||
      this.webhookDeliveries.has(job.id)
    ) {
      return;
    }
    const nextAttemptAt = Date.parse(callback.nextAttemptAt ?? "");
    const delay = Number.isFinite(nextAttemptAt)
      ? Math.max(0, nextAttemptAt - Date.now())
      : 0;
    const timer = setTimeout(() => {
      this.webhookTimers.delete(job.id);
      void this.deliverWebhookCallback(job.id);
    }, delay);
    timer.unref();
    this.webhookTimers.set(job.id, timer);
  }

  private async deliverWebhookCallback(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    const callback = job?.webhookCallback;
    if (
      this.stopping ||
      !job ||
      !callback ||
      callback.deliveryStatus === "delivered" ||
      callback.deliveryStatus === "failed" ||
      this.webhookDeliveries.has(jobId)
    ) {
      return;
    }
    this.webhookDeliveries.add(jobId);
    callback.deliveryStatus = "delivering";
    callback.attempts += 1;
    delete callback.nextAttemptAt;
    delete callback.lastError;
    try {
      await this.persist(job);
      await this.webhooks.deliver(job);
      callback.deliveryStatus = "delivered";
      callback.deliveredAt = new Date().toISOString();
      delete callback.lastError;
    } catch (error) {
      callback.lastError = error instanceof Error ? error.message : String(error);
      if (callback.attempts >= config.webhookMaxAttempts) {
        callback.deliveryStatus = "failed";
      } else {
        callback.deliveryStatus = "retrying";
        const retryDelay = Math.min(
          config.webhookRetryBaseMs * (2 ** Math.max(0, callback.attempts - 1)),
          60_000
        );
        callback.nextAttemptAt = new Date(Date.now() + retryDelay).toISOString();
      }
    } finally {
      try {
        await this.persist(job);
      } finally {
        this.webhookDeliveries.delete(jobId);
        if (callback.deliveryStatus === "retrying") this.scheduleWebhookCallback(job);
      }
    }
  }

  private emitJob(job: GenerationJob): void {
    const publicJob = publicGenerationJob(job);
    this.emit(`job:${job.id}`, publicJob);
    this.emit("job", publicJob);
  }
}
