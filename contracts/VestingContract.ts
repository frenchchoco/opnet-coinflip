import {
    Address,
    Blockchain,
    BytesWriter,
    Calldata,
    OP20,
    encodeSelector,
    Map,
    Selector,
    u256,
} from '@btc-vision/btc-runtime/runtime';

/**
 * VestingSchedule stores all information about a beneficiary's vesting
 */
class VestingSchedule {
    constructor(
        public tokenAddress: Address,
        public totalAmount: u256,
        public cliffEnd: u256,
        public vestingEnd: u256,
        public released: u256
    ) {}
}

/**
 * OP_NET Vesting Contract
 * 
 * Features:
 * - Cliff period before any tokens are released
 * - Linear vesting over a specified duration
 * - Support for multiple beneficiaries
 * - 1% developer fee automatically deducted
 */
@final
export class VestingContract extends OP20 {
    // Developer address for 1% fee - UPDATE THIS
    private developerAddress: Address = Address.fromString('YOUR_BITCOIN_ADDRESS_HERE');
    
    // Storage for all vesting schedules
    // Maps beneficiary address to their vesting schedule
    private vestingSchedules: Map<Address, VestingSchedule>;
    
    // Total number of vesting schedules created
    private vestingCount: u256;

    public constructor() {
        super();
        this.vestingSchedules = new Map<Address, VestingSchedule>();
        this.vestingCount = u256.Zero;
    }

    /**
     * Called when contract is deployed
     */
    public override onDeployment(_calldata: Calldata): void {
        const name: string = 'Vesting Contract';
        const symbol: string = 'VEST';
        const decimals: u8 = 8;
        
        // Initialize OP20 token
        this._initialize(name, symbol, decimals);
        
        console.log('OP_NET Vesting Contract deployed');
    }

    /**
     * Route function calls to appropriate methods
     */
    public override execute(method: Selector, calldata: Calldata): BytesWriter {
        switch (method) {
            case encodeSelector('createVesting'):
                return this.createVesting(calldata);
            case encodeSelector('releaseTokens'):
                return this.releaseTokens(calldata);
            case encodeSelector('getVestingInfo'):
                return this.getVestingInfo(calldata);
            case encodeSelector('getReleasableAmount'):
                return this.getReleasableAmount(calldata);
            default:
                return super.execute(method, calldata);
        }
    }

    /**
     * Create a new vesting schedule
     * 
     * Parameters:
     * - tokenAddress: Address of the OP_20 token to vest
     * - amount: Total amount of tokens to vest
     * - cliffBlocks: Number of blocks before vesting starts
     * - vestingBlocks: Total duration of vesting in blocks
     * - beneficiaries: Array of addresses to receive vested tokens
     */
    private createVesting(calldata: Calldata): BytesWriter {
        // Read parameters
        const tokenAddress: Address = calldata.readAddress();
        const amount: u256 = calldata.readU256();
        const cliffBlocks: u256 = calldata.readU256();
        const vestingBlocks: u256 = calldata.readU256();
        const beneficiaryCount: u32 = calldata.readU32();
        
        // Validate inputs
        if (amount.isZero()) {
            throw new Error('Amount must be greater than zero');
        }
        if (vestingBlocks.isZero()) {
            throw new Error('Vesting duration must be greater than zero');
        }
        if (beneficiaryCount === 0) {
            throw new Error('Must have at least one beneficiary');
        }
        
        // Read beneficiary addresses
        const beneficiaries: Address[] = [];
        for (let i: u32 = 0; i < beneficiaryCount; i++) {
            beneficiaries.push(calldata.readAddress());
        }
        
        // Calculate developer fee (1%)
        const developerFee: u256 = amount.div(u256.fromU32(100));
        const amountAfterFee: u256 = amount.sub(developerFee);
        
        // Transfer developer fee
        this._transfer(Blockchain.tx.sender, this.developerAddress, developerFee);
        
        // Calculate amount per beneficiary
        const amountPerBeneficiary: u256 = amountAfterFee.div(u256.fromU64(beneficiaries.length));
        
        // Get current block
        const currentBlock: u256 = Blockchain.block.number;
        const cliffEndBlock: u256 = currentBlock.add(cliffBlocks);
        const vestingEndBlock: u256 = cliffEndBlock.add(vestingBlocks);
        
        // Create vesting schedule for each beneficiary
        for (let i: i32 = 0; i < beneficiaries.length; i++) {
            const beneficiary: Address = beneficiaries[i];
            
            // Check if beneficiary already has a vesting schedule
            if (this.vestingSchedules.has(beneficiary)) {
                throw new Error('Beneficiary already has active vesting');
            }
            
            // Create new vesting schedule
            const schedule: VestingSchedule = new VestingSchedule(
                tokenAddress,
                amountPerBeneficiary,
                cliffEndBlock,
                vestingEndBlock,
                u256.Zero
            );
            
            this.vestingSchedules.set(beneficiary, schedule);
        }
        
        // Lock the tokens (transfer to contract)
        this._transfer(Blockchain.tx.sender, Address.dead(), amountAfterFee);
        
        // Increment vesting count
        this.vestingCount = this.vestingCount.add(u256.One);
        
        // Return success
        const writer: BytesWriter = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    /**
     * Release vested tokens to the caller
     * Must be called by the beneficiary
     */
    private releaseTokens(calldata: Calldata): BytesWriter {
        const beneficiary: Address = Blockchain.tx.sender;
        
        // Get vesting schedule
        const schedule: VestingSchedule = this.vestingSchedules.get(beneficiary);
        if (!schedule) {
            throw new Error('No vesting schedule found for this address');
        }
        
        // Calculate releasable amount
        const currentBlock: u256 = Blockchain.block.number;
        const releasable: u256 = this.calculateReleasableAmount(schedule, currentBlock);
        
        if (releasable.isZero()) {
            throw new Error('No tokens available for release');
        }
        
        // Update released amount
        schedule.released = schedule.released.add(releasable);
        this.vestingSchedules.set(beneficiary, schedule);
        
        // Transfer tokens to beneficiary
        this._mint(beneficiary, releasable);
        
        // Return released amount
        const writer: BytesWriter = new BytesWriter();
        writer.writeU256(releasable);
        return writer;
    }

    /**
     * Calculate how many tokens can be released at current block
     */
    private calculateReleasableAmount(schedule: VestingSchedule, currentBlock: u256): u256 {
        // Before cliff, nothing is available
        if (currentBlock.lt(schedule.cliffEnd)) {
            return u256.Zero;
        }
        
        // After vesting end, all remaining tokens are available
        if (currentBlock.gte(schedule.vestingEnd)) {
            return schedule.totalAmount.sub(schedule.released);
        }
        
        // During vesting period: calculate linear release
        const vestingDuration: u256 = schedule.vestingEnd.sub(schedule.cliffEnd);
        const elapsedBlocks: u256 = currentBlock.sub(schedule.cliffEnd);
        
        // vestedAmount = totalAmount * (elapsedBlocks / vestingDuration)
        const vestedAmount: u256 = schedule.totalAmount
            .mul(elapsedBlocks)
            .div(vestingDuration);
        
        // Return vested minus already released
        return vestedAmount.sub(schedule.released);
    }

    /**
     * Get vesting information for an address
     */
    private getVestingInfo(calldata: Calldata): BytesWriter {
        const beneficiary: Address = calldata.readAddress();
        const schedule: VestingSchedule = this.vestingSchedules.get(beneficiary);
        
        const writer: BytesWriter = new BytesWriter();
        
        if (schedule) {
            writer.writeBoolean(true);
            writer.writeAddress(schedule.tokenAddress);
            writer.writeU256(schedule.totalAmount);
            writer.writeU256(schedule.cliffEnd);
            writer.writeU256(schedule.vestingEnd);
            writer.writeU256(schedule.released);
        } else {
            writer.writeBoolean(false);
        }
        
        return writer;
    }

    /**
     * Get how many tokens can currently be released for an address
     */
    private getReleasableAmount(calldata: Calldata): BytesWriter {
        const beneficiary: Address = calldata.readAddress();
        const schedule: VestingSchedule = this.vestingSchedules.get(beneficiary);
        
        const writer: BytesWriter = new BytesWriter();
        
        if (schedule) {
            const currentBlock: u256 = Blockchain.block.number;
            const releasable: u256 = this.calculateReleasableAmount(schedule, currentBlock);
            writer.writeU256(releasable);
        } else {
            writer.writeU256(u256.Zero);
        }
        
        return writer;
    }
}
