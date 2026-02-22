import { getContract, type BitcoinInterfaceAbi } from 'opnet';
import type { Address } from '@btc-vision/transaction';
import type { DynamicContract } from '../types/sdk';
import { providerService } from './opnetProvider';
import type { NetworkType } from '../config/networks';

/**
 * Singleton service for caching smart contract instances.
 * Implements Map-based caching per OPNet frontend guidelines (frontend-guidelines.md:239-288).
 */
class ContractService {
  private static instance: ContractService;
  private contracts: Map<string, DynamicContract> = new Map();

  private constructor() {}

  /**
   * Get the singleton instance of ContractService.
   */
  public static getInstance(): ContractService {
    if (!ContractService.instance) {
      ContractService.instance = new ContractService();
    }
    return ContractService.instance;
  }

  /**
   * Generate a unique cache key for a contract instance.
   * @param contractAddress - The contract address (tweaked hex format)
   * @param network - The network type
   * @param senderAddress - Optional sender address for the contract call
   * @returns Unique cache key string
   */
  private getCacheKey(
    contractAddress: string,
    network: NetworkType,
    abi: BitcoinInterfaceAbi,
    senderAddress?: Address
  ): string {
    const senderKey = senderAddress ? senderAddress.toString() : 'none';
    const abiKey = abi?.length ?? 'default';
    return `${contractAddress}:${network}:${abiKey}:${senderKey}`;
  }

  /**
   * Get or create a cached contract instance.
   * @param contractAddress - The contract address in tweaked hex format (0x...)
   * @param abi - The contract ABI
   * @param network - The network type (regtest or mainnet)
   * @param senderAddress - Optional sender address for transactions
   * @returns Cached or newly created DynamicContract instance
   */
  public getContract(
    contractAddress: string,
    abi: BitcoinInterfaceAbi,
    network?: NetworkType,
    senderAddress?: Address
  ): DynamicContract {
    const targetNetwork = network || providerService.getCurrentNetwork();
    const cacheKey = this.getCacheKey(contractAddress, targetNetwork, abi, senderAddress);

    if (!this.contracts.has(cacheKey)) {
      const provider = providerService.getProvider(targetNetwork);
      const networkConfig = providerService.getNetwork();
      const contract = getContract(contractAddress, abi, provider, networkConfig, senderAddress);
      this.contracts.set(cacheKey, contract);
    }

    return this.contracts.get(cacheKey)!;
  }

  /**
   * Clear all cached contract instances.
   * Useful when switching networks or resetting application state.
   */
  public clearCache(): void {
    this.contracts.clear();
  }

  /**
   * Remove a specific contract from the cache.
   * @param contractAddress - The contract address
   * @param network - The network type
   * @param senderAddress - Optional sender address
   */
  public invalidateContract(
    contractAddress: string,
    network: NetworkType,
    abi: BitcoinInterfaceAbi,
    senderAddress?: Address
  ): void {
    const cacheKey = this.getCacheKey(contractAddress, network, abi, senderAddress);
    this.contracts.delete(cacheKey);
  }

  /**
   * Get the number of cached contract instances.
   * @returns Number of cached contracts
   */
  public getCacheSize(): number {
    return this.contracts.size;
  }
}

// Export singleton instance
export const contractService = ContractService.getInstance();
