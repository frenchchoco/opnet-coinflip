import { OP_20_ABI } from 'opnet';
import { hexToBytes } from '../utils/bytes';
import { Address } from '@btc-vision/transaction';
import { taprootToTweakedHex } from './opnetProvider';
import type { TokenInfo } from '../types';
import type { DynamicContract } from '../types/sdk';
import { contractService } from './contractService';

export const normalizeContractAddress = (address: string): string => {
  if (address.startsWith('opr1') || address.startsWith('op1')) return address;
  if (address.startsWith('bc1p') || address.startsWith('bcrt1p')) return taprootToTweakedHex(address);
  if (address.startsWith('0x')) return address;
  if (/^[0-9a-fA-F]+$/.test(address)) return '0x' + address;
  return address;
};

/**
 * Get a cached token contract instance.
 * Uses ContractService singleton for instance caching.
 * @param tokenAddress - The token contract address
 * @param sender - Optional sender address for transactions
 * @returns Cached DynamicContract instance for OP_20 token
 */
export const getTokenContract = (tokenAddress: string, sender?: Address): DynamicContract =>
  contractService.getContract(normalizeContractAddress(tokenAddress), OP_20_ABI, undefined, sender);

export const getTokenInfo = async (tokenAddress: string): Promise<TokenInfo> => {
  const contract = getTokenContract(tokenAddress);
  const [nameResult, symbolResult, decimalsResult] = await Promise.all([
    contract.name(), contract.symbol(), contract.decimals(),
  ]);
  return {
    address: tokenAddress,
    name: nameResult.properties?.name || 'Unknown',
    symbol: symbolResult.properties?.symbol || 'UNKNOWN',
    decimals: decimalsResult.properties?.decimals || 8,
  };
};

export const getTokenBalance = async (tokenAddress: string, ownerAddress: Address): Promise<bigint> => {
  try {
    const result = await getTokenContract(tokenAddress).balanceOf(ownerAddress);
    return result.properties?.balance || 0n;
  } catch { return 0n; }
};

export const contractAddressToAddress = (addressStr: string): Address => {
  if (addressStr.startsWith('opr1') || addressStr.startsWith('op1')) return Address.fromString(addressStr);
  let hexStr = addressStr;
  if (addressStr.startsWith('bc1p') || addressStr.startsWith('bcrt1p')) hexStr = taprootToTweakedHex(addressStr);
  if (hexStr.startsWith('0x')) hexStr = hexStr.slice(2);
  return Address.wrap(hexToBytes(hexStr));
};

export const getAllowance = async (tokenAddress: string, ownerAddress: Address, spenderAddress: string): Promise<bigint> => {
  const result = await getTokenContract(tokenAddress).allowance(ownerAddress, contractAddressToAddress(spenderAddress));
  return result.properties?.remaining || 0n;
};

export const formatTokenAmount = (amount: bigint, decimals: number, maxDisplayDecimals: number = 6): string => {
  const dec = Number(decimals) || 0;
  if (dec === 0) return amount.toLocaleString();
  const divisor = BigInt(10 ** dec);
  const whole = amount / divisor;
  const fraction = amount % divisor;
  if (fraction === 0n) return whole.toLocaleString();
  let fractionStr = fraction.toString().padStart(dec, '0');
  if (fractionStr.length > maxDisplayDecimals) fractionStr = fractionStr.slice(0, maxDisplayDecimals);
  fractionStr = fractionStr.replace(/0+$/, '');
  if (fractionStr === '') return whole.toLocaleString();
  return `${whole.toLocaleString()}.${fractionStr}`;
};

export const parseTokenAmount = (amount: string, decimals: number): bigint => {
  const trimmed = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error(`Invalid amount format: "${amount}"`);
  const [whole, fraction = ''] = trimmed.split('.');
  return BigInt(whole + fraction.padEnd(decimals, '0').slice(0, decimals));
};
