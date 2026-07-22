import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import axios from "axios";
import FormData from "form-data";
import WebSocket from "ws";
import { config } from "./config.js";
import type { ComfyOutputFile } from "./types.js";

interface ComfyChannel {
  clientId: string;
  socket: WebSocket;
}

interface RunCallbacks {
  onQueued(promptId: string): void;
  onProgress(progress: number, node?: string): void;
}

function websocketUrl(clientId: string): string {
  const url = new URL(config.comfyBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/ws`;
  url.search = new URLSearchParams({ clientId }).toString();
  return url.toString();
}

function collectOutputs(history: unknown): ComfyOutputFile[] {
  if (!history || typeof history !== "object") return [];
  const outputs = (history as Record<string, unknown>).outputs;
  if (!outputs || typeof outputs !== "object") return [];
  const files: ComfyOutputFile[] = [];
  for (const nodeOutput of Object.values(outputs)) {
    if (!nodeOutput || typeof nodeOutput !== "object") continue;
    for (const [kind, value] of Object.entries(nodeOutput)) {
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        if (!item || typeof item !== "object") continue;
        const record = item as Record<string, unknown>;
        if (typeof record.filename !== "string") continue;
        files.push({
          filename: record.filename,
          subfolder: typeof record.subfolder === "string" ? record.subfolder : "",
          type: typeof record.type === "string" ? record.type : "output",
          mediaKind: kind
        });
      }
    }
  }
  return files;
}

export class ComfyClient {
  async uploadInput(filePath: string, jobId: string): Promise<string> {
    const form = new FormData();
    form.append("image", createReadStream(filePath));
    form.append("type", "input");
    form.append("subfolder", `jobs/${jobId}`);
    form.append("overwrite", "false");
    const response = await axios.post(`${config.comfyBaseUrl}/upload/image`, form, {
      headers: form.getHeaders(),
      maxBodyLength: Infinity
    });
    const name = String(response.data.name ?? response.data.filename ?? "");
    const subfolder = String(response.data.subfolder ?? `jobs/${jobId}`);
    if (!name) throw new Error("ComfyUI upload response did not include a filename");
    return subfolder ? `${subfolder.replace(/\\/g, "/")}/${name}` : name;
  }

  async runWorkflow(workflow: Record<string, unknown>, callbacks: RunCallbacks): Promise<ComfyOutputFile[]> {
    const channel = await this.openChannel();
    try {
      const response = await axios.post(`${config.comfyBaseUrl}/prompt`, {
        prompt: workflow,
        client_id: channel.clientId
      });
      const promptId = String(response.data.prompt_id ?? "");
      if (!promptId) {
        throw new Error(`ComfyUI rejected workflow: ${JSON.stringify(response.data.node_errors ?? response.data)}`);
      }
      callbacks.onQueued(promptId);
      await this.waitForCompletion(channel.socket, promptId, callbacks.onProgress);
      return await this.getOutputs(promptId);
    } finally {
      channel.socket.close();
    }
  }

  async cancel(promptId: string): Promise<void> {
    await axios.post(`${config.comfyBaseUrl}/queue`, { delete: [promptId] }).catch(() => undefined);
    await axios.post(`${config.comfyBaseUrl}/interrupt`, {}).catch(() => undefined);
  }

  async downloadOutput(file: ComfyOutputFile): Promise<{ stream: NodeJS.ReadableStream; mimeType?: string }> {
    const query = new URLSearchParams({
      filename: file.filename,
      subfolder: file.subfolder,
      type: file.type
    });
    const response = await axios.get(`${config.comfyBaseUrl}/view?${query.toString()}`, { responseType: "stream" });
    const contentType = typeof response.headers["content-type"] === "string" ? response.headers["content-type"] : undefined;
    return contentType ? { stream: response.data, mimeType: contentType } : { stream: response.data };
  }

  private async openChannel(): Promise<ComfyChannel> {
    const clientId = randomUUID();
    const socket = new WebSocket(websocketUrl(clientId));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out connecting to ComfyUI WebSocket")), 10_000);
      socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    return { clientId, socket };
  }

  private async waitForCompletion(
    socket: WebSocket,
    promptId: string,
    onProgress: (progress: number, node?: string) => void
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("ComfyUI job timed out")), config.comfyTimeoutMs);
      const finish = (error?: Error): void => {
        clearTimeout(timer);
        socket.removeAllListeners("message");
        socket.removeAllListeners("error");
        socket.removeAllListeners("close");
        error ? reject(error) : resolve();
      };
      socket.on("message", (raw, isBinary) => {
        if (isBinary) return;
        try {
          const event = JSON.parse(raw.toString()) as Record<string, unknown>;
          const data = event.data as Record<string, unknown> | undefined;
          if (!data || data.prompt_id !== promptId) return;
          if (event.type === "progress") {
            const value = Number(data.value ?? 0);
            const max = Number(data.max ?? 1);
            onProgress(max > 0 ? value / max : 0, typeof data.node === "string" ? data.node : undefined);
          } else if (event.type === "executing") {
            if (data.node === null) finish();
            else onProgress(0, typeof data.node === "string" ? data.node : undefined);
          } else if (event.type === "execution_success") {
            finish();
          } else if (event.type === "execution_error") {
            finish(new Error(String(data.exception_message ?? "ComfyUI execution failed")));
          } else if (event.type === "execution_interrupted") {
            finish(new Error("ComfyUI execution was interrupted"));
          }
        } catch {
          // Ignore malformed or unrelated ComfyUI messages.
        }
      });
      socket.once("error", (error) => finish(error));
      socket.once("close", () => finish(new Error("ComfyUI WebSocket closed before job completion")));
    });
  }

  private async getOutputs(promptId: string): Promise<ComfyOutputFile[]> {
    const response = await axios.get(`${config.comfyBaseUrl}/history/${encodeURIComponent(promptId)}`);
    const history = response.data?.[promptId];
    const outputs = collectOutputs(history);
    if (outputs.length === 0) throw new Error("ComfyUI completed without downloadable outputs");
    return outputs;
  }
}

export { collectOutputs };
