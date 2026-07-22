import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";

function authorized(req: Request): boolean {
  if (!config.apiKey) return true;
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice(7));
  const expected = Buffer.from(config.apiKey);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (authorized(req)) {
    next();
    return;
  }
  res.status(401).json({ error: "Unauthorized" });
}

export function tenantId(req: Request): string {
  const value = req.header("x-tenant-id")?.trim() || "default";
  if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(value)) throw new Error("Invalid x-tenant-id");
  return value;
}
