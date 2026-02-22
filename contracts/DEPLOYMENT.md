# Smart Contract Deployment Guide

This guide covers compiling and deploying the Vesting Contract to OP_NET.

## Prerequisites

- Node.js 18+
- AssemblyScript compiler
- OP_WALLET extension
- Bitcoin Core (for regtest testing)

## Contract Setup

### 1. Install Dependencies

```bash
cd contracts
npm init -y
npm install --save-dev assemblyscript @btc-vision/btc-runtime
```

### 2. Configure AssemblyScript

Create `asconfig.json`:

```json
{
  "targets": {
    "release": {
      "outFile": "build/VestingContract.wasm",
      "sourceMap": true,
      "optimizeLevel": 3,
      "shrinkLevel": 2,
      "converge": true,
      "noAssert": true
    },
    "debug": {
      "outFile": "build/debug.wasm",
      "sourceMap": true,
      "debug": true
    }
  },
  "options": {
    "bindings": "esm",
    "runtime": "stub"
  }
}
```

### 3. Update Developer Address

**CRITICAL**: Before compiling, edit `VestingContract.ts` and replace:

```typescript
private developerAddress: Address = Address.fromString('YOUR_BITCOIN_ADDRESS_HERE');
```

With your actual Bitcoin address that will receive the 1% developer fee.

### 4. Create Build Script

Add to `package.json`:

```json
{
  "name": "vesting-contract",
  "version": "1.0.0",
  "scripts": {
    "build": "asc VestingContract.ts --target release --exportRuntime",
    "build:debug": "asc VestingContract.ts --target debug"
  },
  "dependencies": {
    "@btc-vision/btc-runtime": "latest"
  },
  "devDependencies": {
    "assemblyscript": "^0.27.0"
  }
}
```

## Compilation

### Build Release Version

```bash
npm run build
```

This creates `build/VestingContract.wasm` optimized for deployment.

### Build Debug Version (Optional)

```bash
npm run build:debug
```

Includes debugging symbols for development.

## Deployment to Regtest

### 1. Start Bitcoin Regtest

```bash
# Start Bitcoin daemon
bitcoind -daemon

# Create wallet
bitcoin-cli -regtest createwallet "testwallet"

# Mine initial blocks
bitcoin-cli -regtest generatetoaddress 101 $(bitcoin-cli -regtest getnewaddress)
```

### 2. Configure OP_WALLET

1. Install OP_WALLET browser extension
2. Open extension settings
3. Select "Regtest" network
4. Connect to `localhost:18443`
5. Import or create a wallet

### 3. Deploy Contract via OP_WALLET

1. **Open OP_WALLET**
2. **Navigate to "Deploy Contract"**
3. **Upload** `build/VestingContract.wasm`
4. **Set deployment parameters**:
   - Gas limit: Auto (recommended)
   - Fee: 0.0025 BTC minimum
5. **Review and sign transaction**
6. **Send transaction**

### 4. Confirm Deployment

Mine a block to confirm:

```bash
bitcoin-cli -regtest generatetoaddress 1 $(bitcoin-cli -regtest getnewaddress)
```

### 5. Get Contract Address

- Check transaction in OP_WALLET
- Copy contract address
- Update `vesting-frontend/src/config/opnet.js`:

```javascript
export const VESTING_CONTRACT_ADDRESS = 'YOUR_CONTRACT_ADDRESS_HERE';
```

## Testing the Contract

### Using Bitcoin CLI

```bash
# Check contract deployment
bitcoin-cli -regtest getblock $(bitcoin-cli -regtest getblockhash 102)

# Monitor contract transactions
bitcoin-cli -regtest listtransactions "*" 10
```

### Using Frontend DApp

1. Start frontend: `cd ../vesting-frontend && npm start`
2. Connect OP_WALLET
3. Create a test vesting
4. Mine blocks to simulate time passing:

```bash
# Mine 144 blocks (≈1 day)
bitcoin-cli -regtest generatetoaddress 144 $(bitcoin-cli -regtest getnewaddress)
```

5. Try releasing vested tokens

### Direct Contract Calls (Advanced)

Using OP_NET SDK:

```javascript
const contract = new OpnetContract(VESTING_CONTRACT_ADDRESS);

// Get vesting info
const info = await contract.call('getVestingInfo', beneficiaryAddress);

// Get releasable amount
const releasable = await contract.call('getReleasableAmount', beneficiaryAddress);
```

## Deployment to Mainnet

### Pre-Deployment Checklist

- [ ] Contract thoroughly tested on regtest
- [ ] Developer address verified and secure
- [ ] Code audited (recommended for production)
- [ ] Sufficient BTC for deployment (≥0.0025 BTC)
- [ ] Backup of contract source code
- [ ] Frontend updated with correct network

### Deployment Steps

1. **Switch OP_WALLET to Mainnet**

2. **Ensure Sufficient Balance**
   - Minimum 0.0025 BTC for deployment
   - Extra for transaction fees

3. **Deploy Contract**
   - Upload `build/VestingContract.wasm`
   - Double-check all parameters
   - Sign and send transaction
   - **WAIT** for confirmation (don't mine manually!)

4. **Verify Deployment**
   - Check transaction on Bitcoin mainnet
   - Verify contract address in block explorer
   - Test with small amounts first

5. **Update Frontend Configuration**

```javascript
// src/config/opnet.js
export const CURRENT_NETWORK = 'mainnet';
export const VESTING_CONTRACT_ADDRESS = 'MAINNET_CONTRACT_ADDRESS';
export const DEVELOPER_ADDRESS = 'MAINNET_DEVELOPER_ADDRESS';
```

6. **Build and Deploy Frontend**

```bash
cd ../vesting-frontend
npm run build
# Deploy to hosting service
```

## Contract Methods

### createVesting

Creates a new vesting schedule.

**Parameters:**
- `tokenAddress` (Address): OP_20 token to vest
- `amount` (u256): Total amount to vest
- `cliffBlocks` (u256): Blocks before vesting starts
- `vestingBlocks` (u256): Total vesting duration
- `beneficiaries` (Address[]): List of recipient addresses

**Returns:** Boolean success

### releaseTokens

Claims available vested tokens (called by beneficiary).

**Parameters:** None (uses tx.sender)

**Returns:** Amount released (u256)

### getVestingInfo

Query vesting schedule details.

**Parameters:**
- `beneficiary` (Address): Address to query

**Returns:**
- `exists` (bool)
- `tokenAddress` (Address)
- `totalAmount` (u256)
- `cliffEnd` (u256)
- `vestingEnd` (u256)
- `released` (u256)

### getReleasableAmount

Check how many tokens can currently be released.

**Parameters:**
- `beneficiary` (Address): Address to query

**Returns:** Releasable amount (u256)

## Security Considerations

### Before Mainnet Deployment

1. **Audit the Code**
   - Have contract reviewed by security experts
   - Test extensively on regtest
   - Verify all calculations

2. **Secure Developer Address**
   - Use a hardware wallet
   - Keep private keys offline
   - Test with small amounts first

3. **Test All Edge Cases**
   - Zero amounts
   - Multiple beneficiaries
   - Cliff period edge cases
   - Full vesting completion
   - Multiple release calls

### Known Limitations

- Cannot modify vesting schedule after creation
- Cannot cancel or revoke vesting
- Beneficiary can only have one active vesting at a time
- Developer fee is hardcoded at 0.5%

## Troubleshooting

### Compilation Errors

```bash
# Clear build cache
rm -rf build/

# Reinstall dependencies
rm -rf node_modules package-lock.json
npm install

# Rebuild
npm run build
```

### Deployment Fails

- Ensure sufficient BTC balance
- Check Bitcoin node is running (regtest)
- Verify OP_WALLET is on correct network
- Check gas limit and fees

### Contract Not Found

- Wait for block confirmation
- Check correct network in OP_WALLET
- Verify contract address is correct

## Advanced Topics

### Upgrading the Contract

OP_NET contracts are immutable. To upgrade:

1. Deploy new version with updated code
2. Migrate users to new contract
3. Update frontend with new address

### Monitoring Contract Usage

```bash
# Watch for contract transactions
bitcoin-cli -regtest listtransactions "*" 100 | grep CONTRACT_ADDRESS
```

### Gas Optimization

- Minimize storage operations
- Use efficient data structures
- Batch operations when possible
- Optimize loops and calculations

## Resources

- [OP_NET Documentation](https://docs.opnet.org)
- [AssemblyScript Docs](https://www.assemblyscript.org/introduction.html)
- [BTC Runtime API](https://github.com/btc-vision/btc-runtime)
- [Bitcoin Developer Guide](https://developer.bitcoin.org/devguide/)

---

**⚠️ Important**: Always test thoroughly on regtest before deploying to mainnet. Smart contracts are immutable once deployed.
