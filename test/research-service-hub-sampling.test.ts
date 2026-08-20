import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseCanonicalServiceHub,
  mergeCanonicalServiceHubSummary,
} from "../src/lib/research-service-hub-sampling.js";

function depth(materialityHint: "strong" | "none" = "none") {
  return {
    rating: materialityHint === "strong" ? "thin" as const : "adequate" as const,
    materialityHint,
    substantiveWordCount: materialityHint === "strong" ? 39 : 250,
    wholePageWordCount: materialityHint === "strong" ? 84 : 280,
    shellWordCount: materialityHint === "strong" ? 45 : 30,
    meaningfulParagraphCount: materialityHint === "strong" ? 1 : 5,
    detailHeadingCount: materialityHint === "strong" ? 0 : 4,
    meaningfulListItemCount: 0,
    serviceTopics: materialityHint === "strong"
      ? ["remodeling", "concrete", "painting", "roofing", "commercial construction"]
      : ["roofing"],
    reason: materialityHint === "strong" ? "Broad thin service hub" : "Adequate service detail",
  };
}

function servicePage(url: string) {
  return {
    url,
    type: "service" as const,
    fetchStatus: 200,
    fetchError: null,
    title: "Service",
    h1: ["Service"],
    h2: [],
    wordCount: 280,
    hasForm: false,
    pageText: "Detailed service page",
    contentDepth: depth(),
  };
}

function grimeStylePacket() {
  return {
    requestedUrl: "http://grimeconstructionllc.com/",
    finalUrl: "https://www.grimeconstructionllc.com/",
    fetchStatus: 200,
    fetchError: null,
    extractionMode: "static_html_visibility_filtered_multi_page",
    visibilityWarning: "static",
    title: "Grime Construction & Roofing",
    metaDescription: null,
    headings: { h1: [], h2: [], h3: [] },
    navigation: [
      { text: "Home", url: "https://www.grimeconstructionllc.com/" },
      { text: "Services", url: "https://www.grimeconstructionllc.com/services" },
      { text: "About", url: "https://www.grimeconstructionllc.com/about" },
    ],
    discoveredPages: [
      { text: "Commercial Roofing Services", url: "https://www.grimeconstructionllc.com/store/p/commercial-roofing-services", type: "service" },
      { text: "Metal Roofs", url: "https://www.grimeconstructionllc.com/store/p/metal-roofs", type: "service" },
      { text: "Roof Repair", url: "https://www.grimeconstructionllc.com/store/p/roof-repair", type: "service" },
      { text: "Services", url: "https://www.grimeconstructionllc.com/services", type: "service" },
    ],
    callsToAction: [],
    contactSignals: { phones: [], emails: [], contactPageUrls: [], hasForm: false, formCount: 0, checkedContactPages: [] },
    architecture: {
      servicePages: [
        "https://www.grimeconstructionllc.com/store/p/commercial-roofing-services",
        "https://www.grimeconstructionllc.com/store/p/metal-roofs",
        "https://www.grimeconstructionllc.com/store/p/roof-repair",
        "https://www.grimeconstructionllc.com/services",
      ],
      locationPages: [],
      aboutPages: [],
    },
    technologies: ["Squarespace"],
    contentSignals: { wordCount: 500, hasSchemaMarkup: true, hasViewportMeta: true },
    pageText: "",
    siteCoverage: {
      mode: "landing_plus_representative_pages",
      sitemapUrlsFound: 8,
      representativePagesAttempted: 5,
      representativePagesFetched: 5,
      serviceUrlsObserved: 4,
      locationUrlsObserved: 0,
      aboutUrlsObserved: 1,
      contactUrlsObserved: 1,
      architectureEvidenceComplete: false,
      crawlerAccess: {
        initialFetchSucceeded: true,
        browserFallbackAttempted: false,
        browserFallbackSucceeded: false,
        visitorReachabilityEstablished: false,
        attempts: [],
      },
      warning: "bounded",
    },
    representativePages: [
      servicePage("https://www.grimeconstructionllc.com/store/p/commercial-roofing-services"),
      servicePage("https://www.grimeconstructionllc.com/store/p/metal-roofs"),
      servicePage("https://www.grimeconstructionllc.com/store/p/roof-repair"),
      {
        ...servicePage("https://www.grimeconstructionllc.com/about"),
        type: "about" as const,
      },
    ],
    contentDepthSummary: {
      sampledServicePages: 3,
      thinServicePages: 0,
      strongThinServicePages: 0,
      limitedServicePages: 0,
      warning: "contextual",
    },
    searchIndexEvidence: { attempted: false, succeeded: false, pages: [], warning: "", error: null },
  } as any;
}

test("canonical /services hub wins even when store service pages are discovered first", () => {
  const packet = grimeStylePacket();
  assert.equal(
    chooseCanonicalServiceHub(packet),
    "https://www.grimeconstructionllc.com/services",
  );
});

test("canonical thin service hub cannot be crowded out by three store-style service pages", () => {
  const packet = grimeStylePacket();
  const serviceHub = {
    url: "https://www.grimeconstructionllc.com/services",
    type: "service" as const,
    fetchStatus: 200,
    fetchError: null,
    title: "Services — Grime Construction",
    h1: ["Services"],
    h2: [],
    wordCount: 84,
    hasForm: false,
    pageText: "Services At Grime Construction, our services include remodels, concrete, interior and exterior painting, new roof installations, and commercial projects of all sizes.",
    contentDepth: depth("strong"),
  };

  const merged = mergeCanonicalServiceHubSummary(packet, serviceHub);
  const sampledServiceUrls = merged.representativePages
    .filter((page: any) => page.type === "service")
    .map((page: any) => page.url);

  assert.equal(sampledServiceUrls[0], serviceHub.url);
  assert.equal(sampledServiceUrls.length, 3);
  assert.equal(sampledServiceUrls.includes("https://www.grimeconstructionllc.com/store/p/roof-repair"), false);
  assert.equal(merged.contentDepthSummary.strongThinServicePages, 1);
  assert.equal(merged.contentDepthSummary.thinServicePages, 1);
});

test("individual service-detail paths are not mistaken for a canonical service hub", () => {
  const packet = grimeStylePacket();
  packet.architecture.servicePages = ["https://www.grimeconstructionllc.com/services/roofing"];
  packet.discoveredPages = [{ text: "Roofing", url: "https://www.grimeconstructionllc.com/services/roofing", type: "service" }];
  packet.navigation = [];
  assert.equal(chooseCanonicalServiceHub(packet), null);
});
