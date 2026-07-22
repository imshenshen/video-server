import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth, tenantId } from "./auth.js";
import { JobManager } from "./job-manager.js";
import { handleMcpRequest } from "./mcp.js";
import { WorkflowRegistry } from "./workflow-registry.js";

const createJobSchema = z.object({
  workflow_id: z.string().min(1),
  inputs: z.array(z.object({ asset_id: z.string().min(1), role: z.string().min(1) })),
  prompt: z.string(),
  negative_prompt: z.string().optional(),
  parameters: z.record(z.unknown()).optional()
});

export async function createApp(): Promise<{ app: express.Express; manager: JobManager }> {
  const registry = new WorkflowRegistry();
  await registry.load();
  const manager = new JobManager(registry);
  await manager.initialize();
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));
  app.get("/healthz", (_req, res) => res.json({ status: "ok", workflows: registry.list().length }));

  app.use(requireAuth);
  app.get("/workflows", (_req, res) => res.json({ workflows: registry.capabilities() }));
  app.get("/jobs", (req, res) => res.json({ jobs: manager.list(tenantId(req)) }));
  app.post("/jobs", async (req, res, next) => {
    try {
      res.status(202).json(await manager.create(createJobSchema.parse(req.body), tenantId(req)));
    } catch (error) {
      next(error);
    }
  });
  app.get("/jobs/:id", (req, res, next) => {
    try {
      res.json(manager.get(String(req.params.id), tenantId(req)));
    } catch (error) {
      next(error);
    }
  });
  app.post("/jobs/:id/cancel", async (req, res, next) => {
    try {
      res.json(await manager.cancel(String(req.params.id), tenantId(req)));
    } catch (error) {
      next(error);
    }
  });
  app.get("/jobs/:id/events", (req, res, next) => {
    try {
      const tenant = tenantId(req);
      const jobId = String(req.params.id);
      manager.get(jobId, tenant);
      res.setHeader("content-type", "text/event-stream");
      res.setHeader("cache-control", "no-cache");
      res.setHeader("connection", "keep-alive");
      const send = (job: unknown): void => {
        res.write(`event: job\ndata: ${JSON.stringify(job)}\n\n`);
      };
      send(manager.get(jobId, tenant));
      const eventName = `job:${jobId}`;
      const listener = (job: { tenantId: string }): void => {
        if (job.tenantId === tenant) send(job);
      };
      manager.on(eventName, listener);
      const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
      req.on("close", () => {
        clearInterval(heartbeat);
        manager.off(eventName, listener);
      });
    } catch (error) {
      next(error);
    }
  });
  app.all("/mcp", async (req, res, next) => {
    if (req.method !== "POST") {
      res.status(405).setHeader("allow", "POST").end();
      return;
    }
    try {
      await handleMcpRequest(req, res, manager, registry, tenantId(req));
    } catch (error) {
      next(error);
    }
  });
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = error instanceof Error ? error.message : "Internal server error";
    res.status(/not found/i.test(message) ? 404 : 400).json({ error: message });
  });
  return { app, manager };
}
