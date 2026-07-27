import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

interface AssetAccessPayload {
  version: 1;
  assetId: string;
  tenantId: string;
  expiresAt: number;
}

const assetIdPattern = /^asset_[a-f0-9]{32}$/;
const tenantPattern = /^[a-zA-Z0-9_.-]{1,128}$/;

function signature(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

function signingSecret(): string {
  if (!config.assetUrlSigningSecret || config.assetUrlSigningSecret.length < 32) {
    throw new Error("ASSET_URL_SIGNING_SECRET must contain at least 32 characters");
  }
  return config.assetUrlSigningSecret;
}

export function createAssetAccessToken(
  assetId: string,
  tenantId: string,
  expiresAt: number,
  secret = signingSecret()
): string {
  if (!assetIdPattern.test(assetId)) throw new Error("Invalid asset ID");
  if (!tenantPattern.test(tenantId)) throw new Error("Invalid tenant ID");
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) throw new Error("Invalid asset URL expiration");
  const payload = Buffer.from(JSON.stringify({ version: 1, assetId, tenantId, expiresAt } satisfies AssetAccessPayload)).toString("base64url");
  return payload + "." + signature(payload, secret).toString("base64url");
}

export function verifyAssetAccessToken(
  token: string,
  expectedAssetId: string,
  now = Math.floor(Date.now() / 1000),
  secret = signingSecret()
): AssetAccessPayload {
  const [payloadPart, signaturePart, extra] = token.split(".");
  if (!payloadPart || !signaturePart || extra !== undefined) throw new Error("Invalid asset access token");
  const actual = Buffer.from(signaturePart, "base64url");
  const expected = signature(payloadPart, secret);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("Invalid asset access token");
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid asset access token");
  }
  if (!payload || typeof payload !== "object") throw new Error("Invalid asset access token");
  const value = payload as Partial<AssetAccessPayload>;
  if (
    value.version !== 1 ||
    typeof value.assetId !== "string" || !assetIdPattern.test(value.assetId) ||
    value.assetId !== expectedAssetId ||
    typeof value.tenantId !== "string" || !tenantPattern.test(value.tenantId) ||
    !Number.isSafeInteger(value.expiresAt)
  ) throw new Error("Invalid asset access token");
  if ((value.expiresAt as number) <= now) throw new Error("Asset access token has expired");
  return value as AssetAccessPayload;
}

export function createSignedAssetLink(assetId: string, tenantId: string): { preview_url: string; expires_at: string } {
  if (!config.videoServerPublicBaseUrl) throw new Error("VIDEO_SERVER_PUBLIC_BASE_URL is not configured");
  const expiresAt = Math.floor(Date.now() / 1000) + config.assetUrlTtlSeconds;
  const url = new URL(`/assets/${encodeURIComponent(assetId)}/signed-content`, config.videoServerPublicBaseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("VIDEO_SERVER_PUBLIC_BASE_URL must use http or https");
  url.searchParams.set("token", createAssetAccessToken(assetId, tenantId, expiresAt));
  return { preview_url: url.toString(), expires_at: new Date(expiresAt * 1000).toISOString() };
}

export function canCreateSignedAssetLinks(): boolean {
  return Boolean(config.videoServerPublicBaseUrl && config.assetUrlSigningSecret && config.assetUrlSigningSecret.length >= 32);
}
