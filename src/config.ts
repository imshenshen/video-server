import path from "node:path";

function integer(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export const config = {
  host: process.env.HOST ?? "0.0.0.0",
  port: integer("PORT", 8090),
  apiKey: process.env.VIDEO_SERVER_API_KEY,
  comfyBaseUrl: (process.env.COMFYUI_BASE_URL ?? "http://127.0.0.1:8188").replace(/\/$/, ""),
  comfyTimeoutMs: integer("COMFY_JOB_TIMEOUT_MS", 30 * 60 * 1000),
  concurrency: integer("JOB_CONCURRENCY", 1),
  workflowDir: path.resolve(process.env.WORKFLOW_DIR ?? "./workflows"),
  jobDataDir: path.resolve(process.env.JOB_DATA_DIR ?? "./data/jobs"),
  jobTempDir: path.resolve(process.env.JOB_TEMP_DIR ?? "./tmp/jobs"),
  assetServiceUrl: (process.env.ASSET_SERVICE_URL ?? "http://127.0.0.1:8080").replace(/\/$/, ""),
  assetApiKey: process.env.ASSET_SERVICE_API_KEY,
  assetInternalApiKey: process.env.ASSET_INTERNAL_API_KEY,
  comfyInputRoot: process.env.COMFY_INPUT_ROOT ? path.resolve(process.env.COMFY_INPUT_ROOT) : undefined,
  comfyOutputRoot: process.env.COMFY_OUTPUT_ROOT ? path.resolve(process.env.COMFY_OUTPUT_ROOT) : undefined
};
