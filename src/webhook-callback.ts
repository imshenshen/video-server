import { z } from "zod";
import { config } from "./config.js";
import type { GenerationJob, JobWebhookCallback } from "./types.js";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function callbackUrl(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Webhook callback URL must use HTTP or HTTPS");
  }
  if (url.username || url.password || url.hash) {
    throw new Error("Webhook callback URL cannot contain credentials or a fragment");
  }
  if (url.protocol === "http:" && !LOOPBACK_HOSTNAMES.has(url.hostname)) {
    let trustedRunclaveOrigin = "";
    try {
      trustedRunclaveOrigin = new URL(config.runclaveResourceBaseUrl).origin;
    } catch {
      // The main config validation reports malformed service URLs separately.
    }
    if (url.origin !== trustedRunclaveOrigin) {
      throw new Error(
        "HTTP webhook callback origin must match RUNCLAVE_RESOURCE_BASE_URL; use HTTPS for other hosts"
      );
    }
  }
  return url.toString();
}

export const webhookCallbackSchema = z.object({
  protocol: z.literal("runclave.capability-callback.v1"),
  url: z.string().min(1).max(2048).transform(callbackUrl),
  token: z.string().min(16).max(4096),
  subscriptionId: z.string().min(1).max(256),
  invocationId: z.string().min(1).max(256)
}).strict();

export function publicGenerationJob(job: GenerationJob): GenerationJob {
  const clone = structuredClone(job);
  if (clone.webhookCallback) {
    clone.webhookCallback = {
      protocol: clone.webhookCallback.protocol,
      subscriptionId: clone.webhookCallback.subscriptionId,
      invocationId: clone.webhookCallback.invocationId,
      eventId: clone.webhookCallback.eventId,
      deliveryStatus: clone.webhookCallback.deliveryStatus,
      attempts: clone.webhookCallback.attempts,
      ...(clone.webhookCallback.nextAttemptAt
        ? { nextAttemptAt: clone.webhookCallback.nextAttemptAt }
        : {}),
      ...(clone.webhookCallback.deliveredAt
        ? { deliveredAt: clone.webhookCallback.deliveredAt }
        : {}),
      ...(clone.webhookCallback.lastError
        ? { lastError: clone.webhookCallback.lastError }
        : {})
    } as JobWebhookCallback;
  }
  return clone;
}

export function webhookCallbackPayload(job: GenerationJob): Record<string, unknown> {
  const callback = job.webhookCallback;
  if (!callback) throw new Error("Job has no webhook callback");
  return {
    eventId: callback.eventId,
    operationId: job.id,
    status: job.status,
    progress: job.progress,
    outputResourceIds: job.outputs
      .map((output) => output.resource_id)
      .filter((id): id is string => Boolean(id)),
    result: publicGenerationJob(job),
    ...(job.error ? { error: job.error } : {})
  };
}

export class WebhookCallbackClient {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000
  ) {}

  async deliver(job: GenerationJob): Promise<void> {
    const callback = job.webhookCallback;
    if (!callback?.url || !callback.token) {
      throw new Error("Webhook callback credentials are unavailable");
    }
    const response = await this.fetchImpl(callback.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${callback.token}`,
        "content-type": "application/json",
        "x-runclave-event-id": callback.eventId
      },
      body: JSON.stringify(webhookCallbackPayload(job)),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!response.ok) {
      const details = (await response.text()).slice(0, 500);
      throw new Error(`Webhook callback failed with HTTP ${response.status}${details ? `: ${details}` : ""}`);
    }
  }
}
