import { domainsMatch } from "./enrichment-identity.js";

export type ContactSafetyEvidence = {
  type: string;
  value: string;
  source?: string | null;
  verificationStatus?: string | null;
  isPrimary?: boolean;
};

export type ContactSafetyLead = {
  email: string | null;
  domain: string;
  contacts?: ContactSafetyEvidence[];
};

const PUBLIC_MAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "aol.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
]);

const HARD_BLOCKED_CONTACT_DOMAINS = [
  /(^|\.)sentry\.io$/i,
  /(^|\.)sentry-next\.wixpress\.com$/i,
  /(^|\.)wixpress\.com$/i,
  /(^|\.)prophone\.com$/i,
];

const VERIFIED_CONTACT_STATUSES = new Set([
  "identity_verified",
  "identity_verified_search",
  "manually_verified",
  "verified",
]);

function normalizeDomain(value: string) {
  return value.trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
}

export function isObviousNonProspectEmail(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  const [local = "", domain = ""] = normalized.split("@");
  if (!local || !domain) return true;
  if (HARD_BLOCKED_CONTACT_DOMAINS.some((pattern) => pattern.test(domain))) return true;
  if (/^(?:jane\.doe|john\.doe|example|test|demo|sample|noreply|no-reply|do-not-reply|donotreply|mailer-daemon|postmaster|webmaster)$/i.test(local)) return true;
  if (/^[a-f0-9]{24,}$/i.test(local)) return true;
  if (/^(?:example|test|demo|sample)\d*$/i.test(local)) return true;
  return false;
}

export function getContactIdentityRiskReason(lead: ContactSafetyLead): string | null {
  const email = lead.email?.trim().toLowerCase();
  if (!email) return "Lead has no email address";
  if (isObviousNonProspectEmail(email)) return `Recipient address ${email} looks like placeholder, telemetry, or service-provider infrastructure`;

  const emailDomain = email.split("@")[1];
  if (!emailDomain) return `Recipient address ${email} is malformed`;
  if (domainsMatch(emailDomain, normalizeDomain(lead.domain))) return null;
  if (PUBLIC_MAIL_DOMAINS.has(normalizeDomain(emailDomain))) return null;

  const evidence = (lead.contacts ?? []).find((contact) =>
    contact.type === "email"
    && contact.value.trim().toLowerCase() === email
    && contact.isPrimary !== false
    && VERIFIED_CONTACT_STATUSES.has(contact.verificationStatus ?? ""),
  );
  if (evidence) return null;

  return `Cross-domain recipient ${email} is not identity-verified for ${normalizeDomain(lead.domain)}`;
}
