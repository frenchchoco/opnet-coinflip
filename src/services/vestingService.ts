import { OP_NET_ABI, type BitcoinInterfaceAbi } from 'opnet';
import { Address, ABIDataTypes, BinaryWriter, ABICoder } from '@btc-vision/transaction';
import type { DynamicContract, WalletSigner, WalletAddress, TransactionParams } from '../types/sdk';
import { getProvider, getNetwork, getBlockHeight, taprootToTweakedHex, hexToTaprootAddress } from './opnetProvider';
import {
  VESTING_CONTRACT,
  getAllContracts,
  getActiveContract,
  type VestingContractConfig
} from '../config/contracts';
import { getTokenContract } from './tokenService';
import { getDefaultFeeRate } from './feeService';
import { contractService } from './contractService';
import { hexToBytes, concatBytes } from '../utils/bytes';
import type { VestingSchedule, TransactionResult } from '../types';

export const DEFAULT_MAX_SATS_TO_SPEND = 10000n;
const MIN_SAFETY_FLOOR = 5000n;

/** Dynamic maximumAllowedSatToSpend based on estimated gas */
export const calculateMaxSatsToSpend = (estimatedGasSats?: bigint): bigint => {
  if (estimatedGasSats === undefined) return DEFAULT_MAX_SATS_TO_SPEND;
  const doubled = estimatedGasSats * 2n;
  return doubled > MIN_SAFETY_FLOOR ? doubled : MIN_SAFETY_FLOOR;
};

interface BitcoinFees {
  readonly conservative: number;
  readonly recommended: { readonly low: number; readonly medium: number; readonly high: number };
}

interface CachedGasParams { gasPerSat: bigint; bitcoin: BitcoinFees; timestamp: number }

let gasParamsCache: CachedGasParams | null = null;
const GAS_PARAMS_CACHE_TTL = 60000;

const getCachedGasParams = async (): Promise<{ gasPerSat: bigint; bitcoin: BitcoinFees }> => {
  const now = Date.now();
  if (gasParamsCache && (now - gasParamsCache.timestamp) < GAS_PARAMS_CACHE_TTL) {
    return { gasPerSat: gasParamsCache.gasPerSat, bitcoin: gasParamsCache.bitcoin };
  }
  const provider = getProvider();
  const params = await provider.gasParameters();
  gasParamsCache = { gasPerSat: params.gasPerSat, bitcoin: params.bitcoin, timestamp: now };
  return { gasPerSat: params.gasPerSat, bitcoin: params.bitcoin };
};

const estimateGasInSat = (gas: bigint, gasPerSat: bigint): bigint => {
  // Multiply first to preserve precision, then divide
  const withBuffer = (gas * gasPerSat * 125n) / (1000000000000n * 100n);
  return withBuffer > 297n ? withBuffer : 297n;
};

interface OPNetWindow { opnet?: { web3?: unknown } }

const isOPWalletAvailable = (): boolean => !!(window as unknown as OPNetWindow).opnet?.web3;

const VESTING_ABI: BitcoinInterfaceAbi = [
  ...OP_NET_ABI,
  {
    name: 'createVesting', type: 'function',
    inputs: [
      { name: 'token', type: ABIDataTypes.ADDRESS },
      { name: 'beneficiary', type: ABIDataTypes.ADDRESS },
      { name: 'amount', type: ABIDataTypes.UINT256 },
      { name: 'cliffBlocks', type: ABIDataTypes.UINT256 },
      { name: 'vestingBlocks', type: ABIDataTypes.UINT256 },
    ],
    outputs: [{ name: 'vestingId', type: ABIDataTypes.UINT256 }],
  },
  {
    name: 'createVestingBatch', type: 'function',
    inputs: [
      { name: 'token', type: ABIDataTypes.ADDRESS },
      { name: 'cliffBlocks', type: ABIDataTypes.UINT256 },
      { name: 'vestingBlocks', type: ABIDataTypes.UINT256 },
      { name: 'count', type: ABIDataTypes.UINT256 },
      { name: 'beneficiaryData', type: ABIDataTypes.BYTES },
    ],
    outputs: [{ name: 'firstVestingId', type: ABIDataTypes.UINT256 }],
  },
  {
    name: 'createVestingBatchCompact', type: 'function',
    inputs: [
      { name: 'token', type: ABIDataTypes.ADDRESS },
      { name: 'cliffBlocks', type: ABIDataTypes.UINT64 },
      { name: 'vestingBlocks', type: ABIDataTypes.UINT64 },
      { name: 'count', type: ABIDataTypes.UINT16 },
      { name: 'beneficiaryData', type: ABIDataTypes.BYTES },
    ],
    outputs: [{ name: 'firstVestingId', type: ABIDataTypes.UINT256 }],
  },
  {
    name: 'createVestingBatchUniform', type: 'function',
    inputs: [
      { name: 'token', type: ABIDataTypes.ADDRESS },
      { name: 'amount', type: ABIDataTypes.UINT64 },
      { name: 'cliffBlocks', type: ABIDataTypes.UINT64 },
      { name: 'vestingBlocks', type: ABIDataTypes.UINT64 },
      { name: 'count', type: ABIDataTypes.UINT16 },
      { name: 'beneficiaryData', type: ABIDataTypes.BYTES },
    ],
    outputs: [{ name: 'firstVestingId', type: ABIDataTypes.UINT256 }],
  },
  {
    name: 'claim', type: 'function',
    inputs: [{ name: 'vestingId', type: ABIDataTypes.UINT256 }],
    outputs: [{ name: 'amountReleased', type: ABIDataTypes.UINT256 }],
  },
  {
    name: 'getVestingInfo', type: 'function',
    inputs: [{ name: 'vestingId', type: ABIDataTypes.UINT256 }],
    outputs: [
      { name: 'token', type: ABIDataTypes.UINT256 },
      { name: 'beneficiary', type: ABIDataTypes.UINT256 },
      { name: 'creator', type: ABIDataTypes.UINT256 },
      { name: 'total', type: ABIDataTypes.UINT256 },
      { name: 'released', type: ABIDataTypes.UINT256 },
      { name: 'start', type: ABIDataTypes.UINT256 },
      { name: 'cliff', type: ABIDataTypes.UINT256 },
      { name: 'end', type: ABIDataTypes.UINT256 },
    ],
  },
  {
    name: 'getClaimableAmount', type: 'function',
    inputs: [{ name: 'vestingId', type: ABIDataTypes.UINT256 }],
    outputs: [{ name: 'amount', type: ABIDataTypes.UINT256 }],
  },
  {
    name: 'getNextVestingId', type: 'function',
    inputs: [],
    outputs: [{ name: 'nextId', type: ABIDataTypes.UINT256 }],
  },
] as BitcoinInterfaceAbi;

const getContractTweakedHex = (taprootAddress?: string): string =>
  taprootToTweakedHex(taprootAddress || VESTING_CONTRACT.taproot);

/**
 * Get a cached vesting contract instance.
 * Uses ContractService singleton for instance caching.
 * @param sender - Optional sender address for transaction signing
 * @param contractTaproot - Optional contract taproot address (defaults to active contract)
 * @returns Cached DynamicContract instance
 */
export const getVestingContractInstance = (sender?: Address, contractTaproot?: string): DynamicContract =>
  contractService.getContract(getContractTweakedHex(contractTaproot), VESTING_ABI, undefined, sender);

export const getActiveVestingContract = (sender?: Address): DynamicContract | null => {
  const activeContract = getActiveContract();
  if (!activeContract) return null;
  return getVestingContractInstance(sender, activeContract.taproot);
};

export const getNextVestingIdForContract = async (contractTaproot: string): Promise<bigint> => {
  try {
    const contract = getVestingContractInstance(undefined, contractTaproot);
    const result = await contract.getNextVestingId();
    return result.properties?.nextId || 1n;
  } catch { return 1n; }
};

export const getNextVestingId = async (): Promise<bigint> => {
  const activeContract = getActiveContract();
  if (!activeContract) return 1n;
  return getNextVestingIdForContract(activeContract.taproot);
};

/**
 * Convert u256 value from contract to human-readable Taproot address.
 * Attempts to convert to bc1p/bcrt1p format, falls back to truncated hex.
 * @param value - The u256 value from contract storage
 * @returns Bech32 Taproot address (bc1p... or bcrt1p...)
 */
const u256ToHexAddress = (value: bigint): string => {
  const hexString = value.toString(16).padStart(64, '0').toLowerCase();
  // Convert to Taproot address for better UX
  return hexToTaprootAddress(hexString);
};

export const normalizeAddress = (address: string): string => {
  // Convert bech32 Taproot addresses to their tweaked hex representation
  if (address.startsWith('bc1p') || address.startsWith('bcrt1p') || address.startsWith('tb1p')) {
    try {
      return taprootToTweakedHex(address).replace(/^0x/, '').toLowerCase().padStart(64, '0');
    } catch { /* fall through to default */ }
  }
  return address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
};

export interface VestingScheduleWithContract extends VestingSchedule {
  contractVersion: string;
  contractTaproot: string;
  contractP2op: string;
}

export const getVestingInfoFromContract = async (
  vestingId: bigint, contract: VestingContractConfig
): Promise<VestingScheduleWithContract | null> => {
  try {
    const contractInstance = getVestingContractInstance(undefined, contract.taproot);
    const result = await contractInstance.getVestingInfo(vestingId);
    const { token, beneficiary, creator, total, released, start, cliff, end } = result.properties || {};
    if (!total || total === 0n) return null;
    return {
      vestingId,
      tokenAddress: u256ToHexAddress(token),
      beneficiary: u256ToHexAddress(beneficiary),
      creator: u256ToHexAddress(creator),
      totalAmount: total,
      releasedAmount: released || 0n,
      startBlock: start || 0n,
      cliffEndBlock: cliff || 0n,
      vestingEndBlock: end || 0n,
      contractVersion: contract.version,
      contractTaproot: contract.taproot,
      contractP2op: contract.p2op,
    };
  } catch { return null; }
};

/** Get vesting info by vestingId (searches ALL contracts) */
export const getVestingInfo = async (vestingId: bigint): Promise<VestingScheduleWithContract | null> => {
  for (const contract of getAllContracts()) {
    const result = await getVestingInfoFromContract(vestingId, contract);
    if (result) return result;
  }
  return null;
};

export const getTweakedHexFromTaproot = (taprootAddress: string): string | null => {
  try {
    return taprootToTweakedHex(taprootAddress).replace(/^0x/, '').toLowerCase().padStart(64, '0');
  } catch { return null; }
};

type ScanRole = 'beneficiary' | 'creator';
const SCAN_BATCH_SIZE = 50;

const scanVestingsFromContract = async (
  contract: VestingContractConfig, userAddressHex: string,
  userTaprootAddress: string | undefined, role: ScanRole
): Promise<VestingScheduleWithContract[]> => {
  const vestings: VestingScheduleWithContract[] = [];
  const normalizedUserAddress = normalizeAddress(userAddressHex);
  const tweakedHex = userTaprootAddress ? getTweakedHexFromTaproot(userTaprootAddress) : null;
  try {
    const nextId = await getNextVestingIdForContract(contract.taproot);
    const totalVestings = Number(nextId) - 1;
    if (totalVestings <= 0) return vestings;
    for (let batchStart = 1; batchStart <= totalVestings; batchStart += SCAN_BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + SCAN_BATCH_SIZE - 1, totalVestings);
      const batchIds: bigint[] = [];
      for (let i = batchStart; i <= batchEnd; i++) batchIds.push(BigInt(i));
      const batchResults = await Promise.all(
        batchIds.map(id => getVestingInfoFromContract(id, contract).catch(() => null))
      );
      for (const schedule of batchResults) {
        if (!schedule) continue;
        const addressToCompare = role === 'beneficiary' ? schedule.beneficiary : schedule.creator;
        const normalizedAddr = normalizeAddress(addressToCompare);
        if (normalizedAddr === normalizedUserAddress || (tweakedHex && normalizedAddr === tweakedHex)) {
          vestings.push(schedule);
        }
      }
    }
  } catch { /* ignore */ }
  return vestings;
};

const scanVestingsByRole = async (
  userAddressHex: string, userTaprootAddress: string | undefined, role: ScanRole
): Promise<VestingScheduleWithContract[]> => {
  const results = await Promise.all(
    getAllContracts().map(contract => scanVestingsFromContract(contract, userAddressHex, userTaprootAddress, role))
  );
  return results.flat();
};

export const scanVestingsAsBeneficiary = (
  userAddressHex: string, userTaprootAddress?: string
): Promise<VestingScheduleWithContract[]> => scanVestingsByRole(userAddressHex, userTaprootAddress, 'beneficiary');

export const scanVestingsAsCreator = (
  userAddressHex: string, userTaprootAddress?: string
): Promise<VestingScheduleWithContract[]> => scanVestingsByRole(userAddressHex, userTaprootAddress, 'creator');

export const getClaimableAmountFromContract = async (vestingId: bigint, contractTaproot: string): Promise<bigint> => {
  try {
    const contract = getVestingContractInstance(undefined, contractTaproot);
    const result = await contract.getClaimableAmount(vestingId);
    return result.properties?.amount || 0n;
  } catch { return 0n; }
};

export const getClaimableAmount = async (vestingId: bigint): Promise<bigint> => {
  const activeContract = getActiveContract();
  if (!activeContract) return 0n;
  return getClaimableAmountFromContract(vestingId, activeContract.taproot);
};

export const buildTransactionParams = (
  signer: WalletSigner | null, userAddress: string, fromAddress?: WalletAddress,
  feeRate: number = getDefaultFeeRate(), estimatedGasSats?: bigint
): TransactionParams => {
  const useOPWallet = isOPWalletAvailable();
  // When OP_WALLET is detected, omit signer/mldsaSigner properties entirely.
  // The OP_WALLET extension handles signing internally and rejects params
  // that contain a 'signer' property (even if null/undefined).
  const params: TransactionParams = {
    refundTo: userAddress,
    from: fromAddress,
    maximumAllowedSatToSpend: calculateMaxSatsToSpend(estimatedGasSats),
    feeRate,
    network: getNetwork(),
  };
  if (useOPWallet) {
    params.linkMLDSAPublicKeyToAddress = false;
    params.revealMLDSAPublicKey = false;
  } else {
    params.signer = signer;
    params.mldsaSigner = null;
  }
  return params;
};

/** Validate that an address is a Taproot address (bc1p/bcrt1p) */
export const isTaprootAddress = (addr: string): boolean =>
  /^(bc1p|bcrt1p)[a-z0-9]{58,59}$/i.test(addr.trim());

const stringToAddress = async (addressStr: string): Promise<Address> => {
  if (addressStr.startsWith('bc1p') || addressStr.startsWith('bcrt1p')) {
    const hex = taprootToTweakedHex(addressStr).replace(/^0x/, '');
    return Address.wrap(hexToBytes(hex));
  }
  if (addressStr.startsWith('opr1') || addressStr.startsWith('op1'))
    return await getProvider().getPublicKeyInfo(addressStr, true);
  if (addressStr.startsWith('0x'))
    return Address.wrap(hexToBytes(addressStr.slice(2)));
  const bytes = hexToBytes(addressStr);
  if (bytes.length > 0) return Address.wrap(bytes);
  throw new Error(`Unsupported address format: ${addressStr}`);
};

/** Validate that beneficiary is a Taproot address (contract uses tweakedPublicKey for claim) */
const validateBeneficiaryAddress = (addr: string): string | null => {
  const trimmed = addr.trim();
  if (!trimmed) return 'Beneficiary address is required';
  if (!isTaprootAddress(trimmed)) return 'Beneficiary must be a Taproot address (bc1p... or bcrt1p...). ML-DSA (opr1/op1) addresses cannot claim vestings.';
  return null;
};

/** Validate token address is non-empty */
const validateTokenAddress = (addr: string): string | null => {
  if (!addr || !addr.trim()) return 'Token address is required';
  return null;
};

/** Max block duration per field (cliff or vesting) - matches contract MAX_BLOCK_DURATION */
const MAX_BLOCK_DURATION = 5256000;

/** Validate block durations match contract limits */
const validateBlockDuration = (cliffBlocks: number, vestingBlocks: number): string | null => {
  if (cliffBlocks < 0) return 'Cliff blocks cannot be negative';
  if (vestingBlocks < 1) return 'Vesting duration must be at least 1 block';
  if (cliffBlocks > MAX_BLOCK_DURATION) return `Cliff blocks exceed maximum (${MAX_BLOCK_DURATION.toLocaleString()})`;
  if (vestingBlocks > MAX_BLOCK_DURATION) return `Vesting blocks exceed maximum (${MAX_BLOCK_DURATION.toLocaleString()})`;
  if (cliffBlocks + vestingBlocks > MAX_BLOCK_DURATION * 2) return 'Total duration (cliff + vesting) exceeds maximum';
  return null;
};

/** Maximum uint256 value for unlimited approvals */
export const UNLIMITED_ALLOWANCE = 2n ** 256n - 1n;

export const approveToken = async (
  tokenAddress: string, amount: bigint, signer: WalletSigner, userAddress: string,
  fromAddress?: WalletAddress, feeRate: number = getDefaultFeeRate(), unlimited: boolean = false
): Promise<TransactionResult> => {
  try {
    const activeContract = getActiveContract();
    if (!activeContract) return { success: false, error: 'No active vesting contract configured' };
    const tokenContract = getTokenContract(tokenAddress, fromAddress);
    const spenderAddress = await stringToAddress(getContractTweakedHex(activeContract.taproot));
    const approveAmount = unlimited ? UNLIMITED_ALLOWANCE : amount;
    const simulation = await tokenContract.increaseAllowance(spenderAddress, approveAmount);
    if (simulation.revert) return { success: false, error: `Approval simulation failed: ${simulation.revert}` };
    const params = buildTransactionParams(signer, userAddress, fromAddress, feeRate);
    const receipt = await simulation.sendTransaction(params);
    return { success: true, txId: receipt.transactionId };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to approve token' };
  }
};

export const createVesting = async (
  tokenAddress: string, beneficiaryAddress: string, amount: bigint,
  cliffBlocks: number, vestingBlocks: number, signer: WalletSigner, userAddress: string,
  fromAddress?: WalletAddress, feeRate: number = getDefaultFeeRate()
): Promise<TransactionResult & { vestingId?: bigint }> => {
  try {
    const activeContract = getActiveContract();
    if (!activeContract) return { success: false, error: 'No active vesting contract configured' };
    const tokenError = validateTokenAddress(tokenAddress);
    if (tokenError) return { success: false, error: tokenError };
    if (amount <= 0n) return { success: false, error: 'Amount must be greater than zero' };
    const beneficiaryError = validateBeneficiaryAddress(beneficiaryAddress);
    if (beneficiaryError) return { success: false, error: beneficiaryError };
    const blockError = validateBlockDuration(cliffBlocks, vestingBlocks);
    if (blockError) return { success: false, error: blockError };
    const tokenAddr = await stringToAddress(tokenAddress);
    const beneficiaryAddr = await stringToAddress(beneficiaryAddress);
    const contract = getVestingContractInstance(fromAddress, activeContract.taproot);
    const simulation = await contract.createVesting(tokenAddr, beneficiaryAddr, amount, BigInt(cliffBlocks), BigInt(vestingBlocks));
    if (simulation.revert) return { success: false, error: `Vesting creation simulation failed: ${simulation.revert}` };
    const params = buildTransactionParams(signer, userAddress, fromAddress, feeRate);
    const receipt = await simulation.sendTransaction(params);
    return { success: true, txId: receipt.transactionId, vestingId: simulation.properties?.vestingId };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to create vesting' };
  }
};

export interface BatchBeneficiary { address: string; amount: bigint }

/** Shared batch simulation, gas setup, and send logic */
const executeBatchCall = async (
  fullCalldata: Uint8Array, contract: DynamicContract, fromAddress: WalletAddress | undefined,
  signer: WalletSigner, userAddress: string, feeRate: number, errorPrefix: string
): Promise<TransactionResult & { firstVestingId?: bigint }> => {
  const provider = getProvider();
  const response = await provider.call(contract.address, fullCalldata, fromAddress, undefined, undefined, undefined);
  if ('error' in response) return { success: false, error: `${errorPrefix}: ${response.error}` };
  if (response.revert) return { success: false, error: `${errorPrefix}: ${response.revert}` };
  response.setTo(contract.p2op, await contract.contractAddress);
  response.setFromAddress(fromAddress);
  response.setCalldata(fullCalldata);
  const gasParams = await getCachedGasParams();
  response.setBitcoinFee(gasParams.bitcoin);
  const estimatedGasSats = estimateGasInSat(response.estimatedGas || 0n, gasParams.gasPerSat);
  response.setGasEstimation(estimatedGasSats, estimateGasInSat(response.refundedGas || 0n, gasParams.gasPerSat));
  const params = buildTransactionParams(signer, userAddress, fromAddress, feeRate, estimatedGasSats);
  const receipt = await response.sendTransaction(params);
  const resultReader = response.result;
  const firstVestingId = resultReader?.bytesLeft() >= 32 ? resultReader.readU256() : undefined;
  return { success: true, txId: receipt.transactionId, firstVestingId };
};

const validateBatchInput = (beneficiariesLength: number): string | null => {
  if (beneficiariesLength === 0) return 'At least one beneficiary required';
  if (beneficiariesLength > 200) return 'Maximum 200 beneficiaries per batch';
  return null;
};

export const createVestingBatch = async (
  tokenAddress: string, beneficiaries: BatchBeneficiary[], cliffBlocks: number,
  vestingBlocks: number, signer: WalletSigner, userAddress: string,
  fromAddress?: WalletAddress, feeRate: number = getDefaultFeeRate()
): Promise<TransactionResult & { firstVestingId?: bigint; vestingIds?: bigint[]; txIds?: string[] }> => {
  try {
    const activeContract = getActiveContract();
    if (!activeContract) return { success: false, error: 'No active vesting contract configured' };
    const tokenError = validateTokenAddress(tokenAddress);
    if (tokenError) return { success: false, error: tokenError };
    const validationError = validateBatchInput(beneficiaries.length);
    if (validationError) return { success: false, error: validationError };
    const blockError = validateBlockDuration(cliffBlocks, vestingBlocks);
    if (blockError) return { success: false, error: blockError };
    for (const b of beneficiaries) {
      const bErr = validateBeneficiaryAddress(b.address);
      if (bErr) return { success: false, error: bErr };
      if (b.amount <= 0n) return { success: false, error: `Amount must be greater than zero for ${b.address.slice(0, 12)}...` };
    }
    const tokenAddr = await stringToAddress(tokenAddress);
    const contract = getVestingContractInstance(fromAddress, activeContract.taproot);
    const abiCoder = new ABICoder();
    const selector = hexToBytes(abiCoder.encodeSelector('createVestingBatch(address,uint256,uint256,uint256,bytes)'));
    if (selector.length !== 4) throw new Error('encodeSelector returned invalid selector');
    const paramsWriter = new BinaryWriter();
    paramsWriter.writeAddress(tokenAddr);
    paramsWriter.writeU256(BigInt(cliffBlocks));
    paramsWriter.writeU256(BigInt(vestingBlocks));
    paramsWriter.writeU256(BigInt(beneficiaries.length));
    for (const b of beneficiaries) {
      paramsWriter.writeAddress(await stringToAddress(b.address));
      paramsWriter.writeU256(b.amount);
    }
    const writerBytes = paramsWriter.getBuffer();
    const fullCalldata = concatBytes(selector, writerBytes);
    return await executeBatchCall(fullCalldata, contract, fromAddress, signer, userAddress, feeRate, 'Batch vesting simulation failed');
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to create batch vesting' };
  }
};

export const claimVestingFromContract = async (
  vestingId: bigint, contractTaproot: string, signer: WalletSigner, userTaprootAddress: string,
  fromAddress?: WalletAddress, feeRate: number = getDefaultFeeRate()
): Promise<TransactionResult & { amountReleased?: bigint }> => {
  try {
    const contract = getVestingContractInstance(fromAddress, contractTaproot);
    const simulation = await contract.claim(vestingId);
    if (simulation.revert) {
      const extra = simulation.revert.includes('Only beneficiary can claim') ? '. Make sure you are the beneficiary of this vesting.' : '';
      return { success: false, error: `Claim simulation failed: ${simulation.revert}${extra}` };
    }
    const params = buildTransactionParams(signer, userTaprootAddress, fromAddress, feeRate);
    const receipt = await simulation.sendTransaction(params);
    return { success: true, txId: receipt.transactionId, amountReleased: simulation.properties?.amountReleased };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to claim vesting' };
  }
};

export const claimVesting = async (
  vestingId: bigint, signer: WalletSigner, userTaprootAddress: string,
  fromAddress?: WalletAddress, feeRate: number = getDefaultFeeRate()
): Promise<TransactionResult & { amountReleased?: bigint }> => {
  const activeContract = getActiveContract();
  if (!activeContract) return { success: false, error: 'No active vesting contract configured' };
  return claimVestingFromContract(vestingId, activeContract.taproot, signer, userTaprootAddress, fromAddress, feeRate);
};

export const calculateVestingProgress = async (schedule: VestingSchedule): Promise<{
  percentVested: number; percentReleased: number; blocksRemaining: number; cliffReached: boolean;
}> => {
  const currentBlock = BigInt(await getBlockHeight());
  const cliffReached = currentBlock >= schedule.cliffEndBlock;
  let percentVested = 0;
  if (currentBlock >= schedule.vestingEndBlock) {
    percentVested = 100;
  } else if (cliffReached) {
    const elapsed = Number(currentBlock - schedule.cliffEndBlock);
    const duration = Number(schedule.vestingEndBlock - schedule.cliffEndBlock);
    if (duration > 0) percentVested = Math.min(100, (elapsed / duration) * 100);
  }
  const percentReleased = schedule.totalAmount > 0n
    ? Number((schedule.releasedAmount * 100n) / schedule.totalAmount) : 0;
  const blocksRemaining = currentBlock >= schedule.vestingEndBlock
    ? 0 : Number(schedule.vestingEndBlock - currentBlock);
  return { percentVested, percentReleased, blocksRemaining, cliffReached };
};

export const calculateClaimableFrontend = async (schedule: VestingSchedule): Promise<bigint> => {
  const currentBlock = BigInt(await getBlockHeight());
  const { totalAmount: total, releasedAmount: released, cliffEndBlock: cliffEnd, vestingEndBlock: end } = schedule;
  if (currentBlock < cliffEnd) return 0n;
  if (currentBlock >= end) return total - released;
  const duration = end - cliffEnd;
  if (duration === 0n) return total - released;
  const claimable = (total * (currentBlock - cliffEnd)) / duration - released;
  return claimable > 0n ? claimable : 0n;
};

/** Create batch vesting with uniform amount (V3) */
export const createVestingBatchUniform = async (
  tokenAddress: string, beneficiaryAddresses: string[], amount: bigint,
  cliffBlocks: number, vestingBlocks: number, signer: WalletSigner, userAddress: string,
  fromAddress?: WalletAddress, feeRate: number = getDefaultFeeRate()
): Promise<TransactionResult & { firstVestingId?: bigint }> => {
  try {
    const activeContract = getActiveContract();
    if (!activeContract) return { success: false, error: 'No active vesting contract configured' };
    const tokenError = validateTokenAddress(tokenAddress);
    if (tokenError) return { success: false, error: tokenError };
    const validationError = validateBatchInput(beneficiaryAddresses.length);
    if (validationError) return { success: false, error: validationError };
    const blockError = validateBlockDuration(cliffBlocks, vestingBlocks);
    if (blockError) return { success: false, error: blockError };
    const MAX_U64 = 18446744073709551615n;
    if (amount <= 0n) return { success: false, error: 'Amount must be greater than zero' };
    if (amount > MAX_U64) return { success: false, error: `Amount ${amount} exceeds u64 max (${MAX_U64}). Use legacy batch for large amounts.` };
    for (const addr of beneficiaryAddresses) {
      const bErr = validateBeneficiaryAddress(addr);
      if (bErr) return { success: false, error: bErr };
    }
    const tokenAddr = await stringToAddress(tokenAddress);
    const contract = getVestingContractInstance(fromAddress, activeContract.taproot);
    const abiCoder = new ABICoder();
    const selector = hexToBytes(abiCoder.encodeSelector('createVestingBatchUniform(address,uint64,uint64,uint64,uint16,bytes)'));
    if (selector.length !== 4) throw new Error('encodeSelector returned invalid selector');
    const paramsWriter = new BinaryWriter();
    paramsWriter.writeAddress(tokenAddr);
    paramsWriter.writeU64(amount);
    paramsWriter.writeU64(BigInt(cliffBlocks));
    paramsWriter.writeU64(BigInt(vestingBlocks));
    paramsWriter.writeU16(beneficiaryAddresses.length);
    for (const addr of beneficiaryAddresses) paramsWriter.writeAddress(await stringToAddress(addr));
    const writerBytes = paramsWriter.getBuffer();
    const fullCalldata = concatBytes(selector, writerBytes);
    return await executeBatchCall(fullCalldata, contract, fromAddress, signer, userAddress, feeRate, 'Uniform batch simulation failed');
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to create uniform batch vesting' };
  }
};

/** Create batch vesting with compact encoding (V3) */
export const createVestingBatchCompact = async (
  tokenAddress: string, beneficiaries: BatchBeneficiary[], cliffBlocks: number,
  vestingBlocks: number, signer: WalletSigner, userAddress: string,
  fromAddress?: WalletAddress, feeRate: number = getDefaultFeeRate()
): Promise<TransactionResult & { firstVestingId?: bigint }> => {
  try {
    const activeContract = getActiveContract();
    if (!activeContract) return { success: false, error: 'No active vesting contract configured' };
    const tokenError = validateTokenAddress(tokenAddress);
    if (tokenError) return { success: false, error: tokenError };
    const validationError = validateBatchInput(beneficiaries.length);
    if (validationError) return { success: false, error: validationError };
    const blockError = validateBlockDuration(cliffBlocks, vestingBlocks);
    if (blockError) return { success: false, error: blockError };
    const MAX_U64 = 18446744073709551615n;
    for (const b of beneficiaries) {
      const bErr = validateBeneficiaryAddress(b.address);
      if (bErr) return { success: false, error: bErr };
      if (b.amount <= 0n) return { success: false, error: `Amount must be greater than zero for ${b.address.slice(0, 12)}...` };
      if (b.amount > MAX_U64) return { success: false, error: `Amount ${b.amount} exceeds u64 max for compact batch. Use legacy batch for large amounts.` };
    }
    const tokenAddr = await stringToAddress(tokenAddress);
    const contract = getVestingContractInstance(fromAddress, activeContract.taproot);
    const abiCoder = new ABICoder();
    const selector = hexToBytes(abiCoder.encodeSelector('createVestingBatchCompact(address,uint64,uint64,uint16,bytes)'));
    if (selector.length !== 4) throw new Error('encodeSelector returned invalid selector');
    const paramsWriter = new BinaryWriter();
    paramsWriter.writeAddress(tokenAddr);
    paramsWriter.writeU64(BigInt(cliffBlocks));
    paramsWriter.writeU64(BigInt(vestingBlocks));
    paramsWriter.writeU16(beneficiaries.length);
    for (const b of beneficiaries) {
      paramsWriter.writeAddress(await stringToAddress(b.address));
      paramsWriter.writeU64(b.amount);
    }
    const writerBytes = paramsWriter.getBuffer();
    const fullCalldata = concatBytes(selector, writerBytes);
    return await executeBatchCall(fullCalldata, contract, fromAddress, signer, userAddress, feeRate, 'Compact batch simulation failed');
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to create compact batch vesting' };
  }
};

export interface GasEstimate { gasUnits: bigint; gasSats: bigint; gasPerSat: bigint }

export const estimateVestingBatchGas = async (
  tokenAddress: string, beneficiaries: BatchBeneficiary[], cliffBlocks: number,
  vestingBlocks: number, fromAddress?: WalletAddress,
  method: 'legacy' | 'compact' | 'uniform' = 'compact'
): Promise<GasEstimate | null> => {
  try {
    const activeContract = getActiveContract();
    if (!activeContract || beneficiaries.length === 0) return null;
    const tokenAddr = await stringToAddress(tokenAddress);
    const contract = getVestingContractInstance(fromAddress, activeContract.taproot);
    const abiCoder = new ABICoder();
    const provider = getProvider();
    const gasParams = await getCachedGasParams();
    const paramsWriter = new BinaryWriter();
    let selectorStr: string;
    if (method === 'uniform') {
      selectorStr = 'createVestingBatchUniform(address,uint64,uint64,uint64,uint16,bytes)';
      paramsWriter.writeAddress(tokenAddr);
      paramsWriter.writeU64(beneficiaries[0].amount);
      paramsWriter.writeU64(BigInt(cliffBlocks));
      paramsWriter.writeU64(BigInt(vestingBlocks));
      paramsWriter.writeU16(beneficiaries.length);
      for (const b of beneficiaries) paramsWriter.writeAddress(await stringToAddress(b.address));
    } else if (method === 'compact') {
      selectorStr = 'createVestingBatchCompact(address,uint64,uint64,uint16,bytes)';
      paramsWriter.writeAddress(tokenAddr);
      paramsWriter.writeU64(BigInt(cliffBlocks));
      paramsWriter.writeU64(BigInt(vestingBlocks));
      paramsWriter.writeU16(beneficiaries.length);
      for (const b of beneficiaries) {
        paramsWriter.writeAddress(await stringToAddress(b.address));
        paramsWriter.writeU64(b.amount);
      }
    } else {
      selectorStr = 'createVestingBatch(address,uint256,uint256,uint256,bytes)';
      paramsWriter.writeAddress(tokenAddr);
      paramsWriter.writeU256(BigInt(cliffBlocks));
      paramsWriter.writeU256(BigInt(vestingBlocks));
      paramsWriter.writeU256(BigInt(beneficiaries.length));
      for (const b of beneficiaries) {
        paramsWriter.writeAddress(await stringToAddress(b.address));
        paramsWriter.writeU256(b.amount);
      }
    }
    const selector = hexToBytes(abiCoder.encodeSelector(selectorStr));
    if (selector.length !== 4) throw new Error('encodeSelector returned invalid selector');
    const writerBytes = paramsWriter.getBuffer();
    const fullCalldata = concatBytes(selector, writerBytes);
    const response = await provider.call(contract.address, fullCalldata, fromAddress, undefined, undefined, undefined);
    if ('error' in response || response.revert) return null;
    const gasUnits = response.estimatedGas || 0n;
    return { gasUnits, gasSats: estimateGasInSat(gasUnits, gasParams.gasPerSat), gasPerSat: gasParams.gasPerSat };
  } catch { return null; }
};
