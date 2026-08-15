import { timingSafeEqual } from "node:crypto";

export type AutomationRuntimePolicy = {
  automationEnabled: boolean;
  sendAutomationEnabled: boolean;
};

export type CronAuthorizationResult =
  | { ok: true }
  | { ok: false; status: 401 | 503; error: string };

function enabled(value: string | undefined) {
  return value?.trim().toLowerCase() === "true";
}

export function getAutomationRuntimePolicy(env: NodeJS.ProcessEnv = process.env): AutomationRuntimePolicy {
  return {
    automationEnabled: enabled(env["AUTOMATION_ENABLED"]),
    sendAutomationEnabled: enabled(env["AUTOMATION_SEND_ENABLED"]),
  };
}

export function authorizeCronRequest(
  authorization: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): CronAuthorizationResult {
  const secret = env["CRON_SECRET"]?.trim();
  if (!secret) {
    return { ok: false, status: 503, error: "CRON_SECRET is not configured" };
  }

  const expected = `Bearer ${secret}`;
  if (!authorization) return { ok: false, status: 401, error: "Unauthorized" };

  const actualBuffer = Buffer.from(authorization);
  const expectedBuffer = Buffer.from(expected);
  const matches = actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
  return matches ? { ok: true } : { ok: false, status: 401, error: "Unauthorized" };
}
