import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import type { CreateJobRequest, GenerationJob } from "./types.js";

export class JobStore {
  private readonly saveChains = new Map<string, Promise<void>>();

  async initialize(): Promise<void> {
    await mkdir(config.jobDataDir, { recursive: true });
  }

  async create(request: CreateJobRequest, tenantId: string): Promise<GenerationJob> {
    const now = new Date().toISOString();
    const job: GenerationJob = {
      id: `job_${randomUUID().replaceAll("-", "")}`,
      tenantId,
      workflowId: request.workflow_id,
      request,
      status: "queued",
      progress: 0,
      outputs: [],
      createdAt: now,
      updatedAt: now
    };
    await this.save(job);
    return job;
  }

  async save(job: GenerationJob): Promise<void> {
    job.updatedAt = new Date().toISOString();
    const snapshot = JSON.stringify(job, null, 2);
    const previous = this.saveChains.get(job.id) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      const destination = path.join(config.jobDataDir, `${job.id}.json`);
      const temporary = `${destination}.${randomUUID()}.tmp`;
      await writeFile(temporary, snapshot, { flag: "wx" });
      await rename(temporary, destination);
    });
    this.saveChains.set(job.id, operation);
    try {
      await operation;
    } finally {
      if (this.saveChains.get(job.id) === operation) this.saveChains.delete(job.id);
    }
  }

  async get(id: string): Promise<GenerationJob> {
    if (!/^job_[a-f0-9]{32}$/.test(id)) throw new Error("Invalid job ID");
    return JSON.parse(await readFile(path.join(config.jobDataDir, `${id}.json`), "utf8")) as GenerationJob;
  }

  async list(): Promise<GenerationJob[]> {
    const entries = await readdir(config.jobDataDir);
    const jobs = await Promise.all(
      entries.filter((entry) => entry.endsWith(".json")).map((entry) => readFile(path.join(config.jobDataDir, entry), "utf8"))
    );
    return jobs.map((data) => JSON.parse(data) as GenerationJob).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}
