import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { AssetClient } from "./asset-client.js";
import type { JobManager } from "./job-manager.js";
import { canCreateSignedAssetLinks, createSignedAssetLink } from "./signed-asset-url.js";
import type { GenerationJob } from "./types.js";
import type { WorkflowRegistry } from "./workflow-registry.js";

const inputSchema = {
  workflow_id: z.string().describe("Workflow ID returned by list_media_workflows"),
  inputs: z.array(z.object({ asset_id: z.string(), role: z.string() })),
  prompt: z.string(),
  negative_prompt: z.string().optional(),
  parameters: z.record(z.unknown()).optional().describe("Only include parameters explicitly exposed by the selected workflow and explicitly requested by the user")
};

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function jobWithPreviewUrls(job: GenerationJob, tenantId: string): GenerationJob | (GenerationJob & { outputs: Array<GenerationJob["outputs"][number] & { preview_url: string; expires_at: string }> }) {
  if (!canCreateSignedAssetLinks()) return job;
  return {
    ...job,
    outputs: job.outputs.map((output) => ({
      ...output,
      ...createSignedAssetLink(output.asset_id, tenantId)
    }))
  };
}

function createServer(manager: JobManager, registry: WorkflowRegistry, tenantId: string): McpServer {
  const assets = new AssetClient();
  const server = new McpServer(
    { name: "spark-video-server", version: "0.1.0" },
    {
      instructions:
        "Call list_media_workflows before creating a job. Use only asset IDs supplied by the user. Generation is asynchronous; create_media_job returns a job ID immediately. Completed jobs include short-lived preview_url values when configured. Use those URLs in Markdown to display media. Call get_media_asset only to verify access or refresh an expired URL. Never use asset:// URIs and never request or embed asset data as base64."
    }
  );
  server.registerTool(
    "list_media_workflows",
    { title: "List media workflows", description: "List enabled text-to-image, image-to-image, and image-to-video workflows" },
    async () => text(registry.capabilities(tenantId))
  );
  server.registerTool(
    "create_media_job",
    {
      title: "Create media generation job",
      description: "Start an asynchronous ComfyUI workflow using existing asset IDs",
      inputSchema
    },
    async (args) => text(await manager.create(args, tenantId))
  );
  server.registerTool(
    "get_media_job",
    {
      title: "Get media job",
      description: "Get generation status, output asset IDs, and short-lived preview URLs",
      inputSchema: { job_id: z.string() }
    },
    async ({ job_id }) => text(jobWithPreviewUrls(manager.get(job_id, tenantId), tenantId))
  );
  server.registerTool(
    "get_media_asset",
    {
      title: "Get media preview URL",
      description: "Verify access to an asset and return a short-lived signed URL. Returns no base64 or binary data.",
      inputSchema: { asset_id: z.string() }
    },
    async ({ asset_id }) => {
      const link = createSignedAssetLink(asset_id, tenantId);
      const metadata = await assets.getMetadata(asset_id, tenantId);
      const result = {
        asset_id,
        mime_type: metadata.mime_type,
        original_name: metadata.original_name,
        size: metadata.size,
        ...link
      };
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result) },
          {
            type: "resource_link" as const,
            uri: link.preview_url,
            name: metadata.original_name || asset_id,
            description: "Short-lived signed media preview URL",
            mimeType: metadata.mime_type
          }
        ]
      };
    }
  );
  server.registerTool(
    "cancel_media_job",
    {
      title: "Cancel media job",
      description: "Cancel a queued or running media generation job",
      inputSchema: { job_id: z.string() }
    },
    async ({ job_id }) => text(await manager.cancel(job_id, tenantId))
  );
  return server;
}

export async function handleMcpRequest(
  req: Request,
  res: Response,
  manager: JobManager,
  registry: WorkflowRegistry,
  tenantId: string
): Promise<void> {
  const server = createServer(manager, registry, tenantId);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
