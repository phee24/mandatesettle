// End-to-end demo of the HSP-style A2A settlement flow on a local chain.
// Prereq: `anvil` running on http://127.0.0.1:8545 and contracts compiled
// (`forge build`). Run:  node src/demo.mjs
//
// Cast of agents (all local, keys are anvil's public dev key / throwaway):
//   deployer/relayer — anvil account #0 (public, well-known dev key)
//   buyer agent      — throwaway keypair, funded by the deployer
//   seller agent     — throwaway keypair, funded by the deployer
// Flow: seller issues conditions -> buyer policy-checks + signs EIP-712
// mandate -> relayer funds escrow -> seller delivers -> window lapses ->
// permissionless settlement -> verifiable receipt printed.
import { createPublicClient, createWalletClient, http, keccak256, toBytes, formatUnits } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { HspGateway, MANDATE_TYPES, mandateDomain, loadArtifact, ERC20_ABI } from './hsp.mjs';

const chain = {
  id: 31337,
  name: 'Anvil (local)',
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } },
};
const rpcUrl = chain.rpcUrls.default.http[0];
const pub = createPublicClient({ chain, transport: http(rpcUrl) });
const walletOf = (account) => createWalletClient({ account, chain, transport: http(rpcUrl) });

const deployer = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const buyer = privateKeyToAccount(generatePrivateKey());
const seller = privateKeyToAccount(generatePrivateKey());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (n, msg) => console.log(`\n[${n}] ${msg}`);

async function deploy(account, name, args) {
  const { abi, bytecode } = loadArtifact(name);
  const hash = await walletOf(account).deployContract({ abi, bytecode, args });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  return { address: receipt.contractAddress, abi };
}

step(0, 'Setup: deploy gateway + test stablecoin, fund the agents');
const escrowDeploy = await deploy(deployer, 'A2AEscrow', [5n]); // 5s challenge window for the demo
const tokenDeploy = await deploy(deployer, 'MockERC20', ['Test USD Coin', 'tUSDC', 6]);
const escrow = escrowDeploy.address;
const token = tokenDeploy.address;
console.log(`  A2AEscrow: ${escrow}\n  tUSDC:     ${token}`);
for (const a of [buyer, seller]) {
  const h = await walletOf(deployer).sendTransaction({ to: a.address, value: 10n ** 17n });
  await pub.waitForTransactionReceipt({ hash: h });
}
const MINT_ABI = [...ERC20_ABI, { type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ name: 't', type: 'address' }, { name: 'a', type: 'uint256' }], outputs: [] }];
const mh = await walletOf(deployer).writeContract({ address: token, abi: MINT_ABI, functionName: 'mint', args: [buyer.address, 1_000_000_000n] });
await pub.waitForTransactionReceipt({ hash: mh });
console.log(`  buyer ${buyer.address}\n  seller ${seller.address}`);

const gateway = new HspGateway({ chain, rpcUrl, escrowAddress: escrow });
const balance = (who) => pub.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [who] });

step(1, 'Seller agent publishes payment conditions (HSP: recipient conditions)');
const task = 'invoice#demo-001: generate a market brief for HSK Chain';
const conditions = {
  payee: seller.address,
  token,
  amount: 100_000_000n, // 100 tUSDC
  taskHash: keccak256(toBytes(task)),
  expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
  nonce: 1n,
};
console.log(`  task: ${task}\n  amount: ${formatUnits(conditions.amount, 6)} tUSDC -> ${conditions.payee}`);

step(2, 'Buyer agent verifies conditions, enforces spend caps, signs the EIP-712 mandate');
const CAP = 500_000_000n;
if (conditions.amount > CAP) throw new Error('policy: over per-tx cap');
const mandate = { payer: buyer.address, ...conditions };
const signature = await walletOf(buyer).signTypedData({
  domain: mandateDomain(chain.id, escrow),
  types: MANDATE_TYPES,
  primaryType: 'PaymentMandate',
  message: mandate,
});
console.log(`  signature valid off-chain: ${await gateway.verifyMandate(mandate, signature)}`);
const mandateHash = await gateway.hashMandate(mandate);
console.log(`  mandateHash: ${mandateHash}`);

step(3, 'Buyer approves; relayer submits the signed mandate — escrow funded (HSP gateway execution)');
const ah = await walletOf(buyer).writeContract({ address: token, abi: ERC20_ABI, functionName: 'approve', args: [escrow, mandate.amount] });
await pub.waitForTransactionReceipt({ hash: ah });
const created = await gateway.createMandate(deployer, mandate, signature);
console.log(`  createMandate tx: ${created.hash}`);
console.log(`  escrow balance: ${formatUnits(await balance(escrow), 6)} tUSDC | buyer: ${formatUnits(await balance(buyer.address), 6)} tUSDC`);

step(4, 'Seller agent does the work and submits the delivery proof');
const deliverableHash = keccak256(toBytes('market-brief-hsk-v1.pdf (sha256 placeholder)'));
const delivered = await gateway.submitDelivery(seller, mandateHash, deliverableHash);
console.log(`  submitDelivery tx: ${delivered.hash}\n  deliverableHash: ${deliverableHash}`);

step(5, 'Challenge window lapses; anyone settles — funds released to the seller agent');
// Anvil only advances block timestamps when blocks are mined: time-travel.
await pub.request({ method: 'evm_increaseTime', params: [10] });
await pub.request({ method: 'evm_mine', params: [] });
const settled = await gateway.settleAfterWindow(deployer, mandateHash);
console.log(`  settle tx: ${settled.hash}`);
const record = await gateway.getRecord(mandateHash);
console.log(`  final status: ${['None', 'Funded', 'Delivered', 'Settled', 'Refunded'][Number(record.status)]}`);
console.log(`  seller balance: ${formatUnits(await balance(seller.address), 6)} tUSDC | escrow: ${formatUnits(await balance(escrow), 6)} tUSDC`);
console.log('\nDEMO OK — settlement receipt is the SettlementExecuted event in the settle tx above.');
