import axios from "axios";

const maxDetailLength = 2_000;

function responseDetail(data: unknown): string | undefined {
  if (typeof data === "string") return data.trim() || undefined;
  if (!data || typeof data !== "object") return undefined;
  const record = data as Record<string, unknown>;
  if (typeof record.message === "string") return record.message;
  if (typeof record.error === "string") return record.error;
  if (record.error && typeof record.error === "object") {
    const message = (record.error as Record<string, unknown>).message;
    if (typeof message === "string") return message;
  }
  if (record.node_errors !== undefined) return `node_errors=${JSON.stringify(record.node_errors)}`;
  return undefined;
}

function clean(value: string): string {
  const singleLine = value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  return singleLine.length > maxDetailLength ? `${singleLine.slice(0, maxDetailLength)}…` : singleLine;
}

export function formatUpstreamError(service: string, action: string, error: unknown): Error {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const detail = responseDetail(error.response?.data) ?? error.code ?? error.message;
    return new Error(`${service} ${action} failed${status ? ` (HTTP ${status})` : ""}: ${clean(detail)}`);
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`${service} ${action} failed: ${clean(detail)}`);
}

export async function upstreamRequest<T>(
  service: string,
  action: string,
  request: () => Promise<T>
): Promise<T> {
  try {
    return await request();
  } catch (error) {
    throw formatUpstreamError(service, action, error);
  }
}
