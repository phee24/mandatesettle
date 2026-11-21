// Seller (recipient) agent.
//   node src/seller.mjs issue  --token <addr> --amount <humanUnits> --task "text" [--out conditions.json]
//   node src/seller.mjs deliver --escrow <addr> --mandate-hash <0x..> --deliverable "text"
// The seller publishes signed payment conditions (the HSP "conditions provided
// by recipient agent" step) and later submits the delivery proof on-chain.
import { writeFileSync } from 'node:fs';
import { createWalletClient, http, keccak256, toBytes, formatUnits } from 'viem';
import { accountFromEnv, networkFromEnv, explorerTx } from './chain.mjs';
import { HspGateway } from './hsp.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const { chain, rpcUrl } = networkFromEnv();
const seller = accountFromEnv('SELLER_PRIVATE_KEY');
const cmd = process.argv[2];

if (cmd === 'issue') {
  const token = arg('token');
  const amount = arg('amount');
  const task = arg('task', 'A2A task');
  const decimals = Number(arg('decimals', '6'));
  if (!token || !amount) throw new Error('issue requires --token and --amount');
  const amountRaw = BigInt(Math.round(Number(amount) * 10 ** decimals));
  const invoice = {
    payee: seller.address,
    token,
    amount: amountRaw.toString(),
    amountHuman: `${amount} (decimals ${decimals})`,
    task,
    taskHash: keccak256(toBytes(task)),
    expiry: Math.floor(Date.now() / 1000) + Number(arg('expiry-hours', '24')) * 3600,
    nonce: String(Date.now()),
  };
  const wallet = createWalletClient({ account: seller, chain, transport: http(rpcUrl) });
  invoice.sellerSignature = await wallet.signMessage({ message: JSON.stringify({ ...invoice, sellerSignature: undefined }) });
  const out = arg('out', 'conditions.json');
  writeFileSync(out, JSON.stringify(invoice, null, 2));
  console.log(`Conditions issued by seller agent ${seller.address}`);
  console.log(`  taskHash: ${invoice.taskHash}`);
  console.log(`  amount:   ${invoice.amountHuman} -> ${invoice.payee}`);
  console.log(`  written:  ${out}`);
} else if (cmd === 'deliver') {
  const escrow = arg('escrow');
  const mandateHash = arg('mandate-hash');
  const deliverable = arg('deliverable', 'deliverable');
  if (!escrow || !mandateHash) throw new Error('deliver requires --escrow and --mandate-hash');
  const gateway = new HspGateway({ chain, rpcUrl, escrowAddress: escrow });
  const deliverableHash = keccak256(toBytes(deliverable));
  const { hash } = await gateway.submitDelivery(seller, mandateHash, deliverableHash);
  console.log(`Delivery proof submitted by ${seller.address}`);
  console.log(`  deliverableHash: ${deliverableHash}`);
  console.log(`  tx: ${explorerTx(chain, hash)}`);
} else {
  console.log('Usage: seller.mjs issue|deliver ...');
  process.exit(1);
}
