import { getEnv } from "./env.js";
import { fetchWithProviderBackoff } from "./provider-retry.js";

function b64url(value: string | Buffer) {
  return Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeB64url(value?: string) {
  if (!value) return "";
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

async function accessToken() {
  const env = getEnv();
  if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET || !env.GMAIL_REFRESH_TOKEN) throw new Error("Gmail provider requires GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and GMAIL_REFRESH_TOKEN");
  const body = new URLSearchParams({ client_id: env.GMAIL_CLIENT_ID, client_secret: env.GMAIL_CLIENT_SECRET, refresh_token: env.GMAIL_REFRESH_TOKEN, grant_type: "refresh_token" });
  const response = await fetchWithProviderBackoff("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }, "Gmail OAuth");
  if (!response.ok) throw new Error(`Gmail OAuth failed (${response.status}): ${await response.text()}`);
  const data = await response.json() as { access_token?: string };
  if (!data.access_token) throw new Error("Gmail OAuth returned no access token");
  return data.access_token;
}

function header(headers: Array<{ name?: string; value?: string }> | undefined, name: string) { return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? null; }
function textFromPayload(payload: any): string {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) return decodeB64url(payload.body.data);
  for (const part of payload.parts ?? []) { const text = textFromPayload(part); if (text) return text; }
  if (payload.body?.data) return decodeB64url(payload.body.data).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return "";
}

export type GmailMessage = { id: string; threadId: string; from: string | null; to: string | null; subject: string | null; rfcMessageId: string | null; date: string | null; internalDate: Date; text: string; labelIds: string[] };
export type GmailLabel = { id: string; name: string; type?: string };

async function gmailFetch(path: string, init?: RequestInit) {
  const token = await accessToken();
  const response = await fetchWithProviderBackoff(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) } }, "Gmail API");
  if (!response.ok) throw new Error(`Gmail API failed (${response.status}): ${await response.text()}`);
  return response.json() as Promise<any>;
}

function normalize(message: any): GmailMessage {
  return { id: message.id, threadId: message.threadId, from: header(message.payload?.headers, "From"), to: header(message.payload?.headers, "To"), subject: header(message.payload?.headers, "Subject"), rfcMessageId: header(message.payload?.headers, "Message-ID"), date: header(message.payload?.headers, "Date"), internalDate: new Date(Number(message.internalDate ?? Date.now())), text: textFromPayload(message.payload), labelIds: message.labelIds ?? [] };
}

export async function getGmailMessage(id: string): Promise<GmailMessage> { return normalize(await gmailFetch(`/messages/${encodeURIComponent(id)}?format=full`)); }
export async function getGmailThread(threadId: string): Promise<GmailMessage[]> { const thread = await gmailFetch(`/threads/${encodeURIComponent(threadId)}?format=full`); return (thread.messages ?? []).map(normalize); }

export async function findGmailMessageByRfcMessageId(rfcMessageId: string): Promise<GmailMessage | null> {
  const query = encodeURIComponent(`rfc822msgid:${rfcMessageId}`);
  const result = await gmailFetch(`/messages?q=${query}&maxResults=1`);
  const id = result.messages?.[0]?.id as string | undefined;
  return id ? getGmailMessage(id) : null;
}

const LABEL_CACHE_TTL_MS = 5 * 60_000;
let labelCache: { loadedAt: number; byName: Map<string, string> } | null = null;
let labelMutationQueue: Promise<void> = Promise.resolve();

async function loadGmailLabelIds(force = false) {
  if (!force && labelCache && Date.now() - labelCache.loadedAt < LABEL_CACHE_TTL_MS) return labelCache.byName;
  const result = await gmailFetch("/labels");
  const labels = (result.labels ?? []) as GmailLabel[];
  labelCache = { loadedAt: Date.now(), byName: new Map(labels.filter((label) => label.id && label.name).map((label) => [label.name, label.id])) };
  return labelCache.byName;
}

function withLabelMutationLock<T>(operation: () => Promise<T>) {
  const result = labelMutationQueue.then(operation, operation);
  labelMutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

export async function findGmailLabelIds(names: string[]) {
  const byName = await loadGmailLabelIds();
  return new Map(names.flatMap((name) => {
    const id = byName.get(name);
    return id ? [[name, id] as const] : [];
  }));
}

export async function ensureGmailLabelIds(names: string[]) {
  const uniqueNames = Array.from(new Set(names.filter(Boolean)));
  return withLabelMutationLock(async () => {
    const byName = await loadGmailLabelIds();
    for (const name of uniqueNames) {
      if (byName.has(name)) continue;
      const created = await gmailFetch("/labels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, messageListVisibility: "show", labelListVisibility: "labelShow" }),
      }) as GmailLabel;
      if (!created.id) throw new Error(`Gmail label creation returned no id for ${name}`);
      byName.set(name, created.id);
    }
    labelCache = { loadedAt: Date.now(), byName };
    return new Map(uniqueNames.map((name) => [name, byName.get(name)!]));
  });
}

export async function getGmailThreadLabelIds(threadId: string) {
  const thread = await gmailFetch(`/threads/${encodeURIComponent(threadId)}?format=minimal`);
  return Array.from(new Set<string>((thread.messages ?? []).flatMap((message: any) => message.labelIds ?? [])));
}

export async function modifyGmailThreadLabels(threadId: string, input: { addLabelIds?: string[]; removeLabelIds?: string[] }) {
  const addLabelIds = Array.from(new Set(input.addLabelIds ?? []));
  const removeLabelIds = Array.from(new Set(input.removeLabelIds ?? [])).filter((id) => !addLabelIds.includes(id));
  if (!addLabelIds.length && !removeLabelIds.length) return null;
  return gmailFetch(`/threads/${encodeURIComponent(threadId)}/modify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ addLabelIds, removeLabelIds }),
  });
}

export async function sendGmailMessage(input: { fromName: string; fromEmail: string; to: string; subject: string; bodyText: string; messageId: string; threadId?: string | null; inReplyToMessageId?: string | null }) {
  const existing = await findGmailMessageByRfcMessageId(input.messageId);
  if (existing) return { id: existing.id, threadId: existing.threadId, reconciled: true };

  const headers = [`From: ${input.fromName} <${input.fromEmail}>`, `To: ${input.to}`, `Subject: ${input.subject}`, `Message-ID: ${input.messageId}`, "MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: 8bit"];
  if (input.inReplyToMessageId) { headers.push(`In-Reply-To: ${input.inReplyToMessageId}`); headers.push(`References: ${input.inReplyToMessageId}`); }
  const raw = b64url(`${headers.join("\r\n")}\r\n\r\n${input.bodyText}`);

  try {
    const result = await gmailFetch("/messages/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ raw, ...(input.threadId ? { threadId: input.threadId } : {}) }) });
    return { id: result.id as string, threadId: result.threadId as string, reconciled: false };
  } catch (error) {
    const reconciled = await findGmailMessageByRfcMessageId(input.messageId).catch(() => null);
    if (reconciled) return { id: reconciled.id, threadId: reconciled.threadId, reconciled: true };
    throw error;
  }
}
