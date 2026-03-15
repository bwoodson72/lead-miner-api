export type Thresholds = {
  performanceScore: number;
  lcp: number;
  cls: number;
  tbt: number;
};

export const DEFAULT_THRESHOLDS: Thresholds = {
  performanceScore: 60,
  lcp: 4000,
  cls: 0.25,
  tbt: 300,
};
