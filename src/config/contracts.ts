export interface VestingContractConfig {
  version: string; p2op: string; taproot: string; active: boolean; deployedAt?: number;
}

export const VESTING_CONTRACTS: VestingContractConfig[] = [
  { version: 'v7', p2op: 'opr1sqzmmqr9xklfuuz7pt2gh3f97m0nkugf655pp772y', taproot: 'bcrt1pypt9xdq3u68l5raf7n8k7lgxh2n9hgnjt6zz8g8nkml7yhv08tkss6tsaz', active: true },
];

export const getActiveContract = (): VestingContractConfig | null => VESTING_CONTRACTS.find(c => c.active) || null;
export const getAllContracts = (): VestingContractConfig[] => VESTING_CONTRACTS;

export const VESTING_CONTRACT = { p2op: getActiveContract()?.p2op || '', taproot: getActiveContract()?.taproot || '' } as const;

export const KNOWN_TOKENS = [
  { address: 'opr1sqp5pkzs9w8ktx020jymxvs05ekc7jahl45r5t9pz', name: 'MOTO Token', symbol: 'MOTO', decimals: 18 },
  { address: 'opr1sqq2quumshz8tvr78n3f69fqxsxkqjycc8yz9vzyg', name: 'PILL Token', symbol: 'PILL', decimals: 18 },
] as const;

export const BLOCK_PRESETS = {
  '1 Hour': 6, '1 Day': 144, '1 Week': 1008, '1 Month': 4320,
  '3 Months': 12960, '6 Months': 25920, '1 Year': 52560,
} as const;
