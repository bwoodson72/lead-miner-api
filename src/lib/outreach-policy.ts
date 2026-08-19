export type OutreachPolicyPattern = {
  label: string;
  pattern: string;
};

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function literalPattern(value: string) {
  return escapeRegex(value).replace(/\\ /g, "\\s+");
}

function listLabels(values: readonly OutreachPolicyPattern[]) {
  return values.map((value) => value.label).join(", ");
}

export const OUTREACH_POLICY = {
  version: "outreach-policy-v1",
  offer: {
    service: "new custom website",
    senderWork: "builds new custom websites for service businesses",
    prospectFacingPositioning: "Brian builds custom websites for service businesses",
    existingSiteWorkOffered: false,
    prohibitedExistingSiteActions: [
      { label: "optimize", pattern: "optimi[sz]e" },
      { label: "repair", pattern: "repair" },
      { label: "tune", pattern: "tune" },
      { label: "speed up", pattern: "speed\\s+up" },
      { label: "improve", pattern: "improve" },
      { label: "patch", pattern: "patch" },
      { label: "maintain", pattern: "maintain" },
    ] as const,
    prohibitedExistingSiteServices: [
      { label: "optimization", pattern: "optimi[sz]ation" },
      { label: "tuning", pattern: "tuning" },
      { label: "repair", pattern: "repairs?" },
      { label: "maintenance", pattern: "maintenance" },
      { label: "patching", pattern: "patching" },
      { label: "plugin work", pattern: "plugin\\s+work" },
      { label: "page-builder fixes", pattern: "page-builder\\s+fixes?" },
    ] as const,
    implementationTerms: [
      "Astro",
      "WordPress",
      "Wix",
      "Elementor",
      "Webflow",
      "Squarespace",
      "Shopify",
      "Drupal",
      "Joomla",
      "Next.js",
      "React",
      "React.js",
      "Vue",
      "Vue.js",
      "Svelte",
      "SvelteKit",
      "Angular",
      "Gatsby",
      "Nuxt",
      "Nuxt.js",
      "Tailwind",
      "Tailwind CSS",
      "Node.js",
      "Express.js",
      "PHP",
      "headless CMS",
      "static site generator",
      "Jamstack",
    ] as const,
    implementationDescriptors: [
      "custom-coded",
      "hand-coded",
      "tech stack",
      "technology stack",
      "implementation stack",
    ] as const,
  },
  touch1: {
    objective: "earn a reply or permission to send the details",
    greeting: "Hi,",
    targetWordRange: "55 to 100 words",
    validationMinWords: 45,
    validationMaxWords: 110,
    subjectMaxWords: 9,
    prohibitedAskTerms: [
      { label: "consultation", pattern: "consultation" },
      { label: "meeting", pattern: "meeting" },
      { label: "schedule", pattern: "schedule" },
      { label: "calendar", pattern: "calendar" },
      { label: "book", pattern: "book" },
      { label: "15 minutes", pattern: "15\\s+minutes" },
      { label: "10 minutes", pattern: "10\\s+minutes" },
      { label: "20 minutes", pattern: "20\\s+minutes" },
      { label: "quick call", pattern: "quick\\s+call" },
      { label: "brief call", pattern: "brief\\s+call" },
      { label: "conversation", pattern: "conversation" },
    ] as const,
    prohibitedSubjectTerms: [
      "free audit",
      "website audit",
      "urgent",
      "act now",
      "limited time",
      "quick question",
      "proposal",
      "opportunity",
    ] as const,
  },
} as const;

export const OUTREACH_VALIDATION_MESSAGES = {
  senderIdentity: `Give brief natural context that the sender ${OUTREACH_POLICY.offer.senderWork}; do not force a canned bio sentence.`,
  implementationStack: `Remove framework, CMS, platform, coding-stack, or implementation details. Prospect-facing positioning is simply that ${OUTREACH_POLICY.offer.prospectFacingPositioning}.`,
  existingSiteWork: `Do not offer work on the prospect's current website. If sender context is needed, say only that ${OUTREACH_POLICY.offer.prospectFacingPositioning}.`,
  cta: `Use one tiny reply/permission question whose only job is to ${OUTREACH_POLICY.touch1.objective}; do not ask for a meeting, call, consultation, booking, diagnosis, or work on the current site in Touch 1.`,
  subject: `Use a mundane, specific subject of ${OUTREACH_POLICY.touch1.subjectMaxWords} words or fewer; no hype, technical timing, or generic Quick question subject.`,
  length: `Keep the complete email roughly ${OUTREACH_POLICY.touch1.targetWordRange}; do not pad it.`,
} as const;

export function getOutreachOfferContext() {
  return {
    service: OUTREACH_POLICY.offer.service,
    existingSiteWork: `not offered: ${listLabels(OUTREACH_POLICY.offer.prohibitedExistingSiteServices)}`,
    prospectFacingPositioning: `${OUTREACH_POLICY.offer.prospectFacingPositioning}; no framework, CMS, platform, or implementation details`,
  };
}

export function buildHardOutreachRules() {
  const prohibitedWork = listLabels(OUTREACH_POLICY.offer.prohibitedExistingSiteServices);
  const implementationTerms = OUTREACH_POLICY.offer.implementationTerms.join(", ");
  return [
    "Write Touch 1 as a short email Brian would personally type after noticing one real thing on a business website.",
    `Brian's actual service is a ${OUTREACH_POLICY.offer.service} for service businesses. He does not sell ${prohibitedWork} on an existing website. Never imply that he will perform work on the prospect's current implementation.`,
    "The lead reaching this stage has been qualified because a custom rebuild is a reasonable business option. Touch 1 still should not pitch the rebuild; use the verified finding to earn a reply first.",
    `The goal is only to ${OUTREACH_POLICY.touch1.objective}. Do not try to book a consultation, meeting, calendar slot, or call in this first email.`,
    "Use one verified observation and one owner stake. The persuasion should come from why the fact matters, not from sales language.",
    "Use the supplied psychological lever as private strategy. Do not name the technique. If a buyer moment is supplied and it reads naturally, use at most one short scenario so the owner can picture the consequence.",
    "Loss aversion, self-interest, competitive choice, protecting existing spend, trust, and ease of action should shape what you say, not make the email sound like advertising copy.",
    "Write in ordinary spoken English. Contractions and simple phrases are welcome. Prefer words a service-business owner would use over analyst or consultant terminology.",
    "Do not copy or lightly paraphrase the private notes. Write the email from scratch as if the sender personally noticed the issue.",
    "Never invent traffic loss, lead loss, revenue loss, ad spend, rankings, urgency, customer behavior, or business plans. Imagined customer behavior must remain a possibility, never a known event.",
    "When measured elapsed time helps communicate severity, you may use a rounded, human-readable duration such as about 20 seconds, close to a minute, or over a minute. Do not expose milliseconds, performance metric names, scores, benchmark values, percentages from testing, or overly precise decimal timing copied from tools.",
    "Never mention Lighthouse, PageSpeed, Core Web Vitals, LCP, CLS, TBT, audit/performance scores, crawlers, evidence sources, Lead Miner, or AI research.",
    `Never mention the implementation stack, framework, CMS, platform, page builder, coding approach, or how a new site would be built. Do not mention ${implementationTerms}, or similar technologies. Prospect-facing positioning is simply that ${OUTREACH_POLICY.offer.prospectFacingPositioning}.`,
    "Do not explain implementation details, diagnose the whole website, prescribe a repair checklist, offer work on the existing site, or sell the project.",
    "Do not tease an implementation diagnosis with wording such as what may be contributing, what may be causing it, root cause, or where it affects the page. The offer in Touch 1 is to send the observation or details, not to troubleshoot the existing site.",
    `Start bodyText exactly with ${OUTREACH_POLICY.touch1.greeting} on its own line followed by a blank line. Do not invent a recipient name or team name.`,
    `Give enough context somewhere in the email that it is clear the sender ${OUTREACH_POLICY.offer.senderWork}. Use whatever short wording fits the email; do not force the same sentence into every message.`,
    `End with one small, low-pressure question that makes replying easy, usually permission to send what was found or see the details. Its only job is to ${OUTREACH_POLICY.touch1.objective}. Do not use formal consultation language and do not offer work on the existing site in the CTA.`,
    "The cta field must exactly match that final question in bodyText.",
    "Sign off with the sender's first name on its own line. No signature block.",
    `Use a mundane, specific subject tied to the page, location, service, or thing noticed. Keep it under ${OUTREACH_POLICY.touch1.subjectMaxWords} words. Do not put timing measurements in the subject. No hype, fake urgency, Free audit, Website audit, or Quick question.`,
    `Keep the whole email roughly ${OUTREACH_POLICY.touch1.targetWordRange}.`,
    "No fake familiarity, generic compliments, flattery, guilt, fearmongering, exaggerated claims, or manufactured urgency.",
    "Return only the required structured draft.",
  ].join(" ");
}

export function containsProspectFacingImplementationStack(value: string) {
  const terms = OUTREACH_POLICY.offer.implementationTerms.map(literalPattern).join("|");
  const descriptors = OUTREACH_POLICY.offer.implementationDescriptors.map(literalPattern).join("|");
  if (new RegExp(`\\b(?:${terms})\\b`, "i").test(value)) return true;
  if (new RegExp(`\\b(?:${descriptors})\\b`, "i").test(value)) return true;
  return /\b(?:build(?:s|ing)?|built|develop(?:s|ed|ing)?|code(?:s|d|ing)?|using|uses?|powered by|runs? on|work(?:s|ing)?\s+(?:with|in|on)|framework|stack|platform)\b[^.!?\n]{0,50}\b(?:Astro|React|Vue|Svelte|Angular)\b/i.test(value);
}

export function containsDisallowedExistingSiteServiceOffer(value: string) {
  const offerPrefix = "(?:i\\s+(?:can|could|would|will)|want me to|should i|can i|could i|would you like me to|do you want me to)";
  const existingTarget = "(?:(?:the|your|this)(?:\\s+(?:current|existing))?|current|existing)\\s+(?:website|site|page|homepage|implementation)";
  const platformTarget = "(?:(?:the|your|this)\\s+)?(?:wordpress|wix|elementor|page-builder)\\s+(?:website|site|page|homepage|implementation)";
  const genericTarget = "(?:websites?|sites?|pages?)";
  const actions = OUTREACH_POLICY.offer.prohibitedExistingSiteActions.map((action) => action.pattern).join("|");
  const directOffer = new RegExp(`\\b${offerPrefix}\\s+(?:help\\s+(?:you\\s+)?(?:to\\s+)?|help\\s+with\\s+)?(?:${actions})\\s+(?:${existingTarget}|${platformTarget}|${genericTarget})\\b`, "i");
  const serviceNouns = OUTREACH_POLICY.offer.prohibitedExistingSiteServices.map((service) => service.pattern).join("|");
  const nounOffer = new RegExp(`\\b(?:i\\s+(?:offer|provide|do|handle|specialize in)|my\\s+services?\\s+(?:include|cover))\\s+(?:website\\s+|site\\s+|wordpress\\s+|wix\\s+|elementor\\s+|page-builder\\s+)?(?:${serviceNouns})\\b`, "i");
  return directOffer.test(value) || nounOffer.test(value);
}

export function containsProhibitedTouch1Ask(value: string) {
  const patterns = OUTREACH_POLICY.touch1.prohibitedAskTerms.map((term) => term.pattern).join("|");
  return new RegExp(`\\b(?:${patterns})\\b`, "i").test(value);
}

export function containsProhibitedSubjectLanguage(value: string) {
  const patterns = OUTREACH_POLICY.touch1.prohibitedSubjectTerms.map(literalPattern).join("|");
  return new RegExp(`\\b(?:${patterns})\\b`, "i").test(value);
}
