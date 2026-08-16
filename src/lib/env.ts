import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const envSchema = z.object({
  SERPER_API_KEY: z.string().min(1),
  SERPAPI_KEY: z.string().min(1).optional(),
  PAGESPEED_API_KEY: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  CRON_SECRET: z.string().min(1).optional(),
  ALLOWED_ORIGINS: z.string().optional().default("http://localhost:3000"),
  OPENAI_API_KEY: z.string().min(1).optional(),
  GMAIL_CLIENT_ID: z.string().min(1).optional(),
  GMAIL_CLIENT_SECRET: z.string().min(1).optional(),
  GMAIL_REFRESH_TOKEN: z.string().min(1).optional(),
});

type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const missing = result.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error("Missing or invalid environment variables: " + missing);
  }
  cached = result.data;
  return cached;
}

export const env = new Proxy({} as Env, {
  get(_target, prop: string) {
    return getEnv()[prop as keyof Env];
  },
});
