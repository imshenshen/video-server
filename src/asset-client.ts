import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, copyFile, link, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import axios, { type AxiosRequestConfig } from "axios";
import { config } from "./config.js";
import { upstreamRequest } from "./upstream-error.js";
import type { OutputAsset } from "./types.js";

interface ResolvedAsset extends OutputAsset {
  local_path: string;
}

interface RunclaveResource {
  id: string;
  uri: string;
  storageProvider: string;
  storageKey: string;
  mimeType: string;
  originalName: string;
  size: number;
  sha256?: string;
  contentUrl?: string;
}

function externalHeaders(tenantId: string): Record<string, string> {
  const headers: Record<string, string> = { "x-tenant-id": tenantId };
  if (config.assetApiKey) headers.authorization = `Bearer ${config.assetApiKey}`;
  return headers;
}

function internalHeaders(): Record<string, string> {
  return config.assetInternalApiKey ? { "x-internal-api-key": config.assetInternalApiKey } : {};
}

function runclaveHeaders(): Record<string, string> {
  return config.runclaveResourceApiToken
    ? { "x-runclave-desktop-token": config.runclaveResourceApiToken }
    : {};
}

function runclaveResourceId(value: string): string {
  const normalized = String(value ?? "").trim();
  const id = normalized.startsWith("runclave-resource://")
    ? normalized.slice("runclave-resource://".length)
    : normalized;
  if (!/^res_[A-Za-z0-9-]+$/.test(id)) {
    throw new Error("Runclave media reference must be runclave-resource://res_xxx or res_xxx");
  }
  return id;
}

function within(root: string, relativePath: string): string {
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Runclave resource path escapes RUNCLAVE_SHARED_ROOT");
  }
  return target;
}

function runclaveOutput(resource: RunclaveResource): OutputAsset {
  const contentUrl = resource.contentUrl
    ? new URL(resource.contentUrl, `${config.runclaveResourceBaseUrl}/`).toString()
    : undefined;
  return {
    resource_id: resource.id,
    uri: resource.uri || `runclave-resource://${resource.id}`,
    mime_type: resource.mimeType,
    original_name: resource.originalName,
    size: resource.size,
    ...(resource.sha256 ? { sha256: resource.sha256 } : {}),
    ...(contentUrl ? { content_url: contentUrl } : {})
  };
}

export class AssetClient {
  private get usesRunclave(): boolean {
    return config.mediaResourceBackend === "runclave";
  }

  async resolveLocal(assetId: string, tenantId: string): Promise<ResolvedAsset> {
    if (this.usesRunclave) {
      const resource = await this.getRunclaveResource(assetId);
      if (
        !config.runclaveSharedRoot ||
        resource.storageProvider !== config.runclaveSharedProviderId
      ) {
        throw new Error("Runclave shared filesystem fast path is unavailable");
      }
      const localPath = within(config.runclaveSharedRoot, resource.storageKey);
      await access(localPath);
      return {
        ...runclaveOutput(resource),
        local_path: localPath
      };
    }
    const response = await upstreamRequest("Asset service", "resolve asset", () => axios.post(
      `${config.assetServiceUrl}/internal/assets/resolve`,
      { asset_id: assetId, tenant_id: tenantId },
      { headers: internalHeaders() }
    ));
    return response.data as ResolvedAsset;
  }

  async getMetadata(assetId: string, tenantId: string): Promise<OutputAsset> {
    if (this.usesRunclave) {
      return runclaveOutput(await this.getRunclaveResource(assetId));
    }
    const response = await upstreamRequest("Asset service", "get asset metadata", () => axios.get<OutputAsset>(
      `${config.assetServiceUrl}/assets/${encodeURIComponent(assetId)}`,
      { headers: externalHeaders(tenantId) }
    ));
    return response.data;
  }

  async materialize(assetId: string, tenantId: string, directory: string): Promise<string> {
    await mkdir(directory, { recursive: true });
    try {
      return (await this.resolveLocal(assetId, tenantId)).local_path;
    } catch {
      const metadata = await this.getMetadata(assetId, tenantId);
      const id = this.usesRunclave ? runclaveResourceId(assetId) : assetId;
      const destination = path.join(directory, `${id}-${path.basename(metadata.original_name)}`);
      const content = await this.downloadContent(assetId, tenantId);
      await pipeline(content.stream, createWriteStream(destination, { flags: "wx" }));
      return destination;
    }
  }

  async importLocal(
    filePath: string,
    originalName: string,
    tenantId: string,
    ownerId = `video_job_${randomUUID()}`
  ): Promise<OutputAsset> {
    if (this.usesRunclave) {
      const staged = await this.stageLocalFile(filePath, originalName);
      try {
        return await this.registerRunclaveObject(staged.storageKey, originalName, undefined, ownerId);
      } finally {
        await rm(path.dirname(staged.path), { recursive: true, force: true }).catch(() => undefined);
      }
    }
    const response = await upstreamRequest("Asset service", "import generated output", () => axios.post(
      `${config.assetServiceUrl}/internal/assets/import`,
      { path: filePath, original_name: originalName, tenant_id: tenantId },
      { headers: internalHeaders() }
    ));
    return response.data as OutputAsset;
  }

  async downloadContent(assetId: string, tenantId: string): Promise<{
    stream: NodeJS.ReadableStream;
    contentType: string;
    contentLength?: string;
  }> {
    const url = this.usesRunclave
      ? `${config.runclaveResourceBaseUrl}/api/resources/${encodeURIComponent(runclaveResourceId(assetId))}/content`
      : `${config.assetServiceUrl}/assets/${encodeURIComponent(assetId)}/content`;
    const headers = this.usesRunclave ? runclaveHeaders() : externalHeaders(tenantId);
    const response = await upstreamRequest(
      this.usesRunclave ? "Runclave resource service" : "Asset service",
      "preview asset",
      () => axios.get(url, { headers, responseType: "stream" })
    );
    const contentLength = response.headers["content-length"];
    return {
      stream: response.data as NodeJS.ReadableStream,
      contentType: String(response.headers["content-type"] ?? "application/octet-stream"),
      ...(contentLength ? { contentLength: String(contentLength) } : {})
    };
  }

  async uploadStream(
    stream: NodeJS.ReadableStream,
    originalName: string,
    mimeType: string | undefined,
    tenantId: string,
    ownerId = `video_job_${randomUUID()}`
  ): Promise<OutputAsset> {
    if (this.usesRunclave) {
      const staged = this.stagingTarget(originalName);
      await mkdir(path.dirname(staged.path), { recursive: true });
      await pipeline(stream, createWriteStream(staged.path, { flags: "wx" }));
      try {
        return await this.registerRunclaveObject(staged.storageKey, originalName, mimeType, ownerId);
      } finally {
        await rm(path.dirname(staged.path), { recursive: true, force: true }).catch(() => undefined);
      }
    }
    const request: AxiosRequestConfig = {
      headers: {
        ...externalHeaders(tenantId),
        "content-type": mimeType ?? "application/octet-stream",
        "x-filename": originalName
      },
      maxBodyLength: Infinity
    };
    const response = await upstreamRequest("Asset service", "upload generated output", () => axios.post(
      `${config.assetServiceUrl}/assets/raw?filename=${encodeURIComponent(originalName)}`,
      stream,
      request
    ));
    return response.data as OutputAsset;
  }

  private async getRunclaveResource(value: string): Promise<RunclaveResource> {
    const id = runclaveResourceId(value);
    const response = await upstreamRequest("Runclave resource service", "get resource metadata", () => axios.get<RunclaveResource>(
      `${config.runclaveResourceBaseUrl}/api/resources/${encodeURIComponent(id)}`,
      { headers: runclaveHeaders() }
    ));
    return response.data;
  }

  private stagingTarget(originalName: string): { path: string; storageKey: string } {
    if (!config.runclaveSharedRoot) {
      throw new Error("RUNCLAVE_SHARED_ROOT is required when MEDIA_RESOURCE_BACKEND=runclave");
    }
    const safeName = path.basename(originalName).replace(/[^a-zA-Z0-9._-]+/g, "_") || "output.bin";
    const storageKey = path.posix.join(".incoming", "video-server", randomUUID(), safeName);
    return {
      storageKey,
      path: within(config.runclaveSharedRoot, storageKey)
    };
  }

  private async stageLocalFile(filePath: string, originalName: string) {
    const staged = this.stagingTarget(originalName);
    await mkdir(path.dirname(staged.path), { recursive: true });
    await link(filePath, staged.path).catch(async () => copyFile(filePath, staged.path));
    return staged;
  }

  private async registerRunclaveObject(
    storageKey: string,
    originalName: string,
    mimeType: string | undefined,
    ownerId: string
  ): Promise<OutputAsset> {
    const response = await upstreamRequest("Runclave resource service", "register generated output", () => axios.post<RunclaveResource>(
      `${config.runclaveResourceBaseUrl}/api/resources/register`,
      {
        storageKey,
        originalName,
        ...(mimeType ? { mimeType } : {}),
        subjectType: "video_job",
        subjectId: ownerId
      },
      { headers: runclaveHeaders() }
    ));
    return runclaveOutput(response.data);
  }
}
