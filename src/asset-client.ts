import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import axios, { type AxiosRequestConfig } from "axios";
import { config } from "./config.js";
import type { OutputAsset } from "./types.js";

interface ResolvedAsset extends OutputAsset {
  local_path: string;
}

function externalHeaders(tenantId: string): Record<string, string> {
  const headers: Record<string, string> = { "x-tenant-id": tenantId };
  if (config.assetApiKey) headers.authorization = `Bearer ${config.assetApiKey}`;
  return headers;
}

function internalHeaders(): Record<string, string> {
  return config.assetInternalApiKey ? { "x-internal-api-key": config.assetInternalApiKey } : {};
}

export class AssetClient {
  async resolveLocal(assetId: string, tenantId: string): Promise<ResolvedAsset> {
    const response = await axios.post(
      `${config.assetServiceUrl}/internal/assets/resolve`,
      { asset_id: assetId, tenant_id: tenantId },
      { headers: internalHeaders() }
    );
    return response.data as ResolvedAsset;
  }

  async materialize(assetId: string, tenantId: string, directory: string): Promise<string> {
    await mkdir(directory, { recursive: true });
    try {
      return (await this.resolveLocal(assetId, tenantId)).local_path;
    } catch {
      const metadata = await axios.get<OutputAsset>(`${config.assetServiceUrl}/assets/${assetId}`, {
        headers: externalHeaders(tenantId)
      });
      const destination = path.join(directory, `${assetId}-${path.basename(metadata.data.original_name)}`);
      const response = await axios.get(`${config.assetServiceUrl}/assets/${assetId}/content`, {
        headers: externalHeaders(tenantId),
        responseType: "stream"
      });
      await pipeline(response.data, createWriteStream(destination, { flags: "wx" }));
      return destination;
    }
  }

  async importLocal(filePath: string, originalName: string, tenantId: string): Promise<OutputAsset> {
    const response = await axios.post(
      `${config.assetServiceUrl}/internal/assets/import`,
      { path: filePath, original_name: originalName, tenant_id: tenantId },
      { headers: internalHeaders() }
    );
    return response.data as OutputAsset;
  }

  async uploadStream(
    stream: NodeJS.ReadableStream,
    originalName: string,
    mimeType: string | undefined,
    tenantId: string
  ): Promise<OutputAsset> {
    const request: AxiosRequestConfig = {
      headers: {
        ...externalHeaders(tenantId),
        "content-type": mimeType ?? "application/octet-stream",
        "x-filename": originalName
      },
      maxBodyLength: Infinity
    };
    const response = await axios.post(
      `${config.assetServiceUrl}/assets/raw?filename=${encodeURIComponent(originalName)}`,
      stream,
      request
    );
    return response.data as OutputAsset;
  }
}
