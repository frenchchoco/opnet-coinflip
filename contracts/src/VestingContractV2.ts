/**
 * OPNet Vesting DApp - Smart Contract V2.5
 * Copyright (c) 2025 frenchchocolatine
 * All rights reserved.
 *
 * This source code is proprietary and confidential.
 * Unauthorized copying, modification, distribution, or use of this code,
 * via any medium, is strictly prohibited without explicit written permission.
 *
 * V2.5 security hardening:
 * - Zero-address validation on all inputs
 * - Overflow protection on block calculations
 * - Rounding-safe fee accounting in batch operations
 * - Released amount safety check in claim
 */

import { u256 } from '@btc-vision/as-bignum/assembly';
import {
    Address,
    Blockchain,
    BytesWriter,
    Calldata,
    OP_NET,
    Revert,
    SafeMath,
    Selector,
    StoredU256,
    encodeSelector,
} from '@btc-vision/btc-runtime/runtime';
import { StoredMapU256 } from '@btc-vision/btc-runtime/runtime/storage/maps/StoredMapU256';
import { TransferHelper } from '@btc-vision/btc-runtime/runtime/shared-libraries/TransferHelper';

// Storage pointers for vesting data
const NEXT_VESTING_ID_POINTER: u16 = Blockchain.nextPointer;
const VESTING_TOKEN_POINTER: u16 = Blockchain.nextPointer;
const VESTING_BENEFICIARY_POINTER: u16 = Blockchain.nextPointer;
const VESTING_CREATOR_POINTER: u16 = Blockchain.nextPointer;
const VESTING_TOTAL_POINTER: u16 = Blockchain.nextPointer;
const VESTING_RELEASED_POINTER: u16 = Blockchain.nextPointer;
const VESTING_START_POINTER: u16 = Blockchain.nextPointer;
const VESTING_CLIFF_POINTER: u16 = Blockchain.nextPointer;
const VESTING_END_POINTER: u16 = Blockchain.nextPointer;

// Fee configuration (0.5% = 5/1000)
const FEE_NUMERATOR: u32 = 5;
const FEE_DENOMINATOR: u32 = 1000;

// Batch operation limits
const MAX_BATCH_SIZE: u32 = 50;

// Maximum cliff + vesting duration in blocks (~100 years at 10 min/block)
const MAX_BLOCK_DURATION: u64 = 5256000;

/**
 * OP_NET Vesting Contract V2.5
 *
 * Features:
 * - Multiple vestings per beneficiary (each with unique ID)
 * - Multi-token support (any OP-20 token)
 * - 0.5% developer fee (transferred directly from user to dev via transferFrom)
 * - Non-custodial (no cancellation possible)
 * - Linear vesting with cliff period (vesting duration starts AFTER cliff)
 *
 * V2.5 Changes:
 * - Fixed fee transfer: now uses transferFrom(user -> dev) instead of transfer(contract -> dev)
 *   This avoids cross-contract call issues where the contract's transfer() could fail silently
 *
 * Dev Address: bcrt1py03msgdkpatmkgu5f3uyakk9unlr25neq64285y0z549h3mf9ctqlqf7rk
 */
@final
export class VestingContractV2 extends OP_NET {
    // Developer address for 0.5% fee (hardcoded for transparency)
    // Dev wallet taproot: bcrt1py03msgdkpatmkgu5f3uyakk9unlr25neq64285y0z549h3mf9ctqlqf7rk
    // ML-DSA address (SHA256 of ML-DSA pubkey): 0x5a6cdc183b82992b6fc8091059f05d35fa681bec792becf2023910cb69bc701d
    // NOTE: OP-20 balances use ML-DSA address, NOT taproot tweaked pubkey!
    private _devAddress: Address | null = null;

    // Counter for vesting IDs
    private readonly nextVestingId: StoredU256;

    // Vesting data stored by vestingId
    private readonly vestingToken: StoredMapU256;       // vestingId -> tokenAddress
    private readonly vestingBeneficiary: StoredMapU256; // vestingId -> beneficiary
    private readonly vestingCreator: StoredMapU256;     // vestingId -> creator
    private readonly vestingTotal: StoredMapU256;       // vestingId -> totalAmount
    private readonly vestingReleased: StoredMapU256;    // vestingId -> releasedAmount
    private readonly vestingStart: StoredMapU256;       // vestingId -> startBlock
    private readonly vestingCliff: StoredMapU256;       // vestingId -> cliffEndBlock
    private readonly vestingEnd: StoredMapU256;         // vestingId -> vestingEndBlock

    public constructor() {
        super();

        // Initialize storage FIRST (before using this)
        this.nextVestingId = new StoredU256(NEXT_VESTING_ID_POINTER, new Uint8Array(0));
        this.vestingToken = new StoredMapU256(VESTING_TOKEN_POINTER);
        this.vestingBeneficiary = new StoredMapU256(VESTING_BENEFICIARY_POINTER);
        this.vestingCreator = new StoredMapU256(VESTING_CREATOR_POINTER);
        this.vestingTotal = new StoredMapU256(VESTING_TOTAL_POINTER);
        this.vestingReleased = new StoredMapU256(VESTING_RELEASED_POINTER);
        this.vestingStart = new StoredMapU256(VESTING_START_POINTER);
        this.vestingCliff = new StoredMapU256(VESTING_CLIFF_POINTER);
        this.vestingEnd = new StoredMapU256(VESTING_END_POINTER);

        // Initialize dev address using ML-DSA address (NOT taproot tweaked pubkey!)
        // ML-DSA address: 0x5a6cdc183b82992b6fc8091059f05d35fa681bec792becf2023910cb69bc701d
        const devBytes: u8[] = [
            0x5a, 0x6c, 0xdc, 0x18, 0x3b, 0x82, 0x99, 0x2b,
            0x6f, 0xc8, 0x09, 0x10, 0x59, 0xf0, 0x5d, 0x35,
            0xfa, 0x68, 0x1b, 0xec, 0x79, 0x2b, 0xec, 0xf2,
            0x02, 0x39, 0x10, 0xcb, 0x69, 0xbc, 0x70, 0x1d
        ];
        this._devAddress = new Address(devBytes);
    }

    public override onDeployment(_calldata: Calldata): void {
        // Start vesting IDs at 1
        this.nextVestingId.value = u256.One;
    }

    private _addressToU256(addr: Address): u256 {
        return u256.fromUint8ArrayBE(addr);
    }

    private _u256ToAddress(val: u256): Address {
        const bytes = val.toUint8Array(true); // big-endian
        const addr = new Uint8Array(32);
        // Copy to ensure 32 bytes
        const offset = 32 - bytes.length;
        for (let i = 0; i < bytes.length; i++) {
            addr[offset + i] = bytes[i];
        }
        return changetype<Address>(addr);
    }

    private _getDevAddress(): Address {
        if (this._devAddress === null) {
            throw new Revert('Developer address not initialized');
        }
        return this._devAddress;
    }

    private _isZeroAddress(addr: Address): bool {
        const asU256 = u256.fromUint8ArrayBE(addr);
        return asU256 == u256.Zero;
    }

    private _validateAddress(addr: Address, label: string): void {
        if (this._isZeroAddress(addr)) {
            throw new Revert(label + ' cannot be zero address');
        }
    }

    /**
     * Validates vesting parameters (amount and duration)
     */
    private _validateVestingParams(amount: u256, vestingBlocks: u256): void {
        if (amount == u256.Zero) {
            throw new Revert('Amount must be greater than zero');
        }
        if (vestingBlocks == u256.Zero) {
            throw new Revert('Vesting duration must be greater than zero');
        }
    }

    private _validateBlockDuration(cliffBlocks: u256, vestingBlocks: u256): void {
        const maxDuration = u256.fromU64(MAX_BLOCK_DURATION);
        if (cliffBlocks > maxDuration) {
            throw new Revert('Cliff duration exceeds maximum');
        }
        if (vestingBlocks > maxDuration) {
            throw new Revert('Vesting duration exceeds maximum');
        }
        const totalDuration = SafeMath.add(cliffBlocks, vestingBlocks);
        const maxTotal = SafeMath.mul(maxDuration, u256.fromU32(2));
        if (totalDuration > maxTotal) {
            throw new Revert('Total duration exceeds maximum');
        }
    }

    /**
     * Calculate fee for a given amount.
     * fee = floor(amount * FEE_NUMERATOR / FEE_DENOMINATOR)
     */
    private _calculateFee(amount: u256): u256 {
        return SafeMath.div(
            SafeMath.mul(amount, u256.fromU32(FEE_NUMERATOR)),
            u256.fromU32(FEE_DENOMINATOR)
        );
    }

    public override execute(method: Selector, calldata: Calldata): BytesWriter {
        // createVesting(address,address,uint256,uint256,uint256) -> vestingId
        if (method == encodeSelector('createVesting(address,address,uint256,uint256,uint256)')) {
            return this.createVesting(calldata);
        }

        // claim(uint256) -> amountReleased
        if (method == encodeSelector('claim(uint256)')) {
            return this.claim(calldata);
        }

        // getVestingInfo(uint256) -> (token, beneficiary, creator, total, released, start, cliff, end)
        if (method == encodeSelector('getVestingInfo(uint256)')) {
            return this.getVestingInfo(calldata);
        }

        // getClaimableAmount(uint256) -> amount
        if (method == encodeSelector('getClaimableAmount(uint256)')) {
            return this.getClaimableAmount(calldata);
        }

        // getNextVestingId() -> nextId
        if (method == encodeSelector('getNextVestingId()')) {
            return this.getNextVestingId();
        }

        // createVestingBatch(address,uint256,uint256,uint256,bytes) -> firstVestingId
        // bytes = packed array of (address, uint256) pairs for beneficiaries and amounts
        if (method == encodeSelector('createVestingBatch(address,uint256,uint256,uint256,bytes)')) {
            return this.createVestingBatch(calldata);
        }

        return super.execute(method, calldata);
    }

    /**
     * Create a new vesting schedule
     *
     * IMPORTANT: Caller must have already approved this contract to spend their tokens!
     * Call token.approve(vestingContract, amount) before calling createVesting.
     *
     * @param token - Address of the OP-20 token
     * @param beneficiary - Address that can claim the vested tokens
     * @param amount - Total amount of tokens to vest (before 0.5% fee)
     * @param cliffBlocks - Number of blocks before any tokens can be claimed
     * @param vestingBlocks - Duration of linear vesting AFTER cliff ends
     * @returns vestingId
     */
    private createVesting(calldata: Calldata): BytesWriter {
        const tokenAddr = calldata.readAddress();
        const beneficiary = calldata.readAddress();
        const amount = calldata.readU256();
        const cliffBlocks = calldata.readU256();
        const vestingBlocks = calldata.readU256();

        // Validate inputs
        this._validateAddress(tokenAddr, 'Token');
        this._validateAddress(beneficiary, 'Beneficiary');
        this._validateVestingParams(amount, vestingBlocks);
        this._validateBlockDuration(cliffBlocks, vestingBlocks);

        // Calculate fee and net amount
        const feeAmount = this._calculateFee(amount);
        const netAmount = SafeMath.sub(amount, feeAmount);

        if (netAmount == u256.Zero) {
            throw new Revert('Net amount after fee is zero');
        }

        // Get current block and calculate end blocks
        const currentBlock = u256.fromU64(Blockchain.block.number);
        const cliffEndBlock = SafeMath.add(currentBlock, cliffBlocks);
        const vestingEndBlock = SafeMath.add(cliffEndBlock, vestingBlocks);

        // Get next vesting ID
        const vestingId = this.nextVestingId.value;

        // Store vesting data (CEI: effects before interactions)
        this.vestingToken.set(vestingId, this._addressToU256(tokenAddr));
        this.vestingBeneficiary.set(vestingId, this._addressToU256(beneficiary));
        this.vestingCreator.set(vestingId, this._addressToU256(Blockchain.tx.sender));
        this.vestingTotal.set(vestingId, netAmount);
        this.vestingReleased.set(vestingId, u256.Zero);
        this.vestingStart.set(vestingId, currentBlock);
        this.vestingCliff.set(vestingId, cliffEndBlock);
        this.vestingEnd.set(vestingId, vestingEndBlock);

        // Increment vesting ID counter
        this.nextVestingId.value = SafeMath.add(vestingId, u256.One);

        // Interactions: transfer tokens
        TransferHelper.transferFrom(
            tokenAddr,
            Blockchain.tx.sender,
            Blockchain.contractAddress,
            netAmount
        );

        if (feeAmount > u256.Zero) {
            TransferHelper.transferFrom(
                tokenAddr,
                Blockchain.tx.sender,
                this._getDevAddress(),
                feeAmount
            );
        }

        // Return the vesting ID
        const response = new BytesWriter(32);
        response.writeU256(vestingId);
        return response;
    }

    /**
     * Create multiple vesting schedules in a single transaction (batch)
     *
     * IMPORTANT: Caller must have already approved this contract to spend their tokens!
     * Approve total amount (sum of all beneficiary amounts) before calling.
     *
     * Fee is 0.5% per beneficiary, computed individually for rounding safety.
     */
    private createVestingBatch(calldata: Calldata): BytesWriter {
        const tokenAddr = calldata.readAddress();
        const cliffBlocks = calldata.readU256();
        const vestingBlocks = calldata.readU256();
        const count = calldata.readU256();

        // Validate inputs
        this._validateAddress(tokenAddr, 'Token');
        if (vestingBlocks == u256.Zero) {
            throw new Revert('Vesting duration must be greater than zero');
        }
        this._validateBlockDuration(cliffBlocks, vestingBlocks);

        if (count > u256.fromU32(u32.MAX_VALUE)) {
            throw new Revert('Batch count exceeds maximum u32 value');
        }
        const countU32 = count.toU32();
        if (countU32 == 0) {
            throw new Revert('Batch must have at least one beneficiary');
        }
        if (countU32 > MAX_BATCH_SIZE) {
            throw new Revert('Batch size exceeds maximum allowed');
        }

        const currentBlock = u256.fromU64(Blockchain.block.number);
        const cliffEndBlock = SafeMath.add(currentBlock, cliffBlocks);
        const vestingEndBlock = SafeMath.add(cliffEndBlock, vestingBlocks);

        // Read all beneficiaries and amounts, calculate fees per-entry (rounding-safe)
        const beneficiaries: Address[] = [];
        const netAmounts: u256[] = [];
        let totalNetAmount = u256.Zero;
        let totalFeeAmount = u256.Zero;

        for (let i: u32 = 0; i < countU32; i++) {
            const beneficiary = calldata.readAddress();
            const amount = calldata.readU256();

            this._validateAddress(beneficiary, 'Beneficiary');
            if (amount == u256.Zero) {
                throw new Revert('Amount must be greater than zero');
            }

            const fee = this._calculateFee(amount);
            const net = SafeMath.sub(amount, fee);
            if (net == u256.Zero) {
                throw new Revert('Net amount after fee is zero');
            }

            beneficiaries.push(beneficiary);
            netAmounts.push(net);
            totalNetAmount = SafeMath.add(totalNetAmount, net);
            totalFeeAmount = SafeMath.add(totalFeeAmount, fee);
        }

        const firstVestingId = this.nextVestingId.value;

        // Pre-calculate constants outside loop for gas optimization
        const creatorU256 = this._addressToU256(Blockchain.tx.sender);
        const tokenU256 = this._addressToU256(tokenAddr);
        const zeroU256 = u256.Zero;

        // Store all vestings (CEI: effects before interactions)
        for (let i: u32 = 0; i < countU32; i++) {
            const vestingId = SafeMath.add(firstVestingId, u256.fromU32(i));

            this.vestingToken.set(vestingId, tokenU256);
            this.vestingBeneficiary.set(vestingId, this._addressToU256(beneficiaries[i]));
            this.vestingCreator.set(vestingId, creatorU256);
            this.vestingTotal.set(vestingId, netAmounts[i]);
            this.vestingReleased.set(vestingId, zeroU256);
            this.vestingStart.set(vestingId, currentBlock);
            this.vestingCliff.set(vestingId, cliffEndBlock);
            this.vestingEnd.set(vestingId, vestingEndBlock);
        }

        this.nextVestingId.value = SafeMath.add(firstVestingId, u256.fromU32(countU32));

        // Interactions: transfer tokens
        TransferHelper.transferFrom(
            tokenAddr,
            Blockchain.tx.sender,
            Blockchain.contractAddress,
            totalNetAmount
        );

        if (totalFeeAmount > u256.Zero) {
            TransferHelper.transferFrom(
                tokenAddr,
                Blockchain.tx.sender,
                this._getDevAddress(),
                totalFeeAmount
            );
        }

        const response = new BytesWriter(32);
        response.writeU256(firstVestingId);
        return response;
    }

    /**
     * Claim vested tokens for a specific vesting ID
     * Only the beneficiary can call this
     *
     * IMPORTANT: The beneficiary is stored as the tweaked public key (from taproot address).
     * We use Blockchain.tx.origin.tweakedPublicKey to verify the caller owns that taproot address.
     * Tokens are transferred to the caller's ML-DSA address (Blockchain.tx.sender).
     *
     * @param vestingId - The ID of the vesting schedule
     * @returns amountReleased
     */
    private claim(calldata: Calldata): BytesWriter {
        const vestingId = calldata.readU256();

        // Verify vesting exists by checking total amount
        const totalAmount = this.vestingTotal.get(vestingId);
        if (totalAmount == u256.Zero) {
            throw new Revert('Vesting does not exist');
        }

        // Get the stored beneficiary (tweaked public key from taproot address)
        const beneficiaryU256 = this.vestingBeneficiary.get(vestingId);

        // Get the caller's tweaked public key from tx.origin (ExtendedAddress)
        const origin = Blockchain.tx.origin;
        const callerTweakedKey = origin.tweakedPublicKey;
        const callerTweakedU256 = u256.fromUint8ArrayBE(callerTweakedKey);

        // Verify caller's taproot identity matches the beneficiary
        if (beneficiaryU256 != callerTweakedU256) {
            throw new Revert('Only beneficiary can claim');
        }

        // Calculate claimable amount
        const claimable = this._calculateClaimable(vestingId);

        if (claimable == u256.Zero) {
            throw new Revert('No tokens available to claim');
        }

        // CEI: update state before external call
        const currentReleased = this.vestingReleased.get(vestingId);
        const newReleased = SafeMath.add(currentReleased, claimable);

        // Safety check: released should never exceed total
        if (newReleased > totalAmount) {
            throw new Revert('Release amount exceeds total');
        }

        this.vestingReleased.set(vestingId, newReleased);

        // Get token address for transfer
        const tokenU256 = this.vestingToken.get(vestingId);
        const tokenAddr = this._u256ToAddress(tokenU256);

        // Transfer tokens to the caller's ML-DSA address (sender)
        TransferHelper.transfer(tokenAddr, Blockchain.tx.sender, claimable);

        // Return the claimed amount
        const response = new BytesWriter(32);
        response.writeU256(claimable);
        return response;
    }

    /**
     * Calculate claimable amount for a vesting
     *
     * Linear vesting formula (starts from cliff end):
     * - Before cliff: 0
     * - At cliff end: 0 (vesting just starts)
     * - During vesting: total * (currentBlock - cliffEnd) / (vestingEnd - cliffEnd)
     * - After vesting end: total - released
     */
    private _calculateClaimable(vestingId: u256): u256 {
        const currentBlock = u256.fromU64(Blockchain.block.number);
        const cliffEnd = this.vestingCliff.get(vestingId);

        // Before cliff ends: nothing claimable
        if (currentBlock < cliffEnd) {
            return u256.Zero;
        }

        const total = this.vestingTotal.get(vestingId);
        const released = this.vestingReleased.get(vestingId);
        const end = this.vestingEnd.get(vestingId);

        // After vesting end: all remaining tokens
        if (currentBlock >= end) {
            return SafeMath.sub(total, released);
        }

        // During vesting: linear release from cliff end
        // elapsed = currentBlock - cliffEnd
        // duration = vestingEnd - cliffEnd (this is the vestingBlocks parameter)
        // vested = total * elapsed / duration
        const elapsed = SafeMath.sub(currentBlock, cliffEnd);
        const duration = SafeMath.sub(end, cliffEnd);
        const vested = SafeMath.div(SafeMath.mul(total, elapsed), duration);

        return SafeMath.sub(vested, released);
    }

    /**
     * Get claimable amount (read-only)
     */
    private getClaimableAmount(calldata: Calldata): BytesWriter {
        const vestingId = calldata.readU256();
        const claimable = this._calculateClaimable(vestingId);

        const response = new BytesWriter(32);
        response.writeU256(claimable);
        return response;
    }

    /**
     * Get all vesting information for a vesting ID
     */
    private getVestingInfo(calldata: Calldata): BytesWriter {
        const vestingId = calldata.readU256();

        const token = this.vestingToken.get(vestingId);
        const beneficiary = this.vestingBeneficiary.get(vestingId);
        const creator = this.vestingCreator.get(vestingId);
        const total = this.vestingTotal.get(vestingId);
        const released = this.vestingReleased.get(vestingId);
        const start = this.vestingStart.get(vestingId);
        const cliff = this.vestingCliff.get(vestingId);
        const end = this.vestingEnd.get(vestingId);

        // Return all data: 8 x u256 = 256 bytes
        const response = new BytesWriter(256);
        response.writeU256(token);
        response.writeU256(beneficiary);
        response.writeU256(creator);
        response.writeU256(total);
        response.writeU256(released);
        response.writeU256(start);
        response.writeU256(cliff);
        response.writeU256(end);
        return response;
    }

    /**
     * Get the next vesting ID (useful for tracking)
     */
    private getNextVestingId(): BytesWriter {
        const response = new BytesWriter(32);
        response.writeU256(this.nextVestingId.value);
        return response;
    }
}
