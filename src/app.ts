import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth, tenantId } from "./auth.js";
import { AssetClient } from "./asset-client.js";
import { config } from "./config.js";
import { demoPage } from "./demo-page.js";
import { JobManager } from "./job-manager.js";
import { handleMcpRequest } from "./mcp.js";
import { logMcpRequest } from "./request-log.js";
import { ResourceEditor, resourceKindSchema } from "./resource-editor.js";
import { verifyAssetAccessToken } from "./signed-asset-url.js";
import { webhookCallbackSchema } from "./webhook-callback.js";
import { WorkflowRegistry } from "./workflow-registry.js";

const createJobSchema = z.object({
  workflow_id: z.string().min(1),
  inputs: z.array(z.object({
    asset_id: z.string().min(1).optional(),
    media_ref: z.string().min(1).optional(),
    role: z.string().min(1)
  }).refine((value) => Boolean(value.asset_id) !== Boolean(value.media_ref), {
    message: "Provide exactly one of asset_id or media_ref"
  })),
  prompt: z.string(),
  negative_prompt: z.string().optional(),
  parameters: z.record(z.unknown()).optional(),
  callback: webhookCallbackSchema.optional()
});

export async function createApp(): Promise<{ app: express.Express; manager: JobManager }> {
  const registry = new WorkflowRegistry();
  await registry.load();
  const manager = new JobManager(registry);
  await manager.initialize();
  const app = express();
  const assetClient = new AssetClient();
  const resourceEditor = new ResourceEditor(config.workflowDir, config.manifestDir, registry);
  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));
  app.get("/healthz", (_req, res) => res.json({ status: "ok", workflows: registry.list().length }));

  app.get("/demo", (_req, res) => {
    res.setHeader(
      "content-security-policy",
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
    );
    res.setHeader("cache-control", "no-store");
    res.type("html").send(demoPage);
  });

  app.get("/assets/:id/signed-content", async (req, res, next) => {
    if (!config.assetUrlSigningSecret) {
      res.status(503).json({ error: "Signed asset URLs are not configured" });
      return;
    }
    const assetId = String(req.params.id);
    let access;
    try {
      const token = z.string().min(1).parse(req.query.token);
      access = verifyAssetAccessToken(token, assetId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid asset access token";
      res.status(403).json({ error: message });
      return;
    }
    try {
      const content = await assetClient.downloadContent(assetId, access.tenantId);
      res.setHeader("content-type", content.contentType);
      res.setHeader("content-disposition", "inline");
      res.setHeader("cache-control", `private, max-age=${Math.max(0, access.expiresAt - Math.floor(Date.now() / 1000))}`);
      res.setHeader("x-content-type-options", "nosniff");
      if (content.contentLength) res.setHeader("content-length", content.contentLength);
      content.stream.on("error", next);
      content.stream.pipe(res);
    } catch (error) {
      next(error);
    }
  });

  app.use(requireAuth);
  app.get("/session", (req, res) =>
    res.json({ tenant_id: tenantId(req), tenant_header_enabled: config.apiUsers.length === 0 })
  );
  app.get("/workflows", (req, res) => res.json({ workflows: registry.capabilities(tenantId(req)) }));
  app.get("/resources", async (_req, res, next) => {
    try { res.json({ resources: await resourceEditor.list() }); } catch (error) { next(error); }
  });
  app.get("/resources/:kind/:filename", async (req, res, next) => {
    try {
      const kind = resourceKindSchema.parse(req.params.kind);
      const filename = String(req.params.filename);
      res.json({ kind, filename, content: await resourceEditor.read(kind, filename) });
    } catch (error) { next(error); }
  });
  app.put("/resources/:kind/:filename", async (req, res, next) => {
    try {
      const kind = resourceKindSchema.parse(req.params.kind);
      const filename = String(req.params.filename);
      await resourceEditor.save(kind, filename, req.body);
      res.json({ ok: true, kind, filename });
    } catch (error) { next(error); }
  });
  app.get("/assets/:id/content", async (req, res, next) => {
    try {
      const assetId = z.string().regex(/^(?:asset_[a-f0-9]{32}|res_[A-Za-z0-9-]+)$/).parse(String(req.params.id));
      const content = await assetClient.downloadContent(assetId, tenantId(req));
      res.setHeader("content-type", content.contentType);
      res.setHeader("content-disposition", "inline");
      res.setHeader("cache-control", "private, no-store");
      if (content.contentLength) res.setHeader("content-length", content.contentLength);
      content.stream.on("error", next);
      content.stream.pipe(res);
    } catch (error) { next(error); }
  });
  app.get("/jobs", (req, res) => res.json({ jobs: manager.list(tenantId(req)) }));
  app.post("/jobs", async (req, res, next) => {
    try {
      res.status(202).json(await manager.create(createJobSchema.parse(req.body), tenantId(req)));
    } catch (error) {
      next(error);
    }
  });
  app.get("/jobs/:id/outputs/:index/content", async (req, res, next) => {
    try {
      const job = manager.get(String(req.params.id), tenantId(req));
      const index = z.coerce.number().int().min(0).parse(req.params.index);
      const output = job.outputs[index];
      if (!output) {
        res.status(404).json({ error: "Job output not found" });
        return;
      }
      const reference = output.asset_id ?? output.resource_id ?? output.uri;
      if (!reference) throw new Error("Job output has no downloadable reference");
      const content = await assetClient.downloadContent(reference, tenantId(req));
      res.setHeader("content-type", content.contentType);
      res.setHeader("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(output.original_name || "output")}`);
      res.setHeader("cache-control", "private, no-store");
      res.setHeader("x-content-type-options", "nosniff");
      if (content.contentLength) res.setHeader("content-length", content.contentLength);
      content.stream.on("error", next);
      content.stream.pipe(res);
    } catch (error) { next(error); }
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
      const tenant = tenantId(req);
      logMcpRequest(req, res, tenant);
      await handleMcpRequest(req, res, manager, registry, tenant);
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
