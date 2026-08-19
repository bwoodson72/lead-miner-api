import type { Express } from "express";
import type { PrismaClient } from "../generated/prisma/client.js";
import { ZodError } from "zod";
import { getAppSettings, patchAppSettings, updateAppSettings } from "./settings.js";
import { GMAIL_SEND_POLICY_KEYS, getGmailSendPolicy, patchGmailSendPolicy } from "./gmail-send-policy.js";

function validationError(res: any, error: ZodError, label = "settings") {
  res.status(400).json({ error: `Invalid ${label}`, issues: error.issues });
}

function splitSettingsInput(input: unknown) {
  const body = input && typeof input === "object" && !Array.isArray(input) ? { ...(input as Record<string, unknown>) } : {};
  const gmailPolicy: Record<string, unknown> = {};
  for (const key of GMAIL_SEND_POLICY_KEYS) {
    if (key in body) {
      gmailPolicy[key] = body[key];
      delete body[key];
    }
  }
  return { appSettings: body, gmailPolicy };
}

async function mergedSettings(prisma: PrismaClient) {
  const [settings, gmailPolicy] = await Promise.all([getAppSettings(prisma), getGmailSendPolicy(prisma)]);
  return { ...settings, ...gmailPolicy };
}

export function registerSettingsRoutes(app: Express, prisma: PrismaClient) {
  app.get("/api/settings", async (_req, res) => {
    try { res.json(await mergedSettings(prisma)); }
    catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.put("/api/settings", async (req, res) => {
    try {
      const { appSettings, gmailPolicy } = splitSettingsInput(req.body);
      await updateAppSettings(prisma, appSettings);
      if (Object.keys(gmailPolicy).length) await patchGmailSendPolicy(prisma, gmailPolicy);
      res.json(await mergedSettings(prisma));
    } catch (error) {
      if (error instanceof ZodError) { validationError(res, error); return; }
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.patch("/api/settings", async (req, res) => {
    try {
      const { appSettings, gmailPolicy } = splitSettingsInput(req.body);
      if (Object.keys(appSettings).length) await patchAppSettings(prisma, appSettings);
      if (Object.keys(gmailPolicy).length) await patchGmailSendPolicy(prisma, gmailPolicy);
      if (!Object.keys(appSettings).length && !Object.keys(gmailPolicy).length) {
        throw new Error("At least one setting is required");
      }
      res.json(await mergedSettings(prisma));
    } catch (error) {
      if (error instanceof ZodError) { validationError(res, error); return; }
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
