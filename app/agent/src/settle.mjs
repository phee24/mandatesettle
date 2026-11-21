// Settlement executor / receipt tool.
//   node src/settle.mjs status --escrow <addr> --mandate-hash <0x..>
//   node src/settle.mjs settle --escrow <addr> --mandate-hash <0x..> [--as payer]
//   node src/settle.mjs refund --escrow <addr> --mandate-hash <0x..>
// Settlement releases the escrow to the payee (payer confirmation, or
// permissionless after the challenge window) and writes a verifiable receipt
// JSON containing the SettlementExecuted event data + explorer links.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEventLogs } from 'viem';
import { accountFromEnv, loadProjectWalletAccount, networkFromEnv, explorerTx } from './chain.mjs';
import { HspGateway, STATUS, loadArtifact } from './hsp.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const { chain, rpcUrl } = networkFromEnv();
const escrow = arg('escrow');
const mandateHash = arg('mandate-hash');
const cmd = process.argv[2];
if (!escrow || !mandateHash) throw new Error('requires --escrow and --mandate-hash');
const gateway = new HspGateway({ chain, rpcUrl, escrowAddress: escrow });

const record = await gateway.getRecord(mandateHash);
const view = {
  mandateHash,
  status: STATUS[Number(record.status)],
  payer: record.mandate.payer,
  payee: record.mandate.payee,
  token: record.mandate.token,
  amount: record.mandate.amount.toString(),
  taskHash: record.mandate.taskHash,
  deliverableHash: record.deliverableHash,
  expiry: new Date(Number(record.mandate.expiry) * 1000).toISOString(),
};
console.log(JSON.stringify(view, null, 2));
if (cmd === 'status') process.exit(0);

const actor = process.env.RELAYER_PRIVATE_KEY
  ? accountFromEnv('RELAYER_PRIVATE_KEY')
  : loadProjectWalletAccount();

let result;
if (cmd === 'settle') {
  result =
    process.argv.includes('--as') && process.argv.includes('payer')
      ? await gateway.confirmAndSettle(actor, mandateHash)
      : await gateway.settleAfterWindow(actor, mandateHash);
} else if (cmd === 'refund') {
  result = await gateway.refund(mandateHash);
} else {
  console.log('Usage: settle.mjs status|settle|refund ...');
  process.exit(1);
}

const events = parseEventLogs({ abi: loadArtifact('A2AEscrow').abi, logs: result.receipt.logs });
const settled = events.find((e) => e.eventName === 'SettlementExecuted');
const receipt = {
  ...view,
  status: cmd === 'settle' ? 'Settled' : 'Refunded',
  txHash: result.hash,
  explorerTx: explorerTx(chain, result.hash),
  blockNumber: result.receipt.blockNumber.toString(),
  settlementEvent: settled
    ? {
        payer: settled.args.payer,
        payee: settled.args.payee,
        token: settled.args.token,
        amount: settled.args.amount.toString(),
        deliverableHash: settled.args.deliverableHash,
      }
    : null,
  recordedAt: new Date().toISOString(),
};
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'receipts');
mkdirSync(dir, { recursive: true });
const out = join(dir, `${mandateHash}.json`);
writeFileSync(out, JSON.stringify(receipt, null, 2));
console.log(`\nReceipt written: ${out}`);
console.log(`Verify on explorer: ${receipt.explorerTx}`);
