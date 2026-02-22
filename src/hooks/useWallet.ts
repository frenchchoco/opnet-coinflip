import { useState, useCallback, useMemo } from 'react';
import { useWalletConnect, type SupportedWallets } from '@btc-vision/walletconnect';
import { Address } from '@btc-vision/transaction';
import { sha256 } from '@noble/hashes/sha2.js';
import { getNetwork } from '../services/opnetProvider';
import type { WalletAddress, WalletSigner } from '../types/sdk';

/** Detect address type from a Bitcoin address string */
const detectAddressType = (addr: string | null): string => {
  if (!addr) return 'Unknown';
  if (addr.startsWith('opr1') || addr.startsWith('op1')) return 'ML-DSA';
  if (addr.startsWith('bc1p') || addr.startsWith('bcrt1p') || addr.startsWith('tb1p')) return 'Taproot';
  if (addr.startsWith('bc1q') || addr.startsWith('bcrt1q') || addr.startsWith('tb1q')) return 'SegWit';
  if (addr.startsWith('3') || addr.startsWith('2')) return 'Nested SegWit';
  if (addr.startsWith('1') || addr.startsWith('m') || addr.startsWith('n')) return 'Legacy';
  return 'Unknown';
};

/** Convert hex string to Uint8Array */
const hexToBytes = (hex: string): Uint8Array => {
  const clean = hex.replace(/^0x/, '');
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return bytes;
};

/**
 * Build an Address object from a secp256k1 public key alone (no ML-DSA).
 * Uses SHA-256 of the public key as a deterministic placeholder for the ML-DSA slot.
 * This makes p2tr(), p2wpkh(), p2pkh() all functional.
 */
const buildAddressFromPublicKey = (publicKeyHex: string): Address | null => {
  try {
    const pubKeyBytes = hexToBytes(publicKeyHex);
    if (pubKeyBytes.length !== 33 && pubKeyBytes.length !== 65) return null;
    const mldsaPlaceholder = sha256(pubKeyBytes); // 32 bytes — deterministic
    return new Address(mldsaPlaceholder, pubKeyBytes);
  } catch (e) {
    console.warn('[useWallet] Failed to build Address from publicKey:', e);
    return null;
  }
};

export interface WalletState {
  /** Raw address string from the wallet (any format) */
  address: string | null;
  /** SDK Address object — works for both OP_WALLET and Unisat */
  addressObject: WalletAddress;
  /** Always-Taproot address, derived if necessary */
  taprootAddress: string | null;
  /** Detected address type: "Taproot" | "SegWit" | "Legacy" | "ML-DSA" | etc. */
  addressType: string;
  publicKey: string | null;
  mldsaPublicKey: string | null;
  network: string | null;
  balance: number;
  walletType: string | null;
  isConnected: boolean;
  isConnecting: boolean;
  error: string | null;
  openConnectModal: () => void;
  connectToWallet: (wallet: SupportedWallets) => void;
  availableWallets: { name: SupportedWallets; isInstalled: boolean }[];
  disconnect: () => void;
  getSigner: () => WalletSigner;
}

export const useWallet = (): WalletState => {
  const wc = useWalletConnect();
  const [error, setError] = useState<string | null>(null);

  const openConnectModal = useCallback(() => {
    setError(null);
    try { wc.openConnectModal(); } catch (err) { setError(err instanceof Error ? err.message : 'Failed to open connect modal'); }
  }, [wc]);

  const disconnect = useCallback(() => {
    setError(null);
    try { wc.disconnect(); } catch (err) { setError(err instanceof Error ? err.message : 'Failed to disconnect'); }
  }, [wc]);

  const getSigner = useCallback(() => wc.signer, [wc]);

  const connectToWallet = useCallback((wallet: SupportedWallets) => {
    setError(null);
    try { wc.connectToWallet(wallet); } catch (err) { setError(err instanceof Error ? err.message : 'Failed to connect'); }
  }, [wc]);

  const availableWallets = useMemo(() => wc.allWallets || [], [wc.allWallets]);

  // Build Address object: use SDK's Address if available (OP_WALLET), otherwise build from publicKey (Unisat)
  const addressObject = useMemo(() => {
    if (wc.address) return wc.address;
    if (wc.publicKey) return buildAddressFromPublicKey(wc.publicKey);
    return null;
  }, [wc.address, wc.publicKey]);

  // Detect address type from the raw wallet address
  const addressType = useMemo(() => detectAddressType(wc.walletAddress), [wc.walletAddress]);

  // Always derive a Taproot address regardless of connection format
  const taprootAddress = useMemo(() => {
    const rawAddr = wc.walletAddress;
    if (!rawAddr) return null;

    // Already Taproot — use directly
    if (rawAddr.startsWith('bc1p') || rawAddr.startsWith('bcrt1p') || rawAddr.startsWith('tb1p')) {
      return rawAddr;
    }

    // Derive Taproot from Address object
    if (addressObject) {
      try {
        return addressObject.p2tr(getNetwork()) ?? null;
      } catch (e) {
        console.warn('[useWallet] Failed to derive Taproot address:', e);
      }
    }

    return null;
  }, [wc.walletAddress, addressObject]);

  // Connected = wallet has provided an address string (not dependent on Address object)
  const isConnected = wc.walletAddress !== null && wc.walletAddress.length > 0;

  return {
    address: wc.walletAddress,
    addressObject,
    taprootAddress,
    addressType,
    publicKey: wc.publicKey,
    mldsaPublicKey: wc.mldsaPublicKey,
    network: wc.network?.network ?? null,
    balance: wc.walletBalance?.total ?? 0,
    walletType: wc.walletType,
    isConnected,
    isConnecting: wc.connecting,
    error, openConnectModal, connectToWallet, availableWallets, disconnect, getSigner,
  };
};
