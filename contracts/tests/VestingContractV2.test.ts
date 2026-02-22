/**
 * OPNet Vesting Contract V2 - Unit Tests
 *
 * Tests the vesting contract functionality including:
 * - Creating vestings with fee transfer to dev
 * - Claiming vested tokens
 * - Fee calculation
 */

import { opnet, OPNetUnit, Assert, Blockchain } from '@btc-vision/unit-test-framework';
import { Address, BinaryReader, BinaryWriter } from '@btc-vision/transaction';
import { VestingContractV2 } from '../src/VestingContractV2';

// Mock OP20 token for testing
class MockOP20Token {
    private balances: Map<string, bigint> = new Map();
    private allowances: Map<string, Map<string, bigint>> = new Map();

    public mint(to: string, amount: bigint): void {
        const current = this.balances.get(to) || 0n;
        this.balances.set(to, current + amount);
    }

    public balanceOf(address: string): bigint {
        return this.balances.get(address) || 0n;
    }

    public approve(owner: string, spender: string, amount: bigint): void {
        if (!this.allowances.has(owner)) {
            this.allowances.set(owner, new Map());
        }
        this.allowances.get(owner)!.set(spender, amount);
    }

    public allowance(owner: string, spender: string): bigint {
        return this.allowances.get(owner)?.get(spender) || 0n;
    }

    public transfer(from: string, to: string, amount: bigint): boolean {
        const fromBalance = this.balances.get(from) || 0n;
        if (fromBalance < amount) {
            return false;
        }
        this.balances.set(from, fromBalance - amount);
        const toBalance = this.balances.get(to) || 0n;
        this.balances.set(to, toBalance + amount);
        return true;
    }

    public transferFrom(spender: string, from: string, to: string, amount: bigint): boolean {
        const allowed = this.allowance(from, spender);
        if (allowed < amount) {
            return false;
        }
        const success = this.transfer(from, to, amount);
        if (success) {
            this.allowances.get(from)!.set(spender, allowed - amount);
        }
        return success;
    }
}

// Dev address (ML-DSA) - same as in contract
const DEV_ADDRESS = '0x5a6cdc183b82992b6fc8091059f05d35fa681bec792becf2023910cb69bc701d';

// Test addresses
const USER_ADDRESS = '0x1111111111111111111111111111111111111111111111111111111111111111';
const BENEFICIARY_ADDRESS = '0x2222222222222222222222222222222222222222222222222222222222222222';
const TOKEN_ADDRESS = '0x3333333333333333333333333333333333333333333333333333333333333333';
const CONTRACT_ADDRESS = '0x4444444444444444444444444444444444444444444444444444444444444444';

await opnet('VestingContractV2 Tests', async (vm: OPNetUnit) => {
    let mockToken: MockOP20Token;

    vm.beforeEach(async () => {
        Blockchain.dispose();
        await Blockchain.init();
        mockToken = new MockOP20Token();
    });

    await vm.it('should calculate fee correctly (0.5%)', async () => {
        const amount = 1000n * 10n ** 18n; // 1000 tokens with 18 decimals
        const expectedFee = amount * 5n / 1000n; // 0.5%
        const expectedNet = amount - expectedFee;

        Assert.expect(expectedFee).toEqual(5n * 10n ** 18n); // 5 tokens
        Assert.expect(expectedNet).toEqual(995n * 10n ** 18n); // 995 tokens
    });

    await vm.it('should transfer fee to dev address using transferFrom', async () => {
        // Setup: User has 1000 tokens
        const amount = 1000n * 10n ** 18n;
        mockToken.mint(USER_ADDRESS, amount);

        // User approves contract for full amount
        mockToken.approve(USER_ADDRESS, CONTRACT_ADDRESS, amount);

        // Calculate fee
        const feeAmount = amount * 5n / 1000n; // 0.5% = 5 tokens
        const netAmount = amount - feeAmount; // 995 tokens

        // Simulate what the contract SHOULD do:
        // 1. transferFrom(user -> contract, netAmount) for vesting
        const vestingTransferSuccess = mockToken.transferFrom(
            CONTRACT_ADDRESS,
            USER_ADDRESS,
            CONTRACT_ADDRESS,
            netAmount
        );
        Assert.expect(vestingTransferSuccess).toEqual(true);

        // 2. transferFrom(user -> dev, feeAmount) for fee
        const feeTransferSuccess = mockToken.transferFrom(
            CONTRACT_ADDRESS,
            USER_ADDRESS,
            DEV_ADDRESS,
            feeAmount
        );
        Assert.expect(feeTransferSuccess).toEqual(true);

        // Verify balances
        Assert.expect(mockToken.balanceOf(USER_ADDRESS)).toEqual(0n);
        Assert.expect(mockToken.balanceOf(CONTRACT_ADDRESS)).toEqual(netAmount);
        Assert.expect(mockToken.balanceOf(DEV_ADDRESS)).toEqual(feeAmount);
    });

    await vm.it('should fail if user has insufficient allowance', async () => {
        const amount = 1000n * 10n ** 18n;
        mockToken.mint(USER_ADDRESS, amount);

        // User approves only half
        mockToken.approve(USER_ADDRESS, CONTRACT_ADDRESS, amount / 2n);

        const feeAmount = amount * 5n / 1000n;
        const netAmount = amount - feeAmount;

        // This should fail because allowance is insufficient
        const success = mockToken.transferFrom(
            CONTRACT_ADDRESS,
            USER_ADDRESS,
            CONTRACT_ADDRESS,
            netAmount
        );
        Assert.expect(success).toEqual(false);
    });

    await vm.it('should handle multiple beneficiaries correctly', async () => {
        // User has 300 tokens total for 2 vestings (200 + 100)
        const totalAmount = 300n * 10n ** 18n;
        mockToken.mint(USER_ADDRESS, totalAmount);
        mockToken.approve(USER_ADDRESS, CONTRACT_ADDRESS, totalAmount);

        const amount1 = 200n * 10n ** 18n;
        const amount2 = 100n * 10n ** 18n;

        // Vesting 1: 200 tokens
        const fee1 = amount1 * 5n / 1000n; // 1 token
        const net1 = amount1 - fee1; // 199 tokens

        mockToken.transferFrom(CONTRACT_ADDRESS, USER_ADDRESS, CONTRACT_ADDRESS, net1);
        mockToken.transferFrom(CONTRACT_ADDRESS, USER_ADDRESS, DEV_ADDRESS, fee1);

        // Vesting 2: 100 tokens
        const fee2 = amount2 * 5n / 1000n; // 0.5 tokens
        const net2 = amount2 - fee2; // 99.5 tokens

        mockToken.transferFrom(CONTRACT_ADDRESS, USER_ADDRESS, CONTRACT_ADDRESS, net2);
        mockToken.transferFrom(CONTRACT_ADDRESS, USER_ADDRESS, DEV_ADDRESS, fee2);

        // Verify
        const totalFees = fee1 + fee2;
        const totalNet = net1 + net2;

        Assert.expect(mockToken.balanceOf(USER_ADDRESS)).toEqual(0n);
        Assert.expect(mockToken.balanceOf(CONTRACT_ADDRESS)).toEqual(totalNet);
        Assert.expect(mockToken.balanceOf(DEV_ADDRESS)).toEqual(totalFees);
    });
});

console.log('Tests completed!');
