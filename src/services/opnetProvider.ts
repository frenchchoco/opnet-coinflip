import { JSONRpcProvider } from 'opnet';
import { networks, address as btcAddress } from '@btc-vision/bitcoin';
import { NETWORKS, DEFAULT_NETWORK, type NetworkType } from '../config/networks';
import { hexToBytes, bytesToHex } from '../utils/bytes';

const getNetworkConfig = (network: NetworkType) =>
  network === 'regtest' ? networks.regtest : networks.bitcoin;

/**
 * Singleton service for managing OPNet JSONRpcProvider instances.
 * Implements Map-based caching per OPNet frontend guidelines.
 */
class ProviderService {
  private static instance: ProviderService;
  private providers: Map<NetworkType, JSONRpcProvider> = new Map();
  private currentNetwork: NetworkType = DEFAULT_NETWORK;

  private constructor() {}

  /**
   * Get the singleton instance of ProviderService.
   */
  public static getInstance(): ProviderService {
    if (!ProviderService.instance) {
      ProviderService.instance = new ProviderService();
    }
    return ProviderService.instance;
  }

  /**
   * Get or create a cached JSONRpcProvider for the specified network.
   * @param network - The network type (regtest or mainnet)
   * @returns Cached JSONRpcProvider instance
   */
  public getProvider(network?: NetworkType): JSONRpcProvider {
    const targetNetwork = network || this.currentNetwork;

    if (!this.providers.has(targetNetwork)) {
      const provider = new JSONRpcProvider({
        url: NETWORKS[targetNetwork].rpcUrl,
        network: getNetworkConfig(targetNetwork),
      });
      this.providers.set(targetNetwork, provider);
    }

    return this.providers.get(targetNetwork)!;
  }

  /**
   * Set the current active network.
   * @param network - The network to set as active
   */
  public setNetwork(network: NetworkType): void {
    this.currentNetwork = network;
  }

  /**
   * Get the current active network type.
   * @returns The current network type
   */
  public getCurrentNetwork(): NetworkType {
    return this.currentNetwork;
  }

  /**
   * Get the network configuration for the current network.
   * @returns Bitcoin network configuration
   */
  public getNetwork() {
    return getNetworkConfig(this.currentNetwork);
  }
}

// Export singleton instance
export const providerService = ProviderService.getInstance();

// Export convenience functions for backward compatibility
export const getProvider = (network?: NetworkType): JSONRpcProvider =>
  providerService.getProvider(network);

export const getNetwork = () => providerService.getNetwork();

export const setNetwork = (network: NetworkType) => providerService.setNetwork(network);

export const getCurrentNetwork = (): NetworkType => providerService.getCurrentNetwork();

export const getMinutesPerBlock = (): number => NETWORKS[getCurrentNetwork()].minutesPerBlock;

export const getExplorerUrl = (txId: string): string =>
  `${NETWORKS[getCurrentNetwork()].explorerUrl}/tx/${txId}`;

export const getAddressExplorerUrl = (address: string): string =>
  `${NETWORKS[getCurrentNetwork()].explorerUrl}/address/${address}`;

export const getBlockHeight = async (): Promise<number> => {
  const blockNumber = await getProvider().getBlockNumber();
  return Number(blockNumber);
};

/** Convert Taproot address (bc1p/bcrt1p) to tweaked hex (0x...) for OPNet SDK */
export const taprootToTweakedHex = (taprootAddress: string): string => {
  if (taprootAddress.startsWith('0x')) return taprootAddress;
  try {
    const decoded = btcAddress.fromBech32(taprootAddress);
    return '0x' + bytesToHex(decoded.data);
  } catch { throw new Error(`Invalid taproot address: ${taprootAddress}`); }
};

/**
 * Convert tweaked hex (32 bytes) to Taproot Bech32 address (bc1p/bcrt1p).
 * Used to display human-readable addresses from contract storage.
 * @param hexAddress - Hex string (with or without 0x prefix, 64 chars)
 * @param network - Optional network type (defaults to current network)
 * @returns Bech32 encoded Taproot address (bc1p... or bcrt1p...)
 */
export const hexToTaprootAddress = (hexAddress: string, network?: NetworkType): string => {
  try {
    // Remove 0x prefix and ensure lowercase
    const cleanHex = hexAddress.replace(/^0x/, '').toLowerCase();

    // Validate hex length (should be 64 chars for 32 bytes)
    if (cleanHex.length !== 64) {
      return hexAddress; // Return original if invalid length
    }

    // Convert hex to Uint8Array
    const pubkeyBytes = hexToBytes(cleanHex);

    // Determine network prefix
    const targetNetwork = network || getCurrentNetwork();
    const prefix = targetNetwork === 'regtest' ? 'bcrt' : 'bc';

    // Encode as Bech32 Taproot address (version 1, 32 bytes)
    const encoded = btcAddress.toBech32(pubkeyBytes, 1, prefix);
    return encoded;
  } catch (error) {
    // If conversion fails, return truncated hex as fallback
    const cleanHex = hexAddress.replace(/^0x/, '');
    return `${cleanHex.slice(0, 8)}...${cleanHex.slice(-6)}`;
  }
};

/** Check ML-DSA public key availability for multiple addresses */
export const checkPubkeyAvailability = async (
  addresses: string[]
): Promise<{ withPubkey: string[]; withoutPubkey: string[] }> => {
  try {
    const rawResults = await getProvider().getPublicKeysInfoRaw(addresses);
    const withPubkey: string[] = [], withoutPubkey: string[] = [];
    for (const addr of addresses) {
      const info = rawResults[addr];
      if (!info || 'error' in info || !info.mldsaHashedPublicKey) withoutPubkey.push(addr);
      else withPubkey.push(addr);
    }
    return { withPubkey, withoutPubkey };
  } catch {
    return { withPubkey: [], withoutPubkey: [...addresses] };
  }
};

/** Check if an address has its ML-DSA public key revealed on OPNet */
export const isAddressKnownByOPNet = async (address: string): Promise<boolean> => {
  if (!address.startsWith('bc1p') && !address.startsWith('bcrt1p') && !address.startsWith('tb1p')) return false;
  try {
    const { withPubkey } = await checkPubkeyAvailability([address]);
    return withPubkey.includes(address);
  } catch { return false; }
};

/** Calculate estimated date from current block to target block */
export const estimateDateFromBlockHeight = (targetBlock: number, currentBlock: number): Date => {
  const blocksRemaining = targetBlock - currentBlock;
  const minutesPerBlock = getMinutesPerBlock();
  const minutesRemaining = blocksRemaining * minutesPerBlock;
  const msRemaining = minutesRemaining * 60 * 1000;
  return new Date(Date.now() + msRemaining);
};

/** Format estimated date for display */
export const formatEstimatedDate = (date: Date): string => {
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const diffMinutes = Math.floor(diffMs / 60000);

  if (diffMinutes < 60) return `~${diffMinutes} minutes`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `~${diffHours} hours`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `~${diffDays} days`;
  const diffMonths = Math.floor(diffDays / 30);
  return `~${diffMonths} months`;
};

/** Format full date with time estimate */
export const formatBlockDateEstimate = (targetBlock: number, currentBlock: number): string => {
  const estimatedDate = estimateDateFromBlockHeight(targetBlock, currentBlock);
  const timeFromNow = formatEstimatedDate(estimatedDate);
  const dateStr = estimatedDate.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
  return `${dateStr} (${timeFromNow} from now)`;
};
