import { z } from "zod";
import { getEnv } from "./env.js";

export const ResearchResultSchema = z.object({
  decision: z.enum(["qualified", "disqualified", "needs_review"]),
  scores: z.object({ businessFit: z.number().int().min(0).max(10), websiteNeed: z.number().int().min(0).max(10), abilityToPay: z.number().int().min(0).max(10), contactability: z.number().int().min(0).max(10), urgency: z.number().int().min(0).max(10), salesOpportunity: z.number().int().min(0).max(10) }),
  problems: z.array(z.object({ category: z.string().min(1), title: z.string().min(1), evidence: z.string().min(1), businessConsequence: z.string().min(1), recommendedImprovement: z.string().optional().default(""), confidence: z.number().min(0).max(1), outreachValue: z.enum(["low", "medium", "high"]) })).max(8),
  researchSummary: z.string().min(1), primaryOutreachAngle: z.string().nullable(), qualificationReason: z.string().min(1), confidence: z.number().min(0).max(1),
});
export type ResearchResult = z.infer<typeof ResearchResultSchema>;
export type ResearchLead = { businessName: string | null; domain: string; landingPageUrl: string; keyword: string; adSource: string; lighthouseScore: number; lcp: number; cls: number | null; tbt: number | null; email: string | null; phone: string | null; address: string | null; enrichmentNotes: string | null; isAgencyManaged: boolean; agencyName: string | null; isNationalChain: boolean; chainReason: string | null; };
export const RESEARCH_VERSION = "lead-research-v3";
export function calculatePriority(scores: ResearchResult["scores"]): number { return Math.round((scores.businessFit*.20 + scores.websiteNeed*.25 + scores.abilityToPay*.15 + scores.contactability*.15 + scores.urgency*.10 + scores.salesOpportunity*.15)*10); }

export type WebsiteResearchPacket = {
  requestedUrl: string;
  finalUrl: string | null;
  fetchStatus: number | null;
  fetchError: string | null;
  title: string | null;
  metaDescription: string | null;
  headings: { h1: string[]; h2: string[]; h3: string[] };
  navigation: Array<{ text: string; url: string }>;
  discoveredPages: Array<{ text: string; url: string; type: "contact"|"service"|"location"|"about"|"other" }>;
  callsToAction: Array<{ text: string; url: string|null; kind: "link"|"button"|"form"|"phone"|"email" }>;
  contactSignals: { phones: string[]; emails: string[]; contactPageUrls: string[]; hasForm: boolean; formCount: number };
  architecture: { servicePages: string[]; locationPages: string[]; aboutPages: string[] };
  technologies: string[];
  contentSignals: { wordCount: number; hasSchemaMarkup: boolean; hasViewportMeta: boolean };
  pageText: string;
};

function decodeHtml(value:string){return value.replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&lt;/gi,"<").replace(/&gt;/gi,">").replace(/\s+/g," ").trim()}
function textOnly(value:string){return decodeHtml(value.replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," "))}
function attr(tag:string,name:string){const match=tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`,"i"));return match?.[1]?.trim()??null}
function absoluteUrl(href:string,base:string){try{const url=new URL(href,base);if(!/^https?:$/.test(url.protocol))return null;url.hash="";return url.toString()}catch{return null}}
function unique<T>(items:T[],key:(item:T)=>string){const seen=new Set<string>();return items.filter(item=>{const k=key(item);if(!k||seen.has(k))return false;seen.add(k);return true})}
function classifyPage(text:string,url:string):"contact"|"service"|"location"|"about"|"other"{const haystack=`${text} ${url}`.toLowerCase();if(/contact|quote|estimate|book|schedule/.test(haystack))return "contact";if(/service|repair|install|replacement|remodel|design|maintenance|solution/.test(haystack))return "service";if(/location|service-area|areas-we-serve|city|county/.test(haystack))return "location";if(/about|company|team|our-story/.test(haystack))return "about";return "other"}
function detectTechnologies(html:string){const lower=html.toLowerCase();const signals:[string,RegExp][]=[["WordPress",/wp-content|wp-includes/],["Wix",/wixstatic|wix-code/],["Squarespace",/static1\.squarespace|squarespace-cdn/],["Shopify",/cdn\.shopify|shopify-section/],["Webflow",/webflow\.js|data-wf-page/],["Next.js",/_next\/static|__next_data__/],["Nuxt",/_nuxt\//],["Astro",/astro-island|data-astro-cid/],["React",/data-reactroot|react-dom/],["Google Tag Manager",/googletagmanager\.com\/gtm\.js/],["Google Analytics",/google-analytics\.com|gtag\(/],["Meta Pixel",/connect\.facebook\.net.*fbevents|fbq\(/],["Elementor",/elementor-/],["Divi",/et_pb_/]];return signals.filter(([,pattern])=>pattern.test(lower)).map(([name])=>name)}
function extractWebsitePacket(html:string,requestedUrl:string,finalUrl:string,status:number):WebsiteResearchPacket{
  const title=textOnly(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]??"")||null;
  const metaTag=html.match(/<meta[^>]+name=["']description["'][^>]*>/i)?.[0]??html.match(/<meta[^>]+content=["'][^"']*["'][^>]+name=["']description["'][^>]*>/i)?.[0]??"";
  const metaDescription=attr(metaTag,"content");
  const heading=(level:number)=>Array.from(html.matchAll(new RegExp(`<h${level}[^>]*>([\\s\\S]*?)<\\/h${level}>`,"gi"))).map(m=>textOnly(m[1]??"")).filter(Boolean).slice(0,20);
  const anchors=Array.from(html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)).map(m=>({text:textOnly(m[2]??""),url:absoluteUrl(m[1]??"",finalUrl)})).filter((x):x is {text:string;url:string}=>Boolean(x.url));
  const sameHost=anchors.filter(x=>{try{return new URL(x.url).hostname===new URL(finalUrl).hostname}catch{return false}});
  const navBlocks=Array.from(html.matchAll(/<nav\b[^>]*>([\s\S]*?)<\/nav>/gi)).map(m=>m[1]??"").join("\n");
  const navAnchors=Array.from(navBlocks.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)).map(m=>({text:textOnly(m[2]??""),url:absoluteUrl(m[1]??"",finalUrl)})).filter((x):x is {text:string;url:string}=>Boolean(x.url&&x.text));
  const discoveredPages=unique(sameHost.filter(x=>x.text||x.url).map(x=>({...x,type:classifyPage(x.text,x.url)})),x=>x.url).slice(0,80);
  const buttonText=Array.from(html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/gi)).map(m=>textOnly(m[1]??"")).filter(Boolean);
  const ctaPattern=/contact|call|book|schedule|quote|estimate|get started|request|consult|shop|buy|learn more|free/i;
  const callsToAction=[...anchors.filter(x=>ctaPattern.test(x.text)).map(x=>({text:x.text,url:x.url,kind:"link" as const})),...buttonText.filter(x=>ctaPattern.test(x)).map(text=>({text,url:null,kind:"button" as const}))];
  const phones=unique(Array.from(html.matchAll(/(?:tel:|(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4})/gi)).map(m=>(m[0]??"").replace(/^tel:/i,"").trim()).filter(Boolean),x=>x);
  const emails=unique(Array.from(html.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)).map(m=>m[0]!.toLowerCase()),x=>x);
  const formCount=(html.match(/<form\b/gi)??[]).length;
  const pageText=textOnly(html).slice(0,18000);
  const servicePages=discoveredPages.filter(x=>x.type==="service").map(x=>x.url);
  const locationPages=discoveredPages.filter(x=>x.type==="location").map(x=>x.url);
  const aboutPages=discoveredPages.filter(x=>x.type==="about").map(x=>x.url);
  const contactPageUrls=discoveredPages.filter(x=>x.type==="contact").map(x=>x.url);
  return {requestedUrl,finalUrl,fetchStatus:status,fetchError:null,title,metaDescription,headings:{h1:heading(1),h2:heading(2),h3:heading(3)},navigation:unique(navAnchors,x=>x.url).slice(0,40),discoveredPages,callsToAction:unique(callsToAction,x=>`${x.kind}:${x.text}:${x.url??""}`).slice(0,30),contactSignals:{phones,emails,contactPageUrls,hasForm:formCount>0,formCount},architecture:{servicePages,locationPages,aboutPages},technologies:detectTechnologies(html),contentSignals:{wordCount:pageText? pageText.split(/\s+/).length:0,hasSchemaMarkup:/application\/ld\+json/i.test(html),hasViewportMeta:/<meta[^>]+name=["']viewport["']/i.test(html)},pageText};
}
async function fetchWebsitePacket(url:string):Promise<WebsiteResearchPacket>{const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),12000);try{const response=await fetch(url,{signal:controller.signal,headers:{"User-Agent":"LeadMinerResearch/1.0"},redirect:"follow"});if(!response.ok)return {requestedUrl:url,finalUrl:response.url||null,fetchStatus:response.status,fetchError:`HTTP ${response.status}`,title:null,metaDescription:null,headings:{h1:[],h2:[],h3:[]},navigation:[],discoveredPages:[],callsToAction:[],contactSignals:{phones:[],emails:[],contactPageUrls:[],hasForm:false,formCount:0},architecture:{servicePages:[],locationPages:[],aboutPages:[]},technologies:[],contentSignals:{wordCount:0,hasSchemaMarkup:false,hasViewportMeta:false},pageText:""};return extractWebsitePacket(await response.text(),url,response.url||url,response.status)}catch(error){return {requestedUrl:url,finalUrl:null,fetchStatus:null,fetchError:error instanceof Error?error.message:String(error),title:null,metaDescription:null,headings:{h1:[],h2:[],h3:[]},navigation:[],discoveredPages:[],callsToAction:[],contactSignals:{phones:[],emails:[],contactPageUrls:[],hasForm:false,formCount:0},architecture:{servicePages:[],locationPages:[],aboutPages:[]},technologies:[],contentSignals:{wordCount:0,hasSchemaMarkup:false,hasViewportMeta:false},pageText:""}}finally{clearTimeout(timeout)}}
function jsonSchema(){return {type:"object",additionalProperties:false,required:["decision","scores","problems","researchSummary","primaryOutreachAngle","qualificationReason","confidence"],properties:{decision:{type:"string",enum:["qualified","disqualified","needs_review"]},scores:{type:"object",additionalProperties:false,required:["businessFit","websiteNeed","abilityToPay","contactability","urgency","salesOpportunity"],properties:Object.fromEntries(["businessFit","websiteNeed","abilityToPay","contactability","urgency","salesOpportunity"].map(k=>[k,{type:"integer",minimum:0,maximum:10}]))},problems:{type:"array",maxItems:8,items:{type:"object",additionalProperties:false,required:["category","title","evidence","businessConsequence","recommendedImprovement","confidence","outreachValue"],properties:{category:{type:"string"},title:{type:"string"},evidence:{type:"string"},businessConsequence:{type:"string"},recommendedImprovement:{type:"string"},confidence:{type:"number",minimum:0,maximum:1},outreachValue:{type:"string",enum:["low","medium","high"]}}}},researchSummary:{type:"string"},primaryOutreachAngle:{type:["string","null"]},qualificationReason:{type:"string"},confidence:{type:"number",minimum:0,maximum:1}}}}

const HARD_RESEARCH_RULES = "Use only supplied evidence. Never invent a website problem or business fact. Treat deterministic fields such as headings, navigation, discovered pages, calls to action, contact signals, architecture, technologies, and measured performance as evidence, not assumptions. Absence from the packet is not proof that something does not exist unless the packet explicitly establishes that absence. A high-confidence problem must be directly supported by the packet. Scores are 0-10. Obvious national chains, agency-managed sites, non-businesses, and prospects with no meaningful web opportunity should not be qualified merely to fill the pipeline. Return only the required structured result.";

export async function researchLead(lead:ResearchLead, model:string, editableInstructions:string):Promise<{result:ResearchResult;model:string;inputTokens?:number;outputTokens?:number}>{
  const env=getEnv();if(!env.OPENAI_API_KEY)throw new Error("OPENAI_API_KEY is not configured");
  const website=await fetchWebsitePacket(lead.landingPageUrl);
  const evidence={lead,website};
  const systemInstructions=`${editableInstructions.trim()}\n\nNon-editable system rules:\n${HARD_RESEARCH_RULES}`;
  const response=await fetch("https://api.openai.com/v1/responses",{method:"POST",headers:{Authorization:`Bearer ${env.OPENAI_API_KEY}`,"Content-Type":"application/json"},body:JSON.stringify({model,input:[{role:"system",content:[{type:"input_text",text:systemInstructions}]},{role:"user",content:[{type:"input_text",text:`Analyze this Lead Miner evidence packet:\n${JSON.stringify(evidence)}`}]}],text:{format:{type:"json_schema",name:"lead_research",strict:true,schema:jsonSchema()}}})});
  if(!response.ok)throw new Error(`OpenAI research failed (${response.status}): ${await response.text()}`);const data=await response.json() as any;const raw=data.output_text??data.output?.flatMap((o:any)=>o.content??[]).find((c:any)=>c.type==="output_text")?.text;if(!raw)throw new Error("OpenAI returned no structured research output");return {result:ResearchResultSchema.parse(JSON.parse(raw)),model:data.model??model,inputTokens:data.usage?.input_tokens,outputTokens:data.usage?.output_tokens};
}
