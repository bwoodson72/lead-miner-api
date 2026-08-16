import {
  fetchBusinessAssetResearchPacket as fetchV8Packet,
  type BusinessAssetResearchPacket as V8BusinessAssetResearchPacket,
} from "./research-site-v8.js";
import {
  fetchProviderScrapeEvidence,
  PROVIDER_SCRAPE_WARNING,
  type ProviderScrapeEvidence,
} from "./research-provider-scrape.js";

export type BusinessAssetResearchPacket = Omit<V8BusinessAssetResearchPacket, "siteCoverage"> & {
  siteCoverage: Omit<V8BusinessAssetResearchPacket["siteCoverage"], "mode" | "warning"> & {
    mode: V8BusinessAssetResearchPacket["siteCoverage"]["mode"] | "provider_scrape_fallback";
    warning: string;
  };
  providerScrapeEvidence: ProviderScrapeEvidence;
};

function emptyProviderEvidence(url: string): ProviderScrapeEvidence {
  return {
    attempted: false,
    succeeded: false,
    requestedUrl: url,
    sourceUrl: null,
    title: null,
    text: "",
    wordCount: 0,
    warning: PROVIDER_SCRAPE_WARNING,
    error: null,
  };
}

export async function fetchBusinessAssetResearchPacket(url: string): Promise<BusinessAssetResearchPacket> {
  const packet = await fetchV8Packet(url);

  if (packet.finalUrl && !packet.fetchError) {
    return {
      ...packet,
      providerScrapeEvidence: emptyProviderEvidence(url),
    };
  }

  const providerScrapeEvidence = await fetchProviderScrapeEvidence(url);
  return {
    ...packet,
    siteCoverage: {
      ...packet.siteCoverage,
      mode: providerScrapeEvidence.succeeded ? "provider_scrape_fallback" : packet.siteCoverage.mode,
      warning: providerScrapeEvidence.succeeded
        ? `${packet.siteCoverage.warning} ${PROVIDER_SCRAPE_WARNING}`
        : packet.siteCoverage.warning,
    },
    providerScrapeEvidence,
  };
}
