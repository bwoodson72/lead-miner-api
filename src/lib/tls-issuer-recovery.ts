import { X509Certificate } from "node:crypto";
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

export type ResearchFetchResponse = {
  ok: boolean;
  status: number;
  url: string;
  text(): Promise<string>;
};

type CachedIssuerChain = {
  ca: string[];
  expiresAt: number;
};

const issuerCache = new Map<string, CachedIssuerChain>();
const MAX_AIA_CERT_BYTES = 512 * 1024;
const MAX_PAGE_BYTES = 6 * 1024 * 1024;
const MAX_ISSUER_DEPTH = 3;
const RECOVERY_CACHE_MS = 6 * 60 * 60_000;
const CHAIN_ERROR_CODES = new Set([
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

function errorCode(error: unknown): string | null {
  let current: unknown = error;
  let depth = 0;
  while (current && depth < 5) {
    const row = current as { code?: unknown; cause?: unknown };
    if (typeof row.code === "string") return row.code;
    current = row.cause;
    depth += 1;
  }
  return null;
}

export function isRecoverableIssuerError(error: unknown) {
  const code = errorCode(error);
  return Boolean(code && CHAIN_ERROR_CODES.has(code));
}

function isPublicIp(address: string) {
  const family = net.isIP(address);
  if (family === 4) {
    const parts = address.split(".").map(Number);
    const [a, b] = parts;
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a >= 224) return false;
    return true;
  }
  if (family === 6) {
    const value = address.toLowerCase();
    if (value === "::" || value === "::1") return false;
    if (value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb")) return false;
    return true;
  }
  return false;
}

async function resolvePublicAddress(hostname: string) {
  if (net.isIP(hostname)) {
    if (!isPublicIp(hostname)) throw new Error("AIA issuer URL resolves to a non-public address");
    return hostname;
  }
  const rows = await lookup(hostname, { all: true, verbatim: true });
  const address = rows.map((row) => row.address).find(isPublicIp);
  if (!address) throw new Error("AIA issuer hostname has no public address");
  return address;
}

function certificateIsCurrent(cert: X509Certificate) {
  const now = Date.now();
  return cert.validFromDate.getTime() <= now && cert.validToDate.getTime() >= now;
}

function parseAiaIssuerUrls(cert: X509Certificate): string[] {
  const values: string[] = [];
  for (const line of cert.infoAccess.split(/\r?\n/)) {
    if (!/CA Issuers/i.test(line)) continue;
    const match = line.match(/URI:(.+)$/i);
    if (!match?.[1]) continue;
    let value = match[1].trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      try { value = JSON.parse(value); } catch { continue; }
    }
    try {
      const url = new URL(value);
      if (url.protocol === "http:" || url.protocol === "https:") values.push(url.toString());
    } catch { /* ignore malformed AIA entries */ }
  }
  return [...new Set(values)];
}

async function requestBytes(url: string, maxBytes: number, timeoutMs = 6_000, redirects = 0): Promise<{ bytes: Buffer; finalUrl: string }> {
  if (redirects > 3) throw new Error("Too many AIA redirects");
  const target = new URL(url);
  if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error("Unsupported AIA protocol");
  const address = await resolvePublicAddress(target.hostname);
  const transport = target.protocol === "https:" ? https : http;

  return await new Promise((resolve, reject) => {
    const request = transport.request({
      protocol: target.protocol,
      hostname: address,
      port: target.port || undefined,
      path: `${target.pathname}${target.search}`,
      method: "GET",
      servername: target.protocol === "https:" ? target.hostname : undefined,
      headers: { Host: target.host, Accept: "application/pkix-cert, application/x-x509-ca-cert, */*" },
      timeout: timeoutMs,
    }, (response) => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.resume();
        requestBytes(new URL(location, target).toString(), maxBytes, timeoutMs, redirects + 1).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new Error(`AIA issuer request returned HTTP ${status}`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          response.destroy(new Error("AIA issuer certificate exceeded size limit"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({ bytes: Buffer.concat(chunks), finalUrl: target.toString() }));
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error("AIA issuer request timed out")));
    request.on("error", reject);
    request.end();
  });
}

function defaultTrustCertificates() {
  return tls.getCACertificates("default");
}

function findTrustedIssuer(cert: X509Certificate): X509Certificate | null {
  for (const pem of defaultTrustCertificates()) {
    try {
      const root = new X509Certificate(pem);
      if (!certificateIsCurrent(root)) continue;
      if (cert.fingerprint256 === root.fingerprint256) return root;
      if (cert.checkIssued(root) && cert.verify(root.publicKey)) return root;
    } catch { /* ignore an unparsable trust entry */ }
  }
  return null;
}

async function fetchVerifiedIssuer(child: X509Certificate): Promise<X509Certificate> {
  const urls = parseAiaIssuerUrls(child);
  if (!urls.length) throw new Error(`Certificate issuer ${child.issuer} has no HTTP(S) CA Issuers AIA URL`);

  const errors: string[] = [];
  for (const url of urls) {
    try {
      const { bytes } = await requestBytes(url, MAX_AIA_CERT_BYTES);
      const issuer = new X509Certificate(bytes);
      if (!issuer.ca) throw new Error("Recovered issuer is not a CA certificate");
      if (!certificateIsCurrent(issuer)) throw new Error("Recovered issuer certificate is not currently valid");
      if (!child.checkIssued(issuer) || !child.verify(issuer.publicKey)) {
        throw new Error("Recovered certificate does not cryptographically issue the presented certificate");
      }
      return issuer;
    } catch (error) {
      errors.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`Could not recover a valid issuer certificate. ${errors.join(" | ")}`);
}

async function presentedChain(hostname: string, port: number): Promise<X509Certificate[]> {
  return await new Promise((resolve, reject) => {
    const socket = tls.connect({ host: hostname, port, servername: hostname, rejectUnauthorized: false }, () => {
      try {
        const peer = socket.getPeerCertificate(true);
        if (!peer?.raw?.length) throw new Error("Server did not present a certificate");
        const chain: X509Certificate[] = [];
        const seen = new Set<string>();
        let current: typeof peer | undefined = peer;
        while (current?.raw?.length) {
          const cert = new X509Certificate(current.raw);
          if (seen.has(cert.fingerprint256)) break;
          seen.add(cert.fingerprint256);
          chain.push(cert);
          const next = current.issuerCertificate;
          if (!next?.raw?.length || next === current) break;
          current = next;
        }
        if (!chain[0]?.checkHost(hostname)) throw new Error("Presented leaf certificate does not match requested hostname");
        for (const cert of chain) {
          if (!certificateIsCurrent(cert)) throw new Error("Presented certificate chain contains an expired or not-yet-valid certificate");
        }
        for (let index = 0; index < chain.length - 1; index += 1) {
          const child = chain[index];
          const parent = chain[index + 1];
          if (!child.checkIssued(parent) || !child.verify(parent.publicKey)) {
            throw new Error("Presented certificate chain contains an invalid issuer relationship");
          }
        }
        resolve(chain);
      } catch (error) {
        reject(error);
      } finally {
        socket.end();
      }
    });
    socket.setTimeout(6_000, () => socket.destroy(new Error("TLS certificate inspection timed out")));
    socket.on("error", reject);
  });
}

async function recoverIssuerChain(target: URL): Promise<string[]> {
  const cacheKey = `${target.hostname}:${target.port || "443"}`;
  const cached = issuerCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.ca;

  const chain = await presentedChain(target.hostname, Number(target.port || 443));
  let current = chain[chain.length - 1];
  const recovered: X509Certificate[] = [];

  if (findTrustedIssuer(current)) return [];

  for (let depth = 0; depth < MAX_ISSUER_DEPTH; depth += 1) {
    const issuer = await fetchVerifiedIssuer(current);
    recovered.push(issuer);
    if (findTrustedIssuer(issuer)) {
      const ca = recovered.map((cert) => cert.toString());
      issuerCache.set(cacheKey, { ca, expiresAt: Math.min(Date.now() + RECOVERY_CACHE_MS, ...recovered.map((cert) => cert.validToDate.getTime())) });
      return ca;
    }
    current = issuer;
  }

  throw new Error("Recovered issuer chain did not terminate at a Node-trusted CA");
}

async function verifiedHttpsText(url: string, ca: string[], headers: HeadersInit | undefined, signal: AbortSignal | null | undefined, redirects = 0): Promise<ResearchFetchResponse> {
  if (redirects > 5) throw new Error("Too many HTTPS redirects during issuer-recovery fetch");
  const target = new URL(url);
  if (target.protocol !== "https:") {
    const response = await fetch(target, { headers, signal: signal ?? undefined, redirect: "follow" });
    return response;
  }

  const trusted = [...defaultTrustCertificates(), ...ca];
  return await new Promise((resolve, reject) => {
    const request = https.request(target, {
      method: "GET",
      headers: headers ? Object.fromEntries(new Headers(headers).entries()) : undefined,
      ca: trusted,
      rejectUnauthorized: true,
      servername: target.hostname,
      timeout: 12_000,
    }, (response) => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.resume();
        const next = new URL(location, target).toString();
        verifiedHttpsText(next, ca, headers, signal, redirects + 1).then(resolve, reject);
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_PAGE_BYTES) {
          response.destroy(new Error("Recovered HTTPS response exceeded size limit"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({ ok: status >= 200 && status < 300, status, url: target.toString(), async text() { return body; } });
      });
      response.on("error", reject);
    });
    const abort = () => request.destroy(new Error("Request aborted"));
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }
    request.on("timeout", () => request.destroy(new Error("Recovered HTTPS request timed out")));
    request.on("error", reject);
    request.end();
  });
}

export async function fetchWithTlsIssuerRecovery(
  url: string,
  init: Pick<RequestInit, "headers" | "signal" | "redirect"> = {},
): Promise<ResearchFetchResponse> {
  try {
    return await fetch(url, init);
  } catch (error) {
    const target = new URL(url);
    if (target.protocol !== "https:" || !isRecoverableIssuerError(error)) throw error;

    const ca = await recoverIssuerChain(target);
    if (!ca.length) throw error;
    console.warn(`[Research crawl] recovered ${ca.length} missing TLS issuer certificate${ca.length === 1 ? "" : "s"} for ${target.hostname}; retrying with verification enabled`);
    return await verifiedHttpsText(target.toString(), ca, init.headers, init.signal);
  }
}
