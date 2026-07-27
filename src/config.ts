import path from "node:path";
export interface ApiUser { tenantId: string; token: string }

export function parseApiUsers(value: string | undefined): ApiUser[] {
  if (!value?.trim()) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("VIDEO_SERVER_USERS must be valid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("VIDEO_SERVER_USERS must be a JSON object");
  const seen = new Set<string>();
  return Object.entries(parsed).map(([tenantId, token]) => {
    if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(tenantId)) throw new Error(`Invalid tenant ID in VIDEO_SERVER_USERS: ${tenantId}`);
    if (typeof token !== "string" || token.length < 16) throw new Error(`Token for ${tenantId} must contain at least 16 characters`);
    if (seen.has(token)) throw new Error("Each VIDEO_SERVER_USERS token must be unique");
    seen.add(token);
    return { tenantId, token };
  });
}


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
  apiUsers: parseApiUsers(process.env.VIDEO_SERVER_USERS),
  comfyBaseUrl: (process.env.COMFYUI_BASE_URL ?? "http://127.0.0.1:8188").replace(/\/$/, ""),
  comfyTimeoutMs: integer("COMFY_JOB_TIMEOUT_MS", 30 * 60 * 1000),
  concurrency: integer("JOB_CONCURRENCY", 1),
  workflowDir: path.resolve(process.env.WORKFLOW_DIR ?? "./workflows"),
  manifestDir: path.resolve(process.env.MANIFEST_DIR ?? process.env.WORKFLOW_DIR ?? "./workflows"),
  jobDataDir: path.resolve(process.env.JOB_DATA_DIR ?? "./data/jobs"),
  jobTempDir: path.resolve(process.env.JOB_TEMP_DIR ?? "./tmp/jobs"),
  assetServiceUrl: (process.env.ASSET_SERVICE_URL ?? "http://127.0.0.1:8080").replace(/\/$/, ""),
  assetApiKey: process.env.ASSET_SERVICE_API_KEY,
  assetInternalApiKey: process.env.ASSET_INTERNAL_API_KEY,
  comfyInputRoot: process.env.COMFY_INPUT_ROOT ? path.resolve(process.env.COMFY_INPUT_ROOT) : undefined,
  comfyOutputRoot: process.env.COMFY_OUTPUT_ROOT ? path.resolve(process.env.COMFY_OUTPUT_ROOT) : undefined,
  videoServerPublicBaseUrl: process.env.VIDEO_SERVER_PUBLIC_BASE_URL?.replace(/\/$/, ""),
  assetUrlSigningSecret: process.env.ASSET_URL_SIGNING_SECRET,
  assetUrlTtlSeconds: integer("ASSET_URL_TTL_SECONDS", 24 * 60 * 60)
};
