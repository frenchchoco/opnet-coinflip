export const NETWORKS = {
  regtest: { name: 'Regtest', rpcUrl: 'https://regtest.opnet.org', explorerUrl: 'https://mempool.opnet.org', opscanApiUrl: 'https://api.opscan.org/v1/regtest', minutesPerBlock: 10 },
  mainnet: { name: 'Mainnet', rpcUrl: 'https://mainnet.opnet.org', explorerUrl: 'https://mempool.opnet.org', opscanApiUrl: 'https://api.opscan.org/v1/mainnet', minutesPerBlock: 10 },
} as const;

export type NetworkType = keyof typeof NETWORKS;
export const DEFAULT_NETWORK: NetworkType = 'regtest';
