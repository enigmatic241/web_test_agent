/**
 * CDP network emulation profiles — use only these four values project-wide.
 */
export const NETWORK_PROFILES = {
  '4G': {
    downloadThroughput: (20 * 1024 * 1024) / 8,
    uploadThroughput: (10 * 1024 * 1024) / 8,
    latency: 20,
  },
  SLOW_4G: {
    downloadThroughput: (8 * 1024 * 1024) / 8,
    uploadThroughput: (2 * 1024 * 1024) / 8,
    latency: 60,
  },
  SLOW_3G: {
    downloadThroughput: (1.6 * 1024 * 1024) / 8,
    uploadThroughput: (768 * 1024) / 8,
    latency: 300,
  },
  EDGE: {
    downloadThroughput: (240 * 1024) / 8,
    uploadThroughput: (200 * 1024) / 8,
    latency: 840,
  },
} as const;

export type NetworkProfileName = keyof typeof NETWORK_PROFILES;
