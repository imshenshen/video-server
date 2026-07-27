import type { Request, Response } from "express";

const sensitiveKey = /^(authorization|token|api[_-]?key|password|secret)$/i;

export function redactLogValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactLogValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        sensitiveKey.test(key) ? "[REDACTED]" : redactLogValue(nested)
      ])
    );
  }
  return value;
}

export function logMcpRequest(req: Request, res: Response, tenantId: string): void {
  if (req.body?.method !== "tools/call") return;
  const startedAt = Date.now();
  const tool = req.body?.params?.name;
  const argumentsValue = redactLogValue(req.body?.params?.arguments ?? {});
  console.log(JSON.stringify({
    event: "mcp.tool.request",
    tenant_id: tenantId,
    request_id: req.body?.id,
    tool,
    arguments: argumentsValue
  }));
  res.once("finish", () => {
    console.log(JSON.stringify({
      event: "mcp.tool.response",
      tenant_id: tenantId,
      request_id: req.body?.id,
      tool,
      status: res.statusCode,
      duration_ms: Date.now() - startedAt
    }));
  });
}
