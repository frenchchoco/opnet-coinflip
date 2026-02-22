/**
 * OPNet Vesting DApp
 * Copyright (c) 2026 frenchchocolatine
 * All rights reserved.
 *
 * This source code is proprietary and confidential.
 * Unauthorized copying, modification, distribution, or use of this code,
 * via any medium, is strictly prohibited without explicit written permission.
 */

/**
 * Decode a hex string to Uint8Array.
 * Replaces: Buffer.from(hex, 'hex')
 */
export const hexToBytes = (hex: string): Uint8Array => {
  let clean = hex.replace(/^0x/, '');
  if (clean.length % 2 !== 0) clean = '0' + clean;
  if (clean.length > 0 && !/^[0-9a-fA-F]+$/.test(clean)) {
    throw new Error(`hexToBytes: invalid hex string`);
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
};

/**
 * Encode a Uint8Array to hex string (no 0x prefix).
 * Replaces: Buffer.from(bytes).toString('hex')
 */
export const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');

/**
 * Concatenate multiple Uint8Arrays into one.
 * Replaces: Buffer.concat([a, b, ...])
 */
export const concatBytes = (...arrays: Uint8Array[]): Uint8Array => {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
};
