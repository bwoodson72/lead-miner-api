import { z } from "zod";

export const KeywordInputSchema = z.object({
  keywords: z.string().min(1),
  performanceScore: z.number().default(60),
  lcp: z.number().default(4000),
  cls: z.number().default(0.25),
  tbt: z.number().default(300),
  email: z.string().email(),
  location: z.string().optional().default(""),
  maxDomains: z.number().min(1).max(200).default(100),
});

export type KeywordInput = z.infer<typeof KeywordInputSchema>;

export const SerpAdSchema = z.object({
  keyword: z.string(),
  adTitle: z.string(),
  landingPageUrl: z.string().url(),
  displayDomain: z.string(),
  adSource: z.enum(["paid_ad", "local_organic"]),
  // Business metadata from search results (optional)
  businessName: z.string().optional(),
  phone: z.string().optional(),
  address: z.string().optional(),
  sourceTitle: z.string().optional(),
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
  adSource: z.enum(["paid_ad", "local_organic"]),
  timestamp: z.string(),
  // PageSpeed metadata (optional)
  pagespeedStrategy: z.enum(["mobile", "desktop"]).optional(),
  pagespeedTestedAt: z.string().optional(),
  pagespeedReportUrl: z.string().url().optional(),
  sourceTitle: z.string().optional(),
  // Lead enrichment fields (optional)
  businessName: z.string().optional(),
  contactPageUrl: z.string().url().optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  address: z.string().optional(),
  enrichmentStatus: z.enum(["pending", "enriched", "failed", "skipped"]).optional(),
  enrichmentNotes: z.string().optional(),
  isAgencyManaged: z.boolean().optional(),
  agencyName: z.string().optional(),
  isNationalChain: z.boolean().optional(),
  chainReason: z.string().optional(),
});

export type LeadRecord = z.infer<typeof LeadRecordSchema>;
