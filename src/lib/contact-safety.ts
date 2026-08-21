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

const HARD_BLOCKED_CONTACT_DOMAINS = [
  /(^|\.)sentry\.io$/i,
  /(^|\.)sentry-next\.wixpress\.com$/i,
  /(^|\.)wixpress\.com$/i,
  /(^|\.)prophone\.com$/i,
];

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

  const parts = email.split("@");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return `Recipient address ${email} is malformed`;

  // A domain mismatch is not, by itself, evidence that the address belongs to the
  // wrong business. Small businesses commonly use consumer mailboxes, legacy
  // domains, parent-company domains, and other valid cross-domain addresses.
  // Keep blocking addresses that are independently recognizable as placeholders
  // or provider infrastructure, but do not require domain matching or a stored
  // identity-verification record merely to prepare, approve, or send outreach.
  return null;
}
