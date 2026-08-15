import { getEnv } from "./env.js";

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
  if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET || !env.GMAIL_REFRESH_TOKEN) {
    throw new Error("Gmail provider requires GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and GMAIL_REFRESH_TOKEN");
  }
  const body = new URLSearchParams({
    client_id: env.GMAIL_CLIENT_ID,
    client_secret: env.GMAIL_CLIENT_SECRET,
    refresh_token: env.GMAIL_REFRESH_TOKEN,
    grant_type: "refresh_token",
  });
  const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!response.ok) throw new Error(`Gmail OAuth failed (${response.status}): ${await response.text()}`);
  const data = await response.json() as { access_token?: string };
  if (!data.access_token) throw new Error("Gmail OAuth returned no access token");
  return data.access_token;
}

function header(headers: Array<{ name?: string; value?: string }> | undefined, name: string) {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? null;
}

function textFromPayload(payload: any): string {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) return decodeB64url(payload.body.data);
  for (const part of payload.parts ?? []) {
    const text = textFromPayload(part);
    if (text) return text;
  }
  if (payload.body?.data) return decodeB64url(payload.body.data).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return "";
}

export type GmailMessage = {
  id: string;
  threadId: string;
  from: string | null;
  to: string | null;
  subject: string | null;
  rfcMessageId: string | null;
  date: string | null;
  text: string;
  labelIds: string[];
};

async function gmailFetch(path: string, init?: RequestInit) {
  const token = await accessToken();
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
  });
  if (!response.ok) throw new Error(`Gmail API failed (${response.status}): ${await response.text()}`);
  return response.json() as Promise<any>;
}

export async function getGmailMessage(id: string): Promise<GmailMessage> {
  const message = await gmailFetch(`/messages/${encodeURIComponent(id)}?format=full`);
  return {
    id: message.id,
    threadId: message.threadId,
    from: header(message.payload?.headers, "From"),
    to: header(message.payload?.headers, "To"),
    subject: header(message.payload?.headers, "Subject"),
    rfcMessageId: header(message.payload?.headers, "Message-ID"),
    date: header(message.payload?.headers, "Date"),
    text: textFromPayload(message.payload),
    labelIds: message.labelIds ?? [],
  };
}

export async function getGmailThread(threadId: string): Promise<GmailMessage[]> {
  const thread = await gmailFetch(`/threads/${encodeURIComponent(threadId)}?format=full`);
  return (thread.messages ?? []).map((message: any) => ({
    id: message.id,
    threadId: message.threadId,
    from: header(message.payload?.headers, "From"),
    to: header(message.payload?.headers, "To"),
    subject: header(message.payload?.headers, "Subject"),
    rfcMessageId: header(message.payload?.headers, "Message-ID"),
    date: header(message.payload?.headers, "Date"),
    text: textFromPayload(message.payload),
    labelIds: message.labelIds ?? [],
  }));
}

export async function sendGmailMessage(input: {
  fromName: string;
  fromEmail: string;
  to: string;
  subject: string;
  bodyText: string;
  threadId?: string | null;
  inReplyToMessageId?: string | null;
}) {
  const headers = [
    `From: ${input.fromName} <${input.fromEmail}>`,
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
  ];
  if (input.inReplyToMessageId) {
    headers.push(`In-Reply-To: ${input.inReplyToMessageId}`);
    headers.push(`References: ${input.inReplyToMessageId}`);
  }
  const raw = b64url(`${headers.join("\r\n")}\r\n\r\n${input.bodyText}`);
  const result = await gmailFetch("/messages/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ raw, ...(input.threadId ? { threadId: input.threadId } : {}) }),
  });
  return { id: result.id as string, threadId: result.threadId as string };
}
