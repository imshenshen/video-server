import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { AssetClient } from "./asset-client.js";
import { config } from "./config.js";
import type { JobManager } from "./job-manager.js";
import { canCreateSignedAssetLinks, createSignedAssetLink } from "./signed-asset-url.js";
import type { GenerationJob } from "./types.js";
import type { WorkflowRegistry } from "./workflow-registry.js";

const mediaInputSchema = z.object({
  asset_id: z.string().min(1).optional(),
  media_ref: z.string().min(1).optional(),
  role: z.string().min(1)
}).refine((value) => Boolean(value.asset_id) !== Boolean(value.media_ref), {
  message: "Provide exactly one of asset_id or media_ref"
});

function createInputSchema(workflows: unknown[]) {
  const ids = workflows.map((workflow) => (workflow as { id: string }).id);
  return {
    workflow_id: z.string().describe("Workflow ID. Available values: " + ids.join(", ")),
    inputs: z.array(mediaInputSchema),
    prompt: z.string(),
    negative_prompt: z.string().optional(),
    parameters: z.record(z.unknown()).optional().describe("Only include parameters exposed by the selected workflow and explicitly requested by the user; omit them to use defaults")
  };
}

export function createWorkflowToolDescription(workflows: unknown[]): string {
  return "Start an asynchronous ComfyUI workflow using existing media references. Tenant-scoped workflow catalog: " + JSON.stringify(workflows);
}

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function jobWithPreviewUrls(job: GenerationJob, tenantId: string) {
  if (!canCreateSignedAssetLinks()) return job;
  return {
    ...job,
    outputs: job.outputs.map((output) => output.asset_id
      ? { ...output, ...createSignedAssetLink(output.asset_id, tenantId) }
      : output)
  };
}

function createServer(manager: JobManager, registry: WorkflowRegistry, tenantId: string): McpServer {
  const assets = new AssetClient();
  const workflows = registry.capabilities(tenantId);
  const server = new McpServer(
    { name: "spark-video-server", version: "0.1.0" },
    {
      instructions:
        "The create_media_job tool description contains the complete tenant-scoped workflow catalog; call it directly without a separate workflow-list call. Use only media references supplied by the user. Pass runclave-resource:// references as media_ref and legacy llm-gateway asset IDs as asset_id. Generation is asynchronous; create_media_job returns a job ID immediately. Completed jobs return durable resource URIs. Never request or embed asset data as base64."
    }
  );
  server.registerTool(
    "create_media_job",
    {
      title: "Create media generation job",
      description: createWorkflowToolDescription(workflows),
      inputSchema: createInputSchema(workflows)
    },
    async (args) => text(await manager.create(args, tenantId))
  );
  server.registerTool(
    "get_media_job",
    {
      title: "Get media job",
      description: "Get generation status and output media references",
      inputSchema: { job_id: z.string() }
    },
    async ({ job_id }) => text(jobWithPreviewUrls(manager.get(job_id, tenantId), tenantId))
  );
  server.registerTool(
    "get_media_asset",
    {
      title: "Get media preview URL",
      description: "Verify access to a media resource and return metadata without base64 or binary data.",
      inputSchema: {
        asset_id: z.string().min(1).optional(),
        media_ref: z.string().min(1).optional()
      }
    },
    async ({ asset_id, media_ref }) => {
      const reference = media_ref ?? asset_id;
      if (!reference || (asset_id && media_ref)) {
        throw new Error("Provide exactly one of asset_id or media_ref");
      }
      const metadata = await assets.getMetadata(reference, tenantId);
      const signedLink = asset_id && config.mediaResourceBackend === "llm_gateway"
        ? createSignedAssetLink(asset_id, tenantId)
        : null;
      const previewUri = signedLink?.preview_url ?? metadata.uri;
      const result = {
        ...(asset_id ? { asset_id } : {}),
        ...(media_ref ? { media_ref } : {}),
        uri: metadata.uri,
        ...(metadata.resource_id ? { resource_id: metadata.resource_id } : {}),
        mime_type: metadata.mime_type,
        original_name: metadata.original_name,
        size: metadata.size,
        ...(signedLink ?? {})
      };
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result) },
          {
            type: "resource_link" as const,
            uri: previewUri,
            name: metadata.original_name || reference,
            description: "Media resource reference",
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
