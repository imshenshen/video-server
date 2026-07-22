import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { JobManager } from "./job-manager.js";
import type { WorkflowRegistry } from "./workflow-registry.js";

const inputSchema = {
  workflow_id: z.string().describe("Workflow ID returned by list_media_workflows"),
  inputs: z.array(z.object({ asset_id: z.string(), role: z.string() })),
  prompt: z.string(),
  negative_prompt: z.string().optional(),
  parameters: z.record(z.unknown()).optional()
};

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function createServer(manager: JobManager, registry: WorkflowRegistry, tenantId: string): McpServer {
  const server = new McpServer(
    { name: "spark-video-server", version: "0.1.0" },
    {
      instructions:
        "Call list_media_workflows before creating a job. Use only asset IDs supplied by the user. Generation is asynchronous; create_media_job returns a job ID immediately."
    }
  );
  server.registerTool(
    "list_media_workflows",
    { title: "List media workflows", description: "List enabled image-to-image and image-to-video workflows" },
    async () => text(registry.capabilities())
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
      description: "Get generation status and output asset IDs",
      inputSchema: { job_id: z.string() }
    },
    async ({ job_id }) => text(manager.get(job_id, tenantId))
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
