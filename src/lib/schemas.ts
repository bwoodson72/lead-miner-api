import { z } from "zod";

export const KeywordInputSchema = z.object({
  keywords: z.string().min(1),
  performanceScore: z.number().default(60),
  lcp: z.number().default(4000),
  cls: z.number().default(0.25),
  tbt: z.number().default(300),
  email: z.string().email(),
  location: z.string().optional().default(""),
  maxDomains: z.number().min(1).max(50).default(20),
});

export type KeywordInput = z.infer<typeof KeywordInputSchema>;

export const SerpAdSchema = z.object({
  keyword: z.string(),
  adTitle: z.string(),
  landingPageUrl: z.string().url(),
  displayDomain: z.string(),
});

export type SerpAd = z.infer<typeof SerpAdSchema>;

export const LeadRecordSchema = z.object({
  keyword: z.string(),
  domain: z.string(),
  landingPageUrl: z.string().url(),
  performanceScore: z.number(),
  lcp: z.number(),
  cls: z.number(),
  tbt: z.number(),
  timestamp: z.string(),
});

export type LeadRecord = z.infer<typeof LeadRecordSchema>;
