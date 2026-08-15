import test from "node:test";
import assert from "node:assert/strict";
import { authorizeCronRequest, getAutomationRuntimePolicy } from "../src/lib/automation-policy.js";

test("cron endpoint fails closed when CRON_SECRET is missing", () => {
  const result = authorizeCronRequest("Bearer anything", {} as NodeJS.ProcessEnv);
  assert.deepEqual(result, { ok: false, status: 503, error: "CRON_SECRET is not configured" });
});

test("cron endpoint rejects missing or incorrect bearer credentials", () => {
  const env = { CRON_SECRET: "correct-secret" } as NodeJS.ProcessEnv;
  assert.deepEqual(authorizeCronRequest(undefined, env), { ok: false, status: 401, error: "Unauthorized" });
  assert.deepEqual(authorizeCronRequest("Bearer wrong-secret", env), { ok: false, status: 401, error: "Unauthorized" });
});

test("cron endpoint accepts the exact configured bearer credential", () => {
  const env = { CRON_SECRET: "correct-secret" } as NodeJS.ProcessEnv;
  assert.deepEqual(authorizeCronRequest("Bearer correct-secret", env), { ok: true });
});

test("automation and sending default to disabled", () => {
  assert.deepEqual(getAutomationRuntimePolicy({} as NodeJS.ProcessEnv), {
    automationEnabled: false,
    sendAutomationEnabled: false,
  });
});

test("automation and sending require explicit true values", () => {
  assert.deepEqual(getAutomationRuntimePolicy({
    AUTOMATION_ENABLED: "true",
    AUTOMATION_SEND_ENABLED: "TRUE",
  } as NodeJS.ProcessEnv), {
    automationEnabled: true,
    sendAutomationEnabled: true,
  });
  assert.deepEqual(getAutomationRuntimePolicy({
    AUTOMATION_ENABLED: "1",
    AUTOMATION_SEND_ENABLED: "yes",
  } as NodeJS.ProcessEnv), {
    automationEnabled: false,
    sendAutomationEnabled: false,
  });
});
