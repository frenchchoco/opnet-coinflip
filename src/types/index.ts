export type WalletType = 'opwallet' | 'unisat' | 'okx' | null;

export interface WalletInfo { address: string; publicKey: string; network: string; balance: number; walletType: WalletType; }
export interface Beneficiary { address: string; amount: string; }

export interface VestingSchedule {
  vestingId: bigint; tokenAddress: string; tokenSymbol?: string; beneficiary: string; creator: string;
  totalAmount: bigint; releasedAmount: bigint; startBlock: bigint; cliffEndBlock: bigint; vestingEndBlock: bigint;
}

export interface VestingFormData { tokenAddress: string; beneficiaries: Beneficiary[]; cliffBlocks: number; vestingBlocks: number; startBlock?: number; }
export interface TransactionResult { success: boolean; txId?: string; error?: string; message?: string; }
export interface TokenInfo { address: string; name: string; symbol: string; decimals: number; balance?: bigint; }

export interface WalletProvider {
  requestAccounts: () => Promise<string[]>;
  getAccounts: () => Promise<string[]>;
  getPublicKey: () => Promise<string>;
  getNetwork: () => Promise<string>;
  getBalance: () => Promise<{ confirmed: number; unconfirmed: number; total: number }>;
  signPsbt: (psbtHex: string, options?: SignPsbtOptions) => Promise<string>;
  signMessage: (message: string) => Promise<string>;
  on: (event: string, callback: (...args: unknown[]) => void) => void;
  removeListener: (event: string, callback: (...args: unknown[]) => void) => void;
}

export interface SignPsbtOptions {
  autoFinalized?: boolean;
  toSignInputs?: Array<{ index: number; address?: string; publicKey?: string; sighashTypes?: number[]; disableTweakSigner?: boolean; }>;
}

export interface UTXO { txid: string; vout: number; satoshis: number; scriptPk: string; addressType: number; inscriptions: unknown[]; atomicals: unknown[]; }

export interface LPTokenInfo { address: string; name: string; symbol: string; decimals: number; tokenA: string; tokenB: string; dex: 'motoswap' | 'unknown'; }

export interface LiquidityLock {
  vestingId: bigint; tokenAddress: string; lpTokenInfo: LPTokenInfo; amount: bigint; creator: string; beneficiary: string;
  startBlock: bigint; cliffEndBlock: bigint; vestingEndBlock: bigint; releasedAmount: bigint;
  contractVersion: string; contractTaproot: string; isUnlocked: boolean; isClaimable: boolean;
  lockStatus: 'locked' | 'vesting' | 'releasing' | 'claimable' | 'claimed'; estimatedUnlockDate: string | null;
}
