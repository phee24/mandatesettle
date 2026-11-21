// Buyer (payer) agent.
//   node src/buyer.mjs pay --escrow <addr> --conditions conditions.json [--sign-only]
// Flow (HSP mandate model):
//   1. Read the seller agent's signed conditions.
//   2. Enforce local spend policy (per-tx cap + per-day cap, BUYER_MAX_PER_TX /
//      BUYER_MAX_PER_DAY in human units; daily spend tracked in a ledger file).
//   3. Build the EIP-712 PaymentMandate and sign it with the payer wallet.
//   4. Approve the escrow contract and relay createMandate (funds escrowed).
// The payer key defaults to the project wallet (hidden/wallet.json); override
// with BUYER_PRIVATE_KEY. Keys are never printed.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWalletClient, http, formatUnits } from 'viem';
import { accountFromEnv, loadProjectWalletAccount, networkFromEnv, explorerTx } from './chain.mjs';
import { HspGateway, MANDATE_TYPES, mandateDomain, ERC20_ABI } from './hsp.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const LEDGER = join(dirname(fileURLToPath(import.meta.url)), '..', '.buyer-ledger.json');

function checkPolicy(amountRaw, decimals) {
  const human = Number(formatUnits(amountRaw, decimals));
  const maxTx = Number(process.env.BUYER_MAX_PER_TX ?? '50');
  const maxDay = Number(process.env.BUYER_MAX_PER_DAY ?? '200');
  if (human > maxTx) throw new Error(`Policy: ${human} exceeds per-tx cap ${maxTx}`);
  const today = new Date().toISOString().slice(0, 10);
  const ledger = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : {};
  const spent = ledger[today] ?? 0;
  if (spent + human > maxDay) throw new Error(`Policy: daily cap ${maxDay} would be exceeded (${spent} + ${human})`);
  ledger[today] = spent + human;
  writeFileSync(LEDGER, JSON.stringify(ledger, null, 2));
  return human;
}

const { chain, rpcUrl } = networkFromEnv();
const escrow = arg('escrow');
const conditionsFile = arg('conditions', 'conditions.json');
if (!escrow) throw new Error('pay requires --escrow');
const conditions = JSON.parse(readFileSync(conditionsFile, 'utf8'));

const payer = process.env.BUYER_PRIVATE_KEY ? accountFromEnv('BUYER_PRIVATE_KEY') : loadProjectWalletAccount();
const gateway = new HspGateway({ chain, rpcUrl, escrowAddress: escrow });

const decimals = Number(process.env.TOKEN_DECIMALS ?? '6');
const amount = BigInt(conditions.amount);
checkPolicy(amount, decimals);

const mandate = {
  payer: payer.address,
  payee: conditions.payee,
  token: conditions.token,
  amount,
  taskHash: conditions.taskHash,
  expiry: BigInt(conditions.expiry),
  nonce: BigInt(conditions.nonce),
};

const wallet = createWalletClient({ account: payer, chain, transport: http(rpcUrl) });
const signature = await wallet.signTypedData({
  domain: mandateDomain(chain.id, escrow),
  types: MANDATE_TYPES,
  primaryType: 'PaymentMandate',
  message: mandate,
});

if (!(await gateway.verifyMandate(mandate, signature))) throw new Error('Local signature verification failed');
const mandateHash = await gateway.hashMandate(mandate);
console.log(`Mandate signed by payer agent ${payer.address}`);
console.log(`  mandateHash: ${mandateHash}`);
console.log(`  amount: ${formatUnits(amount, decimals)} -> payee ${mandate.payee}, expires ${new Date(Number(mandate.expiry) * 1000).toISOString()}`);

if (process.argv.includes('--sign-only')) {
  const out = arg('out', 'mandate.json');
  writeFileSync(out, JSON.stringify({ mandate: { ...mandate, amount: amount.toString(), expiry: mandate.expiry.toString(), nonce: mandate.nonce.toString() }, signature, mandateHash }, null, 2));
  console.log(`  sign-only mode: written ${out} (relay with settle.mjs or any submitter)`);
  process.exit(0);
}

// Approve + fund the escrow (self-relay; any relayer could submit instead).
const approveHash = await wallet.writeContract({ address: mandate.token, abi: ERC20_ABI, functionName: 'approve', args: [escrow, amount] });
await gateway.publicClient.waitForTransactionReceipt({ hash: approveHash });
const { hash } = await gateway.createMandate(payer, mandate, signature);
console.log(`  escrow funded, tx: ${explorerTx(chain, hash)}`);
console.log(`  mandate is now Funded — awaiting seller delivery.`);
