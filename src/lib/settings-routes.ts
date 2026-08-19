import type { Express } from "express";
import type { PrismaClient } from "../generated/prisma/client.js";
import { ZodError } from "zod";
import { getAppSettings, patchAppSettings, updateAppSettings } from "./settings.js";
import { getGmailSendState } from "./gmail-send-state.js";

function validationError(res: any, error: ZodError, label = "settings") {
  res.status(400).json({ error: `Invalid ${label}`, issues: error.issues });
}

async function settingsWithSendState(prisma: PrismaClient) {
  const [settings, state] = await Promise.all([getAppSettings(prisma), getGmailSendState(prisma)]);
  return {
    ...settings,
    gmailQuotaCooldownUntil: state.cooldownUntil,
    gmailQuotaCooldownReason: state.cooldownReason,
  };
}

export function registerSettingsRoutes(app: Express, prisma: PrismaClient) {
  app.get("/api/settings", async (_req, res) => {
    try { res.json(await settingsWithSendState(prisma)); }
    catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.put("/api/settings", async (req, res) => {
    try {
      await updateAppSettings(prisma, req.body);
      res.json(await settingsWithSendState(prisma));
    } catch (error) {
      if (error instanceof ZodError) { validationError(res, error); return; }
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.patch("/api/settings", async (req, res) => {
    try {
      await patchAppSettings(prisma, req.body);
      res.json(await settingsWithSendState(prisma));
    } catch (error) {
      if (error instanceof ZodError) { validationError(res, error); return; }
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
