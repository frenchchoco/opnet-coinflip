import { OP_NET_ABI, type BitcoinInterfaceAbi } from 'opnet';
import { ABIDataTypes } from '@btc-vision/transaction';
import type { DynamicContract, WalletSigner, WalletAddress, TransactionParams } from '../types/sdk';
import { contractService } from './contractService';
import { taprootToTweakedHex, getBlockHeight, getNetwork } from './opnetProvider';
import { getDefaultFeeRate } from './feeService';

// CoinFlip contract address on regtest
const COINFLIP_CONTRACT_TAPROOT = 'bcrt1phydkss0cs0yfaxxh6le5fpw0mdxa3dmrc0qnsx42sgt2sfz8ltxq7kmxh6';

const COINFLIP_ABI: BitcoinInterfaceAbi = [
  ...OP_NET_ABI,
  {
    name: 'flip', type: 'function',
    inputs: [{ name: 'choice', type: ABIDataTypes.UINT256 }],
    outputs: [
      { name: 'result', type: ABIDataTypes.UINT256 },
      { name: 'won', type: ABIDataTypes.BOOL },
    ],
  },
  {
    name: 'getStats', type: 'function',
    inputs: [{ name: 'player', type: ABIDataTypes.ADDRESS }],
    outputs: [
      { name: 'flips', type: ABIDataTypes.UINT256 },
      { name: 'wins', type: ABIDataTypes.UINT256 },
    ],
  },
  {
    name: 'getTotalFlips', type: 'function',
    inputs: [],
    outputs: [
      { name: 'totalFlips', type: ABIDataTypes.UINT256 },
      { name: 'totalHeads', type: ABIDataTypes.UINT256 },
      { name: 'totalTails', type: ABIDataTypes.UINT256 },
    ],
  },
  {
    name: 'getLastResult', type: 'function',
    inputs: [],
    outputs: [
      { name: 'blockNumber', type: ABIDataTypes.UINT256 },
      { name: 'parity', type: ABIDataTypes.UINT256 },
    ],
  },
] as BitcoinInterfaceAbi;

const getContractTweakedHex = (): string => taprootToTweakedHex(COINFLIP_CONTRACT_TAPROOT);

export const getCoinFlipContract = (sender?: WalletAddress): DynamicContract =>
  contractService.getContract(getContractTweakedHex(), COINFLIP_ABI, undefined, sender);

interface OPNetWindow { opnet?: { web3?: unknown } }
const isOPWalletAvailable = (): boolean => !!(window as unknown as OPNetWindow).opnet?.web3;

export const buildTransactionParams = (
  signer: WalletSigner | null, userAddress: string, fromAddress?: WalletAddress,
  feeRate: number = getDefaultFeeRate()
): TransactionParams => {
  const useOPWallet = isOPWalletAvailable();
  const params: TransactionParams = {
    refundTo: userAddress,
    from: fromAddress,
    maximumAllowedSatToSpend: 10000n,
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

export interface FlipResult {
  success: boolean;
  won?: boolean;
  coinResult?: 'heads' | 'tails';
  blockHeight?: number;
  txId?: string;
  error?: string;
}

export const flipCoin = async (
  choice: 'heads' | 'tails',
  signer: WalletSigner,
  userAddress: string,
  fromAddress?: WalletAddress,
  feeRate?: number
): Promise<FlipResult> => {
  try {
    const choiceValue = choice === 'heads' ? 0n : 1n;
    const contract = getCoinFlipContract(fromAddress);

    const simulation = await contract.flip(choiceValue);
    if (simulation.revert) {
      return { success: false, error: `Simulation failed: ${simulation.revert}` };
    }

    const params = buildTransactionParams(signer, userAddress, fromAddress, feeRate);
    const receipt = await simulation.sendTransaction(params);

    // Read result from simulation response
    const resultValue = simulation.properties?.result;
    const won = simulation.properties?.won;
    const coinResult: 'heads' | 'tails' = resultValue === 0n ? 'heads' : 'tails';
    const blockHeight = await getBlockHeight();

    return {
      success: true,
      won: !!won,
      coinResult,
      blockHeight,
      txId: receipt.transactionId,
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Transaction failed' };
  }
};

export interface PlayerStats {
  totalFlips: number;
  totalWins: number;
}

export const getPlayerStats = async (playerAddress: WalletAddress): Promise<PlayerStats> => {
  try {
    const contract = getCoinFlipContract();
    const result = await contract.getStats(playerAddress);
    return {
      totalFlips: Number(result.properties?.flips || 0n),
      totalWins: Number(result.properties?.wins || 0n),
    };
  } catch {
    return { totalFlips: 0, totalWins: 0 };
  }
};

export interface GlobalStats {
  totalFlips: number;
  totalHeads: number;
  totalTails: number;
}

export const getGlobalStats = async (): Promise<GlobalStats> => {
  try {
    const contract = getCoinFlipContract();
    const result = await contract.getTotalFlips();
    return {
      totalFlips: Number(result.properties?.totalFlips || 0n),
      totalHeads: Number(result.properties?.totalHeads || 0n),
      totalTails: Number(result.properties?.totalTails || 0n),
    };
  } catch {
    return { totalFlips: 0, totalHeads: 0, totalTails: 0 };
  }
};
