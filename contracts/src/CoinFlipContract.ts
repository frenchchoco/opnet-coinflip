/**
 * OPNet Coin Flip Contract
 * A simple on-chain coin flip game using Bitcoin block data as entropy.
 *
 * Methods:
 * - flip(uint256) — Place a bet (0 = heads, 1 = tails). Result from block number parity.
 * - getStats(address) — Read total flips and wins for an address.
 * - getTotalFlips() — Read total flips across all players.
 * - getLastResult() — Read current block number and its parity.
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

// Storage pointers
const TOTAL_FLIPS_POINTER: u16 = Blockchain.nextPointer;
const TOTAL_HEADS_POINTER: u16 = Blockchain.nextPointer;
const TOTAL_TAILS_POINTER: u16 = Blockchain.nextPointer;
const PLAYER_FLIPS_POINTER: u16 = Blockchain.nextPointer;
const PLAYER_WINS_POINTER: u16 = Blockchain.nextPointer;

@final
export class CoinFlipContract extends OP_NET {
    private readonly totalFlips: StoredU256;
    private readonly totalHeads: StoredU256;
    private readonly totalTails: StoredU256;
    private readonly playerFlips: StoredMapU256;
    private readonly playerWins: StoredMapU256;

    constructor() {
        super();
        this.totalFlips = new StoredU256(TOTAL_FLIPS_POINTER, new Uint8Array(0));
        this.totalHeads = new StoredU256(TOTAL_HEADS_POINTER, new Uint8Array(0));
        this.totalTails = new StoredU256(TOTAL_TAILS_POINTER, new Uint8Array(0));
        this.playerFlips = new StoredMapU256(PLAYER_FLIPS_POINTER);
        this.playerWins = new StoredMapU256(PLAYER_WINS_POINTER);
    }

    public override execute(method: Selector, calldata: Calldata): BytesWriter {
        if (method == encodeSelector('flip(uint256)')) {
            return this.flip(calldata);
        }
        if (method == encodeSelector('getStats(address)')) {
            return this.getStats(calldata);
        }
        if (method == encodeSelector('getTotalFlips()')) {
            return this.getTotalFlips();
        }
        if (method == encodeSelector('getLastResult()')) {
            return this.getLastResult();
        }
        return super.execute(method, calldata);
    }

    private flip(calldata: Calldata): BytesWriter {
        const caller: Address = Blockchain.tx.sender;


        const choice: u256 = calldata.readU256();
        if (choice > u256.One) {
            throw new Revert('Invalid choice: must be 0 (heads) or 1 (tails)');
        }

        // Determine result from block number: even = 0 (heads), odd = 1 (tails)
        const blockNumber: u256 = Blockchain.block.numberU256;
        // Check least significant bit: blockNumber & 1
        const lsb: u256 = new u256(blockNumber.lo1 & 1, 0, 0, 0);
        const result: u256 = lsb;

        const won: bool = choice == result;

        // Update global counters
        this.totalFlips.value = SafeMath.add(this.totalFlips.value, u256.One);
        if (result == u256.Zero) {
            this.totalHeads.value = SafeMath.add(this.totalHeads.value, u256.One);
        } else {
            this.totalTails.value = SafeMath.add(this.totalTails.value, u256.One);
        }

        // Update player stats
        const callerKey: u256 = u256.fromUint8ArrayBE(caller);
        const currentFlips: u256 = this.playerFlips.get(callerKey) || u256.Zero;
        this.playerFlips.set(callerKey, SafeMath.add(currentFlips, u256.One));

        if (won) {
            const currentWins: u256 = this.playerWins.get(callerKey) || u256.Zero;
            this.playerWins.set(callerKey, SafeMath.add(currentWins, u256.One));
        }

        const response = new BytesWriter(64);
        response.writeU256(result);
        response.writeBoolean(won);
        return response;
    }

    private getStats(calldata: Calldata): BytesWriter {
        const player: Address = calldata.readAddress();
        const playerKey: u256 = u256.fromUint8ArrayBE(player);
        const flips: u256 = this.playerFlips.get(playerKey) || u256.Zero;
        const wins: u256 = this.playerWins.get(playerKey) || u256.Zero;

        const response = new BytesWriter(64);
        response.writeU256(flips);
        response.writeU256(wins);
        return response;
    }

    private getTotalFlips(): BytesWriter {
        const response = new BytesWriter(96);
        response.writeU256(this.totalFlips.value);
        response.writeU256(this.totalHeads.value);
        response.writeU256(this.totalTails.value);
        return response;
    }

    private getLastResult(): BytesWriter {
        const blockNumber: u256 = Blockchain.block.numberU256;
        const lsb: u256 = new u256(blockNumber.lo1 & 1, 0, 0, 0);

        const response = new BytesWriter(64);
        response.writeU256(blockNumber);
        response.writeU256(lsb);
        return response;
    }
}
