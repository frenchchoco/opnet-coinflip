import { getCurrentNetwork } from './opnetProvider';

export interface FeeEstimates {
  economy: number;
  slow: number;
  normal: number;
  fast: number;
  minimum: number;
  timestamp: number;
}

export type FeeLevel = 'economy' | 'slow' | 'normal' | 'fast' | 'custom';

export const OPNET_MIN_FEE_RATE = 0.2;

const FALLBACK_FEES: Record<string, Omit<FeeEstimates, 'timestamp'>> = {
  regtest: { economy: 1, slow: 2, normal: 5, fast: 10, minimum: OPNET_MIN_FEE_RATE },
  mainnet: { economy: 10, slow: 20, normal: 30, fast: 50, minimum: OPNET_MIN_FEE_RATE },
};

const getDefaultFees = (): Omit<FeeEstimates, 'timestamp'> =>
  FALLBACK_FEES[getCurrentNetwork()] || FALLBACK_FEES.mainnet;

const CACHE_DURATION = 60 * 1000;
const MAX_CUSTOM_FEE_RATE = 500;
const BASE_TX_VBYTES = 180;
let cachedEstimates: FeeEstimates | null = null;

const getMempoolApiUrl = (): string => getCurrentNetwork() === 'regtest'
  ? 'https://mempool.opnet.org/api/v1/fees/recommended'
  : 'https://mempool.space/api/v1/fees/recommended';

export const getFeeEstimates = async (): Promise<FeeEstimates> => {
  if (cachedEstimates && Date.now() - cachedEstimates.timestamp < CACHE_DURATION) return cachedEstimates;
  try {
    const response = await fetch(getMempoolApiUrl());
    if (!response.ok) throw new Error(`API error: ${response.status}`);
    const data = await response.json();
    const defaults = getDefaultFees();
    cachedEstimates = {
      fast: data.fastestFee || defaults.fast, normal: data.halfHourFee || defaults.normal,
      slow: data.hourFee || defaults.slow, economy: data.economyFee || defaults.economy,
      minimum: data.minimumFee || defaults.minimum, timestamp: Date.now(),
    };
    return cachedEstimates;
  } catch {
    return { ...getDefaultFees(), timestamp: Date.now() };
  }
};

export const getFeeRate = async (level: FeeLevel, customRate?: number): Promise<number> => {
  if (level === 'custom' && customRate !== undefined)
    return Math.max(Math.min(customRate, MAX_CUSTOM_FEE_RATE), OPNET_MIN_FEE_RATE);
  const estimates = await getFeeEstimates();
  const rate = estimates[level as keyof Omit<FeeEstimates, 'timestamp'>] || getDefaultFees().normal;
  return Math.max(rate, OPNET_MIN_FEE_RATE);
};

export const getDefaultFeeRate = (): number => getDefaultFees().normal;

export const getFeeLevelLabel = (level: FeeLevel): string => {
  const labels: Record<FeeLevel, string> = {
    economy: 'Economy (~2+ hours)', slow: 'Slow (~1 hour)',
    normal: 'Normal (~30 min)', fast: 'Fast (~10 min)', custom: 'Custom',
  };
  return labels[level] || 'Normal';
};

export const getSmartFeeRecommendation = async (
  calldataBytes: number, urgency: 'low' | 'medium' | 'high' = 'medium'
): Promise<{ level: FeeLevel; rate: number; estimatedCost: number; savings: string }> => {
  const estimates = await getFeeEstimates();
  const totalVBytes = BASE_TX_VBYTES + Math.ceil(calldataBytes * 0.25);
  const levelMap = { low: 'economy', medium: 'slow', high: 'normal' } as const;
  const level = levelMap[urgency] as FeeLevel;
  const rate = estimates[levelMap[urgency]];
  const estimatedCost = totalVBytes * rate;
  const fastCost = totalVBytes * estimates.fast;
  const savingsPercent = Math.round(((fastCost - estimatedCost) / fastCost) * 100);
  return { level, rate, estimatedCost, savings: savingsPercent > 0 ? `${savingsPercent}% cheaper than Fast` : 'No savings' };
};

export const estimateTxCost = (feeRate: number, vBytes: number = 300): number => Math.ceil(feeRate * vBytes);

export const formatSatsToBtc = (sats: number): string => {
  const btc = sats / 100_000_000;
  return btc < 0.0001 ? `${sats} sats` : `${btc.toFixed(8)} BTC`;
};

export interface FeeComparison { level: FeeLevel; rate: number; cost: number; time: string }

export const compareFees = async (vBytes: number): Promise<FeeComparison[]> => {
  const e = await getFeeEstimates();
  return [
    { level: 'economy', rate: e.economy, cost: vBytes * e.economy, time: '~2+ hours' },
    { level: 'slow', rate: e.slow, cost: vBytes * e.slow, time: '~1 hour' },
    { level: 'normal', rate: e.normal, cost: vBytes * e.normal, time: '~30 min' },
    { level: 'fast', rate: e.fast, cost: vBytes * e.fast, time: '~10 min' },
  ];
};
