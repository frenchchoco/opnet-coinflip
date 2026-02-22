/**
 * OPNet Vesting DApp - Smart Contract V4
 * Copyright (c) 2025 frenchchocolatine
 * All rights reserved.
 *
 * This source code is proprietary and confidential.
 * Unauthorized copying, modification, distribution, or use of this code,
 * via any medium, is strictly prohibited without explicit written permission.
 *
 * V4 Features:
 * - Optimized batch functions for reduced transaction fees
 * - createVestingBatchUniform: For identical amounts (50% fee reduction)
 * - createVestingBatchCompact: For variable amounts with u64 (37% fee reduction)
 * - Full backward compatibility with V2.5
 * - Zero-address validation on all inputs
 * - Overflow protection on block calculations
 * - Rounding-safe fee accounting in batch operations
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
const MAX_BATCH_SIZE: u32 = 200;

// Maximum cliff + vesting duration in blocks (~100 years at 10 min/block)
const MAX_BLOCK_DURATION: u64 = 5256000;

/**
 * OP_NET Vesting Contract V4
 *
 * Features:
 * - Multiple vestings per beneficiary (each with unique ID)
 * - Multi-token support (any OP-20 token)
 * - 0.5% developer fee (transferred directly from user to dev via transferFrom)
 * - Non-custodial (no cancellation possible)
 * - Linear vesting with cliff period (vesting duration starts AFTER cliff)
 *
 * V4 Optimizations:
 * - createVestingBatchUniform: Same amount for all → 50% less calldata
 * - createVestingBatchCompact: u64 amounts → 37% less calldata
 *
 * Dev Address: bcrt1py03msgdkpatmkgu5f3uyakk9unlr25neq64285y0z549h3mf9ctqlqf7rk
 */
@final
export class VestingContractV4 extends OP_NET {
    // Developer address for 0.5% fee (hardcoded for transparency)
    private _devAddress: Address | null = null;

    // Counter for vesting IDs
    private readonly nextVestingId: StoredU256;

    // Vesting data stored by vestingId
    private readonly vestingToken: StoredMapU256;
    private readonly vestingBeneficiary: StoredMapU256;
    private readonly vestingCreator: StoredMapU256;
    private readonly vestingTotal: StoredMapU256;
    private readonly vestingReleased: StoredMapU256;
    private readonly vestingStart: StoredMapU256;
    private readonly vestingCliff: StoredMapU256;
    private readonly vestingEnd: StoredMapU256;

    /**
     * Constructor for VestingContractV4.
     * Initializes storage pointers and sets the developer address for fee collection.
     */
    public constructor() {
        super();

        this.nextVestingId = new StoredU256(NEXT_VESTING_ID_POINTER, new Uint8Array(0));
        this.vestingToken = new StoredMapU256(VESTING_TOKEN_POINTER);
        this.vestingBeneficiary = new StoredMapU256(VESTING_BENEFICIARY_POINTER);
        this.vestingCreator = new StoredMapU256(VESTING_CREATOR_POINTER);
        this.vestingTotal = new StoredMapU256(VESTING_TOTAL_POINTER);
        this.vestingReleased = new StoredMapU256(VESTING_RELEASED_POINTER);
        this.vestingStart = new StoredMapU256(VESTING_START_POINTER);
        this.vestingCliff = new StoredMapU256(VESTING_CLIFF_POINTER);
        this.vestingEnd = new StoredMapU256(VESTING_END_POINTER);

        // ML-DSA address for dev
        const devBytes: u8[] = [
            0x5a, 0x6c, 0xdc, 0x18, 0x3b, 0x82, 0x99, 0x2b,
            0x6f, 0xc8, 0x09, 0x10, 0x59, 0xf0, 0x5d, 0x35,
            0xfa, 0x68, 0x1b, 0xec, 0x79, 0x2b, 0xec, 0xf2,
            0x02, 0x39, 0x10, 0xcb, 0x69, 0xbc, 0x70, 0x1d
        ];
        this._devAddress = new Address(devBytes);
    }

    /**
     * Called once when the contract is deployed.
     * Initializes the next vesting ID counter to 1.
     * @param _calldata - Deployment calldata (unused)
     */
    public override onDeployment(_calldata: Calldata): void {
        this.nextVestingId.value = u256.One;
    }

    /**
     * Convert an Address to u256 for storage.
     * @param addr - The address to convert
     * @returns The u256 representation
     */
    private _addressToU256(addr: Address): u256 {
        return u256.fromUint8ArrayBE(addr);
    }

    /**
     * Convert a u256 back to an Address for transfers.
     * @param val - The u256 value to convert
     * @returns The Address object
     */
    private _u256ToAddress(val: u256): Address {
        const bytes = val.toUint8Array(true);
        const addr = new Uint8Array(32);
        const offset = 32 - bytes.length;
        for (let i = 0; i < bytes.length; i++) {
            addr[offset + i] = bytes[i];
        }
        return changetype<Address>(addr);
    }

    /**
     * Get the developer address for fee collection.
     * @returns The developer Address
     * @throws Revert if developer address is not initialized
     */
    private _getDevAddress(): Address {
        if (!this._devAddress) {
            throw new Revert('Developer address not initialized');
        }
        return this._devAddress as Address;
    }

    /**
     * Check if an address is the zero address (all zeros).
     * @param addr - The address to check
     * @returns True if the address is zero
     */
    private _isZeroAddress(addr: Address): bool {
        const asU256 = u256.fromUint8ArrayBE(addr);
        return asU256 == u256.Zero;
    }

    /**
     * Validate that an address is not the zero address.
     * @param addr - The address to validate
     * @param label - Human-readable label for error messages
     * @throws Revert if address is zero
     */
    private _validateAddress(addr: Address, label: string): void {
        if (this._isZeroAddress(addr)) {
            throw new Revert(label + ' cannot be zero address');
        }
    }

    /**
     * Validate basic vesting parameters (amount and duration).
     * @param amount - The token amount to vest
     * @param vestingBlocks - The vesting duration in blocks
     * @throws Revert if amount or vesting duration is zero
     */
    private _validateVestingParams(amount: u256, vestingBlocks: u256): void {
        if (amount == u256.Zero) {
            throw new Revert('Amount must be greater than zero');
        }
        if (vestingBlocks == u256.Zero) {
            throw new Revert('Vesting duration must be greater than zero');
        }
    }

    /**
     * Validate block durations to prevent overflow and ensure reasonable bounds.
     * Maximum duration per field is ~100 years (5,256,000 blocks at 10 min/block).
     * @param cliffBlocks - The cliff period in blocks
     * @param vestingBlocks - The vesting duration in blocks
     * @throws Revert if durations exceed maximum limits
     */
    private _validateBlockDuration(cliffBlocks: u256, vestingBlocks: u256): void {
        const maxDuration = u256.fromU64(MAX_BLOCK_DURATION);
        if (cliffBlocks > maxDuration) {
            throw new Revert('Cliff duration exceeds maximum');
        }
        if (vestingBlocks > maxDuration) {
            throw new Revert('Vesting duration exceeds maximum');
        }
        // Also validate the sum doesn't overflow reasonable bounds
        const totalDuration = SafeMath.add(cliffBlocks, vestingBlocks);
        const maxTotal = SafeMath.mul(maxDuration, u256.fromU32(2));
        if (totalDuration > maxTotal) {
            throw new Revert('Total duration exceeds maximum');
        }
    }

    /**
     * Calculate the 0.5% developer fee for a given amount using floor division.
     * Formula: fee = floor(amount × 5 / 1000)
     * @param amount - The gross amount before fee deduction
     * @returns The fee amount (always rounded down)
     */
    private _calculateFee(amount: u256): u256 {
        return SafeMath.div(
            SafeMath.mul(amount, u256.fromU32(FEE_NUMERATOR)),
            u256.fromU32(FEE_DENOMINATOR)
        );
    }

    /**
     * Main entry point for all contract method calls.
     * Routes method selectors to appropriate handler functions.
     * @param method - The encoded method selector
     * @param calldata - The method parameters
     * @returns Encoded response data
     */
    public override execute(method: Selector, calldata: Calldata): BytesWriter {
        // V2.5 compatible methods
        if (method == encodeSelector('createVesting(address,address,uint256,uint256,uint256)')) {
            return this.createVesting(calldata);
        }

        if (method == encodeSelector('claim(uint256)')) {
            return this.claim(calldata);
        }

        if (method == encodeSelector('getVestingInfo(uint256)')) {
            return this.getVestingInfo(calldata);
        }

        if (method == encodeSelector('getClaimableAmount(uint256)')) {
            return this.getClaimableAmount(calldata);
        }

        if (method == encodeSelector('getNextVestingId()')) {
            return this.getNextVestingId();
        }

        // V2.5 batch (backward compatible)
        if (method == encodeSelector('createVestingBatch(address,uint256,uint256,uint256,bytes)')) {
            return this.createVestingBatch(calldata);
        }

        // V3 optimized methods
        // Uniform batch: same amount for all beneficiaries (most efficient)
        // Signature: createVestingBatchUniform(address token, uint64 amount, uint64 cliffBlocks, uint64 vestingBlocks, uint16 count, bytes addresses)
        if (method == encodeSelector('createVestingBatchUniform(address,uint64,uint64,uint64,uint16,bytes)')) {
            return this.createVestingBatchUniform(calldata);
        }

        // Compact batch: variable amounts but using u64 instead of u256
        // Signature: createVestingBatchCompact(address token, uint64 cliffBlocks, uint64 vestingBlocks, uint16 count, bytes data)
        if (method == encodeSelector('createVestingBatchCompact(address,uint64,uint64,uint16,bytes)')) {
            return this.createVestingBatchCompact(calldata);
        }

        return super.execute(method, calldata);
    }

    /**
     * Create a single vesting schedule (V2.5 compatible).
     * Charges 0.5% dev fee, deducted from the amount.
     * Stores vesting data and transfers tokens using CEI pattern.
     * @param calldata - Encoded parameters: (token, beneficiary, amount, cliffBlocks, vestingBlocks)
     * @returns Encoded vestingId of the newly created vesting
     * @throws Revert on validation failures or transfer failures
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

        const feeAmount = this._calculateFee(amount);
        const netAmount = SafeMath.sub(amount, feeAmount);

        if (netAmount == u256.Zero) {
            throw new Revert('Net amount after fee is zero');
        }

        const currentBlock = u256.fromU64(Blockchain.block.number);
        const cliffEndBlock = SafeMath.add(currentBlock, cliffBlocks);
        const vestingEndBlock = SafeMath.add(cliffEndBlock, vestingBlocks);

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

        const response = new BytesWriter(32);
        response.writeU256(vestingId);
        return response;
    }

    /**
     * Create batch vestings (V2.5 compatible - u256 amounts).
     * Fee accounting: computes each individual fee using floor division,
     * then sums them. Ensures sum(netAmounts) + sum(fees) == sum(grossAmounts).
     * The contract receives exactly the sum of net amounts, dev receives sum of fees.
     * @param calldata - Encoded parameters: (token, cliffBlocks, vestingBlocks, count, beneficiaryData)
     *                   beneficiaryData contains count pairs of (address, u256 amount)
     * @returns Encoded firstVestingId (IDs are sequential from firstVestingId to firstVestingId + count - 1)
     * @throws Revert on validation failures, batch size limits, or transfer failures
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

            // Calculate fee per beneficiary (rounding-safe)
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
     * V4 OPTIMIZED: Create batch vestings with UNIFORM amount.
     * Most efficient when all beneficiaries receive the same amount.
     * Gas savings: ~50% calldata reduction vs V2.5 (1626 bytes vs 3200 bytes for 50 beneficiaries).
     * Fee is calculated once and multiplied by beneficiary count for accuracy.
     * @param calldata - Encoded parameters:
     *                   - token: Token address (32 bytes)
     *                   - amount: Amount per beneficiary (8 bytes u64)
     *                   - cliffBlocks: Cliff duration (8 bytes u64)
     *                   - vestingBlocks: Vesting duration (8 bytes u64)
     *                   - count: Number of beneficiaries (2 bytes u16)
     *                   - addresses: Packed beneficiary addresses (count × 32 bytes)
     * @returns Encoded firstVestingId (sequential IDs)
     * @throws Revert if amount exceeds u64 max, batch too large, or validation failures
     */
    private createVestingBatchUniform(calldata: Calldata): BytesWriter {
        const tokenAddr = calldata.readAddress();
        const amount = calldata.readU64();
        const cliffBlocksU64 = calldata.readU64();
        const vestingBlocksU64 = calldata.readU64();
        const count = calldata.readU16();

        // Convert to u256 for internal calculations
        const amountU256 = u256.fromU64(amount);
        const cliffBlocks = u256.fromU64(cliffBlocksU64);
        const vestingBlocks = u256.fromU64(vestingBlocksU64);

        // Validate inputs
        this._validateAddress(tokenAddr, 'Token');
        if (amountU256 == u256.Zero) {
            throw new Revert('Amount must be greater than zero');
        }
        if (vestingBlocks == u256.Zero) {
            throw new Revert('Vesting duration must be greater than zero');
        }
        this._validateBlockDuration(cliffBlocks, vestingBlocks);
        if (count == 0) {
            throw new Revert('Batch must have at least one beneficiary');
        }
        if (count > MAX_BATCH_SIZE) {
            throw new Revert('Batch size exceeds maximum allowed');
        }

        const currentBlock = u256.fromU64(Blockchain.block.number);
        const cliffEndBlock = SafeMath.add(currentBlock, cliffBlocks);
        const vestingEndBlock = SafeMath.add(cliffEndBlock, vestingBlocks);

        // Read and validate all beneficiary addresses
        const beneficiaries: Address[] = [];
        for (let i: u16 = 0; i < count; i++) {
            const beneficiary = calldata.readAddress();
            this._validateAddress(beneficiary, 'Beneficiary');
            beneficiaries.push(beneficiary);
        }

        // Calculate fees (uniform: compute once, multiply by count)
        const feePerBeneficiary = this._calculateFee(amountU256);
        const netAmountPerBeneficiary = SafeMath.sub(amountU256, feePerBeneficiary);

        if (netAmountPerBeneficiary == u256.Zero) {
            throw new Revert('Net amount after fee is zero');
        }

        const countU256 = u256.fromU32(count as u32);
        const totalNetAmount = SafeMath.mul(netAmountPerBeneficiary, countU256);
        const totalFeeAmount = SafeMath.mul(feePerBeneficiary, countU256);

        const firstVestingId = this.nextVestingId.value;

        // Pre-calculate constants
        const creatorU256 = this._addressToU256(Blockchain.tx.sender);
        const tokenU256 = this._addressToU256(tokenAddr);
        const zeroU256 = u256.Zero;

        // Store all vestings (CEI: effects before interactions)
        for (let i: u16 = 0; i < count; i++) {
            const vestingId = SafeMath.add(firstVestingId, u256.fromU32(i as u32));

            this.vestingToken.set(vestingId, tokenU256);
            this.vestingBeneficiary.set(vestingId, this._addressToU256(beneficiaries[i]));
            this.vestingCreator.set(vestingId, creatorU256);
            this.vestingTotal.set(vestingId, netAmountPerBeneficiary);
            this.vestingReleased.set(vestingId, zeroU256);
            this.vestingStart.set(vestingId, currentBlock);
            this.vestingCliff.set(vestingId, cliffEndBlock);
            this.vestingEnd.set(vestingId, vestingEndBlock);
        }

        this.nextVestingId.value = SafeMath.add(firstVestingId, countU256);

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
     * V4 OPTIMIZED: Create batch vestings with COMPACT variable amounts.
     * Uses u64 for amounts instead of u256 (sufficient for most tokens with 18 decimals).
     * Gas savings: ~37% calldata reduction vs V2.5 (2018 bytes vs 3200 bytes for 50 beneficiaries).
     * Each beneficiary can have a different amount (unlike Uniform).
     * Fee is calculated per-beneficiary using floor division for rounding safety.
     * @param calldata - Encoded parameters:
     *                   - token: Token address (32 bytes)
     *                   - cliffBlocks: Cliff duration (8 bytes u64)
     *                   - vestingBlocks: Vesting duration (8 bytes u64)
     *                   - count: Number of beneficiaries (2 bytes u16)
     *                   - data: Packed data (for each: 32 bytes address + 8 bytes u64 amount)
     * @returns Encoded firstVestingId (sequential IDs)
     * @throws Revert if any amount exceeds u64 max, batch too large, or validation failures
     */
    private createVestingBatchCompact(calldata: Calldata): BytesWriter {
        const tokenAddr = calldata.readAddress();
        const cliffBlocksU64 = calldata.readU64();
        const vestingBlocksU64 = calldata.readU64();
        const count = calldata.readU16();

        const cliffBlocks = u256.fromU64(cliffBlocksU64);
        const vestingBlocks = u256.fromU64(vestingBlocksU64);

        // Validate inputs
        this._validateAddress(tokenAddr, 'Token');
        if (vestingBlocks == u256.Zero) {
            throw new Revert('Vesting duration must be greater than zero');
        }
        this._validateBlockDuration(cliffBlocks, vestingBlocks);
        if (count == 0) {
            throw new Revert('Batch must have at least one beneficiary');
        }
        if (count > MAX_BATCH_SIZE) {
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

        for (let i: u16 = 0; i < count; i++) {
            const beneficiary = calldata.readAddress();
            const amountU64 = calldata.readU64();
            const amount = u256.fromU64(amountU64);

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

        // Pre-calculate constants
        const creatorU256 = this._addressToU256(Blockchain.tx.sender);
        const tokenU256 = this._addressToU256(tokenAddr);
        const zeroU256 = u256.Zero;

        // Store all vestings (CEI: effects before interactions)
        for (let i: u16 = 0; i < count; i++) {
            const vestingId = SafeMath.add(firstVestingId, u256.fromU32(i as u32));

            this.vestingToken.set(vestingId, tokenU256);
            this.vestingBeneficiary.set(vestingId, this._addressToU256(beneficiaries[i]));
            this.vestingCreator.set(vestingId, creatorU256);
            this.vestingTotal.set(vestingId, netAmounts[i]);
            this.vestingReleased.set(vestingId, zeroU256);
            this.vestingStart.set(vestingId, currentBlock);
            this.vestingCliff.set(vestingId, cliffEndBlock);
            this.vestingEnd.set(vestingId, vestingEndBlock);
        }

        this.nextVestingId.value = SafeMath.add(firstVestingId, u256.fromU32(count as u32));

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
     * Claim vested tokens from a vesting schedule.
     * The beneficiary is stored as the tweaked public key (from taproot address).
     * Verification: Compares Blockchain.tx.origin.tweakedPublicKey with stored beneficiary.
     * Transfer: Tokens sent to caller's ML-DSA address (Blockchain.tx.sender).
     * Uses CEI pattern: updates released amount before transfer.
     * @param calldata - Encoded vestingId (u256)
     * @returns Encoded amount released (u256)
     * @throws Revert if vesting doesn't exist, caller is not beneficiary, or no tokens claimable
     */
    private claim(calldata: Calldata): BytesWriter {
        const vestingId = calldata.readU256();

        // Verify vesting exists by checking total amount
        const totalAmount = this.vestingTotal.get(vestingId);
        if (totalAmount == u256.Zero) {
            throw new Revert('Vesting does not exist');
        }

        // Verify caller is the beneficiary via tweaked public key
        const beneficiaryU256 = this.vestingBeneficiary.get(vestingId);
        const origin = Blockchain.tx.origin;
        const callerTweakedKey = origin.tweakedPublicKey;
        const callerTweakedU256 = u256.fromUint8ArrayBE(callerTweakedKey);

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

        // Get token address and transfer
        const tokenU256 = this.vestingToken.get(vestingId);
        const tokenAddr = this._u256ToAddress(tokenU256);

        TransferHelper.transfer(tokenAddr, Blockchain.tx.sender, claimable);

        const response = new BytesWriter(32);
        response.writeU256(claimable);
        return response;
    }

    /**
     * Calculate the claimable amount for a vesting schedule at the current block.
     * Linear vesting formula: vested = (total × elapsed) / duration
     * Returns 0 before cliff, full remaining amount after end block.
     * @param vestingId - The vesting schedule ID
     * @returns The amount currently claimable (vested - already released)
     */
    private _calculateClaimable(vestingId: u256): u256 {
        const currentBlock = u256.fromU64(Blockchain.block.number);
        const cliffEnd = this.vestingCliff.get(vestingId);

        if (currentBlock < cliffEnd) {
            return u256.Zero;
        }

        const total = this.vestingTotal.get(vestingId);
        const released = this.vestingReleased.get(vestingId);
        const end = this.vestingEnd.get(vestingId);

        if (currentBlock >= end) {
            return SafeMath.sub(total, released);
        }

        const elapsed = SafeMath.sub(currentBlock, cliffEnd);
        const duration = SafeMath.sub(end, cliffEnd);
        const vested = SafeMath.div(SafeMath.mul(total, elapsed), duration);

        return SafeMath.sub(vested, released);
    }

    /**
     * View function to get the claimable amount for a vesting schedule.
     * Does not modify state, safe to call externally.
     * @param calldata - Encoded vestingId (u256)
     * @returns Encoded claimable amount (u256)
     */
    private getClaimableAmount(calldata: Calldata): BytesWriter {
        const vestingId = calldata.readU256();
        const claimable = this._calculateClaimable(vestingId);

        const response = new BytesWriter(32);
        response.writeU256(claimable);
        return response;
    }

    /**
     * View function to retrieve all vesting schedule data.
     * Returns 8 values: token, beneficiary, creator, total, released, start, cliff, end.
     * @param calldata - Encoded vestingId (u256)
     * @returns Encoded vesting info (8 × u256 values)
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
     * View function to get the next vesting ID that will be assigned.
     * Useful for frontends to predict vesting IDs before batch creation.
     * @returns Encoded next vesting ID (u256)
     */
    private getNextVestingId(): BytesWriter {
        const response = new BytesWriter(32);
        response.writeU256(this.nextVestingId.value);
        return response;
    }
}
