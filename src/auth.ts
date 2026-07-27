import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";

const authenticatedTenants = new WeakMap<Request, string>();

function validTenant(value: string): string {
  if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(value)) throw new Error("Invalid tenant ID");
  return value;
}

function bearerToken(req: Request): string | undefined {
  const header = req.header("authorization");
  return header?.startsWith("Bearer ") ? header.slice(7) : undefined;
}

function tokenEquals(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function resolveTenantForCredentials(
  token: string | undefined,
  requestedTenant: string | undefined,
  users = config.apiUsers,
  apiKey = config.apiKey
): string | undefined {
  if (users.length > 0) {
    for (const user of users) if (tokenEquals(token, user.token)) return user.tenantId;
    return undefined;
  }
  if (apiKey && !tokenEquals(token, apiKey)) return undefined;
  return validTenant(requestedTenant?.trim() || "default");
}

function resolveTenant(req: Request): string | undefined {
  return resolveTenantForCredentials(bearerToken(req), req.header("x-tenant-id"));
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  try {
    const tenant = resolveTenant(req);
    if (!tenant) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    authenticatedTenants.set(req, tenant);
    next();
  } catch (error) {
    next(error);
  }
}

export function tenantId(req: Request): string {
  const tenant = authenticatedTenants.get(req);
  if (!tenant) throw new Error("Missing authentication context");
  return tenant;
}
