export type RepresentativeContentType = "service" | "location" | "about" | "other";

export type ContentDepthAssessment = {
  rating: "thin" | "limited" | "adequate" | "unknown";
  materialityHint: "strong" | "supporting" | "weak" | "none";
  substantiveWordCount: number;
  wholePageWordCount: number;
  shellWordCount: number;
  meaningfulParagraphCount: number;
  detailHeadingCount: number;
  meaningfulListItemCount: number;
  serviceTopics: string[];
  reason: string;
};

const SERVICE_TOPICS: Array<{ label: string; pattern: RegExp }> = [
  { label: "remodeling", pattern: /\b(?:remodel(?:s|ing|ed)?|renovat(?:e|ed|ion|ions))\b/i },
  { label: "kitchen", pattern: /\bkitchens?\b/i },
  { label: "bathroom", pattern: /\b(?:bathrooms?|baths?)\b/i },
  { label: "roofing", pattern: /\b(?:roofs?|roofing)\b/i },
  { label: "concrete", pattern: /\bconcrete\b/i },
  { label: "painting", pattern: /\b(?:paint|paints|painting|painted)\b/i },
  { label: "commercial construction", pattern: /\bcommercial\b/i },
  { label: "plumbing", pattern: /\bplumb(?:er|ers|ing)?\b/i },
  { label: "electrical", pattern: /\belectric(?:al|ian|ians)?\b/i },
  { label: "hvac", pattern: /\b(?:hvac|heating|air conditioning)\b/i },
  { label: "landscaping", pattern: /\blandscap(?:e|es|ing)?\b/i },
  { label: "foundation", pattern: /\bfoundations?\b/i },
  { label: "siding", pattern: /\bsiding\b/i },
  { label: "gutters", pattern: /\bgutters?\b/i },
  { label: "flooring", pattern: /\bfloor(?:ing|s)?\b/i },
  { label: "windows", pattern: /\bwindows?\b/i },
  { label: "doors", pattern: /\bdoors?\b/i },
  { label: "additions", pattern: /\b(?:home )?additions?\b/i },
  { label: "decks", pattern: /\bdecks?\b/i },
];

function decodeHtml(value: string) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function textOnly(value: string) {
  return decodeHtml(value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<template[\s\S]*?<\/template>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " "));
}

function wordCount(value: string) {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function firstElementInnerHtml(html: string, tag: "main" | "article" | "body") {
  return html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1] ?? null;
}

function removePageChrome(html: string) {
  return html
    .replace(/<(?:header|nav|footer|aside)\b[^>]*>[\s\S]*?<\/(?:header|nav|footer|aside)>/gi, " ")
    .replace(/<form\b[^>]*>[\s\S]*?<\/form>/gi, " ")
    .replace(/<button\b[^>]*>[\s\S]*?<\/button>/gi, " ");
}

export function extractSubstantiveHtml(html: string) {
  const main = firstElementInnerHtml(html, "main");
  const article = firstElementInnerHtml(html, "article");
  const body = firstElementInnerHtml(html, "body");
  return removePageChrome(main ?? article ?? body ?? html);
}

function elementTexts(html: string, tagPattern: string) {
  return Array.from(html.matchAll(new RegExp(`<(?:${tagPattern})\\b[^>]*>([\\s\\S]*?)<\\/(?:${tagPattern})>`, "gi")))
    .map((match) => textOnly(match[1] ?? ""))
    .filter(Boolean);
}

function uniqueChunks(values: string[]) {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(value);
  }
  return output;
}

function substantiveTextFromHtml(html: string) {
  const structured = uniqueChunks([
    ...elementTexts(html, "h1|h2|h3"),
    ...elementTexts(html, "p"),
    ...elementTexts(html, "li").filter((value) => value.length >= 15),
  ]);
  const structuredText = structured.join(" ").trim();
  if (wordCount(structuredText) >= 20) return structuredText;
  return textOnly(html);
}

function serviceTopics(value: string) {
  return SERVICE_TOPICS.filter((topic) => topic.pattern.test(value)).map((topic) => topic.label);
}

export function analyzeContentDepth(
  html: string,
  type: RepresentativeContentType,
  wholePageWordCount?: number,
): ContentDepthAssessment {
  const visibleWholePageWords = wholePageWordCount ?? wordCount(textOnly(html));
  const substantiveHtml = extractSubstantiveHtml(html);
  const substantiveText = substantiveTextFromHtml(substantiveHtml);
  const substantiveWordCount = wordCount(substantiveText);
  const shellWordCount = Math.max(0, visibleWholePageWords - substantiveWordCount);
  const meaningfulParagraphCount = elementTexts(substantiveHtml, "p").filter((value) => wordCount(value) >= 8).length;
  const detailHeadingCount = elementTexts(substantiveHtml, "h2|h3").length;
  const meaningfulListItemCount = elementTexts(substantiveHtml, "li").filter((value) => wordCount(value) >= 4).length;
  const topics = serviceTopics(substantiveText);

  if (type !== "service" || substantiveWordCount === 0) {
    return {
      rating: substantiveWordCount === 0 ? "unknown" : "adequate",
      materialityHint: "none",
      substantiveWordCount,
      wholePageWordCount: visibleWholePageWords,
      shellWordCount,
      meaningfulParagraphCount,
      detailHeadingCount,
      meaningfulListItemCount,
      serviceTopics: topics,
      reason: type === "service"
        ? "No substantive service-page text was available for deterministic content-depth assessment."
        : "Content-depth materiality is evaluated deterministically only for sampled service pages.",
    };
  }

  const detailUnits = meaningfulParagraphCount + detailHeadingCount + Math.min(3, meaningfulListItemCount);
  const broadThinHub = topics.length >= 3 && substantiveWordCount < 140 && detailUnits <= 2;
  const extremelyThin = substantiveWordCount < 55 && detailUnits <= 1;
  const limited = substantiveWordCount < 120 && detailUnits < 3;

  if (broadThinHub) {
    return {
      rating: "thin",
      materialityHint: "strong",
      substantiveWordCount,
      wholePageWordCount: visibleWholePageWords,
      shellWordCount,
      meaningfulParagraphCount,
      detailHeadingCount,
      meaningfulListItemCount,
      serviceTopics: topics,
      reason: `The sampled service page covers ${topics.length} distinct service topics in ${substantiveWordCount} substantive words with only ${detailUnits} meaningful detail unit${detailUnits === 1 ? "" : "s"}.`,
    };
  }

  if (extremelyThin) {
    return {
      rating: "thin",
      materialityHint: "supporting",
      substantiveWordCount,
      wholePageWordCount: visibleWholePageWords,
      shellWordCount,
      meaningfulParagraphCount,
      detailHeadingCount,
      meaningfulListItemCount,
      serviceTopics: topics,
      reason: `The sampled service page contains only ${substantiveWordCount} substantive words and ${detailUnits} meaningful detail unit${detailUnits === 1 ? "" : "s"}; short length alone is supporting evidence rather than a rebuild decision.`,
    };
  }

  if (limited) {
    return {
      rating: "limited",
      materialityHint: "weak",
      substantiveWordCount,
      wholePageWordCount: visibleWholePageWords,
      shellWordCount,
      meaningfulParagraphCount,
      detailHeadingCount,
      meaningfulListItemCount,
      serviceTopics: topics,
      reason: `The sampled service page has ${substantiveWordCount} substantive words and ${detailUnits} meaningful detail units; evaluate the actual service detail before treating this as material.`,
    };
  }

  return {
    rating: "adequate",
    materialityHint: "none",
    substantiveWordCount,
    wholePageWordCount: visibleWholePageWords,
    shellWordCount,
    meaningfulParagraphCount,
    detailHeadingCount,
    meaningfulListItemCount,
    serviceTopics: topics,
    reason: `The sampled service page has ${substantiveWordCount} substantive words and ${detailUnits} meaningful detail units, so deterministic thin-content criteria are not met.`,
  };
}
