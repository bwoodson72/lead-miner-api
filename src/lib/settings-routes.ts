import type { Express } from "express";
import type { PrismaClient } from "../generated/prisma/client.js";
import { ZodError } from "zod";
import { getAppSettings, updateAppSettings } from "./settings.js";

export function registerSettingsRoutes(app: Express, prisma: PrismaClient) {
  app.get("/api/settings", async (_req, res) => {
    try { res.json(await getAppSettings(prisma)); }
    catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.put("/api/settings", async (req, res) => {
    try { res.json(await updateAppSettings(prisma, req.body)); }
    catch (error) {
      if (error instanceof ZodError) { res.status(400).json({ error: "Invalid settings", issues: error.issues }); return; }
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
