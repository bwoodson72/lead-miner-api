import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const envSchema = z.object({
  SERPER_API_KEY: z.string().min(1),
  SERPAPI_KEY: z.string().min(1).optional(),
  PAGESPEED_API_KEY: z.string().min(1),
  RESEND_API_KEY: z.string().min(1),
  REPORT_EMAIL: z.string().email(),
  DATABASE_URL: z.string().min(1),
  CRON_SECRET: z.string().min(1).optional(),
  ALLOWED_ORIGINS: z.string().optional().default("http://localhost:3000"),
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_RESEARCH_MODEL: z.string().min(1).optional().default("gpt-5.6"),
  AI_RESEARCH_BATCH_SIZE: z.coerce.number().int().min(1).max(100).optional().default(10),
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
