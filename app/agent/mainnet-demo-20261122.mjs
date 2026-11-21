// Mainnet E2E demo driver — MandateSettle on HashKey Chain mainnet (177).
// Replicates the testnet CLI flow (seller issue -> buyer pay -> seller deliver
// -> confirmAndSettle) but with EXPLICIT fee caps on every transaction and a
// hard cumulative budget guard. The seller key is generated fresh, held only
// in /tmp (mode 600), and NEVER printed.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  toBytes,
  parseEventLogs,
  formatEther,
  formatUnits,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { loadProjectWalletAccount, NETWORKS } from './src/chain.mjs';
import { HspGateway, MANDATE_TYPES, mandateDomain, ERC20_ABI, loadArtifact } from './src/hsp.mjs';

const RPC = 'https://mainnet.hsk.xyz';
const chain = NETWORKS.mainnet;
const ESCROW = '0xdD1B64B493eEF154Bfd0369e892ec5062Da0fFE8';
const TOKEN = '0xF60f13515E7Aa621D8bee6ff3496fA1E6619bd09';
const MAX_FEE_PER_GAS = 600_000_000_000n; // 600 gwei hard cap (live base fee: 500 gwei)
const MAX_PRIORITY_FEE = 1_000_000_000n; // 1 gwei
const FEES = { maxFeePerGas: MAX_FEE_PER_GAS, maxPriorityFeePerGas: MAX_PRIORITY_FEE };
const BUDGET = 1_000_000_000_000_000_000n; // 1.0 HSK hard stop (all gas + funding value)
const L1_MARGIN = 500_000_000_000_000n; // 0.0005 HSK per-tx worst-case L1 margin for projections
const SELLER_FUNDING = 60_000_000_000_000_000n; // 0.06 HSK
const MINT_AMOUNT = 100_000_000n; // 100 tUSDC (6dp)
const MANDATE_AMOUNT = 25_000_000n; // 25 tUSDC
const TASK = 'invoice#mainnet-001: market brief for HSK Chain (mainnet demo)';
const DELIVERABLE = 'market brief delivered: HSK Chain mainnet demo (MandateSettle)';

const pub = createPublicClient({ chain, transport: http(RPC) });
const escrowAbi = loadArtifact('A2AEscrow').abi;
const tokenAbi = [...ERC20_ABI, { type: 'function', name: 'mint', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] }];

const progress = { steps: [] };
let spent = 0n;

function walletFor(account) {
  return createWalletClient({ account, chain, transport: http(RPC) });
}

async function rawReceipt(hash) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [hash] }),
  });
  const j = await res.json();
  return j.result;
}

function guardProjection(label, gasUnits, valueWei = 0n) {
  const worst = gasUnits * MAX_FEE_PER_GAS + L1_MARGIN + valueWei;
  if (spent + worst > BUDGET) {
    throw new Error(
      `BUDGET GUARD: ${label} projected worst-case ${formatEther(worst)} HSK would push cumulative ` +
        `${formatEther(spent)} + ${formatEther(worst)} over the 1.0 HSK cap — NOT broadcasting`,
    );
  }
  return worst;
}

async function send(label, account, txRequest, estimateFn) {
  const gasUnits = await estimateFn();
  guardProjection(label, gasUnits, txRequest.value ?? 0n);
  const w = walletFor(account);
  let txHash;
  if (txRequest.kind === 'transfer') {
    txHash = await w.sendTransaction({ to: txRequest.to, value: txRequest.value, ...FEES });
  } else {
    txHash = await w.writeContract({ address: txRequest.address, abi: txRequest.abi, functionName: txRequest.functionName, args: txRequest.args, ...FEES });
  }
  const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') throw new Error(`${label} REVERTED (tx ${txHash})`);
  const raw = await rawReceipt(txHash);
  const l1Fee = raw?.l1Fee ? BigInt(raw.l1Fee) : 0n;
  const execCost = receipt.gasUsed * receipt.effectiveGasPrice;
  const totalCost = execCost + l1Fee;
  spent += totalCost + (txRequest.value && txRequest.countValue ? txRequest.value : 0n);
  const rec = {
    label,
    hash: txHash,
    gasUsed: receipt.gasUsed.toString(),
    effectiveGasPrice: receipt.effectiveGasPrice.toString(),
    execCostHSK: formatEther(execCost),
    l1FeeHSK: formatEther(l1Fee),
    totalCostHSK: formatEther(totalCost),
  };
  progress.steps.push(rec);
  console.log(`OK ${label}: ${txHash} (gas ${receipt.gasUsed}, total ${formatEther(totalCost)} HSK)`);
  return { hash: txHash, receipt };
}

function tokenBalance(addr) {
  return pub.readContract({ address: TOKEN, abi: ERC20_ABI, functionName: 'balanceOf', args: [addr] });
}

try {
  // ---- Preflight -----------------------------------------------------------
  const block = await pub.getBlock();
  const baseFee = block.baseFeePerGas;
  console.log(`Preflight: block ${block.number}, baseFeePerGas ${baseFee} wei (${formatUnits(baseFee, 9)} gwei)`);
  if (baseFee > MAX_FEE_PER_GAS) throw new Error(`Base fee ${baseFee} exceeds fee cap ${MAX_FEE_PER_GAS} — STOP`);
  const payer = loadProjectWalletAccount();
  const startBalance = await pub.getBalance({ address: payer.address });
  console.log(`Payer (project wallet): ${payer.address}, balance ${formatEther(startBalance)} HSK`);
  progress.payer = payer.address;
  progress.startBalanceHSK = formatEther(startBalance);

  // ---- Seller throwaway ----------------------------------------------------
  const sellerKey = generatePrivateKey();
  const seller = privateKeyToAccount(sellerKey);
  writeFileSync('/tmp/hsk-mainnet-seller.json', JSON.stringify({ address: seller.address, private_key: sellerKey }), { mode: 0o600 });
  console.log(`Seller (throwaway): ${seller.address} — key in /tmp/hsk-mainnet-seller.json (mode 600, never printed)`);
  progress.seller = seller.address;

  // ---- 1. Fund seller ------------------------------------------------------
  await send('fund-seller', payer, { kind: 'transfer', to: seller.address, value: SELLER_FUNDING, countValue: true },
    () => pub.estimateGas({ account: payer.address, to: seller.address, value: SELLER_FUNDING }));

  // ---- 2. Mint 100 tUSDC to buyer (project wallet) -------------------------
  await send('mint-tusdc', payer, { address: TOKEN, abi: tokenAbi, functionName: 'mint', args: [payer.address, MINT_AMOUNT] },
    () => pub.estimateContractGas({ account: payer.address, address: TOKEN, abi: tokenAbi, functionName: 'mint', args: [payer.address, MINT_AMOUNT] }));
  const buyerTusdcAfterMint = await tokenBalance(payer.address);
  console.log(`Buyer tUSDC after mint: ${formatUnits(buyerTusdcAfterMint, 6)}`);

  // ---- 3. Seller issues conditions (off-chain signature, no gas) -----------
  const conditions = {
    payee: seller.address,
    token: TOKEN,
    amount: MANDATE_AMOUNT.toString(),
    task: TASK,
    taskHash: keccak256(toBytes(TASK)),
    expiry: Math.floor(Date.now() / 1000) + 24 * 3600,
    nonce: String(Date.now()),
  };
  const sellerWallet = walletFor(seller);
  conditions.sellerSignature = await sellerWallet.signMessage({ message: JSON.stringify({ ...conditions, sellerSignature: undefined }) });
  console.log(`Conditions issued: taskHash ${conditions.taskHash}, amount 25 tUSDC -> ${seller.address}`);

  // ---- 4. Buyer signs mandate (EIP-712, off-chain) -------------------------
  const mandate = {
    payer: payer.address,
    payee: conditions.payee,
    token: conditions.token,
    amount: MANDATE_AMOUNT,
    taskHash: conditions.taskHash,
    expiry: BigInt(conditions.expiry),
    nonce: BigInt(conditions.nonce),
  };
  const payerWallet = walletFor(payer);
  const signature = await payerWallet.signTypedData({
    domain: mandateDomain(chain.id, ESCROW),
    types: MANDATE_TYPES,
    primaryType: 'PaymentMandate',
    message: mandate,
  });
  const gateway = new HspGateway({ chain, rpcUrl: RPC, escrowAddress: ESCROW });
  if (!(await gateway.verifyMandate(mandate, signature))) throw new Error('Local mandate signature verification failed');
  const mandateHash = await gateway.hashMandate(mandate);
  console.log(`Mandate signed + verified. mandateHash: ${mandateHash}`);
  progress.mandateHash = mandateHash;

  // ---- 5. Approve escrow ---------------------------------------------------
  await send('approve', payer, { address: TOKEN, abi: ERC20_ABI, functionName: 'approve', args: [ESCROW, MANDATE_AMOUNT] },
    () => pub.estimateContractGas({ account: payer.address, address: TOKEN, abi: ERC20_ABI, functionName: 'approve', args: [ESCROW, MANDATE_AMOUNT] }));

  // ---- 6. createMandate (escrow funded) ------------------------------------
  await send('createMandate', payer, { address: ESCROW, abi: escrowAbi, functionName: 'createMandate', args: [mandate, signature] },
    () => pub.estimateContractGas({ account: payer.address, address: ESCROW, abi: escrowAbi, functionName: 'createMandate', args: [mandate, signature] }));
  const escrowBalFunded = await tokenBalance(ESCROW);
  console.log(`Escrow tUSDC while funded: ${formatUnits(escrowBalFunded, 6)}`);
  if (escrowBalFunded !== MANDATE_AMOUNT) throw new Error(`Escrow balance ${escrowBalFunded} != mandate amount`);

  // ---- 7. Seller submits delivery ------------------------------------------
  const deliverableHash = keccak256(toBytes(DELIVERABLE));
  await send('submitDelivery', seller, { address: ESCROW, abi: escrowAbi, functionName: 'submitDelivery', args: [mandateHash, deliverableHash] },
    () => pub.estimateContractGas({ account: seller.address, address: ESCROW, abi: escrowAbi, functionName: 'submitDelivery', args: [mandateHash, deliverableHash] }));
  progress.deliverableHash = deliverableHash;
  console.log(`Delivery submitted: deliverableHash ${deliverableHash}`);

  // ---- 8. confirmAndSettle (by payer) --------------------------------------
  const settleRes = await send('confirmAndSettle', payer, { address: ESCROW, abi: escrowAbi, functionName: 'confirmAndSettle', args: [mandateHash] },
    () => pub.estimateContractGas({ account: payer.address, address: ESCROW, abi: escrowAbi, functionName: 'confirmAndSettle', args: [mandateHash] }));

  // ---- 9. Independent verification via RPC reads ----------------------------
  const escrowBalFinal = await tokenBalance(ESCROW);
  const sellerTusdc = await tokenBalance(seller.address);
  const buyerTusdc = await tokenBalance(payer.address);
  const record = await gateway.getRecord(mandateHash);
  const statusNum = Number(record.status);
  const events = parseEventLogs({ abi: escrowAbi, logs: settleRes.receipt.logs });
  const evt = events.find((e) => e.eventName === 'SettlementExecuted');
  const evtOk = !!evt &&
    evt.args.payer.toLowerCase() === payer.address.toLowerCase() &&
    evt.args.payee.toLowerCase() === seller.address.toLowerCase() &&
    evt.args.token.toLowerCase() === TOKEN.toLowerCase() &&
    evt.args.amount === MANDATE_AMOUNT &&
    evt.args.deliverableHash.toLowerCase() === deliverableHash.toLowerCase();
  const endBalance = await pub.getBalance({ address: payer.address });
  const sellerEndBalance = await pub.getBalance({ address: seller.address });
  const verification = {
    escrowTusdcFinal: formatUnits(escrowBalFinal, 6),
    sellerTusdc: formatUnits(sellerTusdc, 6),
    buyerTusdc: formatUnits(buyerTusdc, 6),
    recordStatus: statusNum,
    recordStatusName: ['None', 'Funded', 'Delivered', 'Settled', 'Refunded'][statusNum],
    settlementEventFound: !!evt,
    settlementEventFieldsMatch: evtOk,
    eventArgs: evt ? { payer: evt.args.payer, payee: evt.args.payee, token: evt.args.token, amount: evt.args.amount.toString(), deliverableHash: evt.args.deliverableHash } : null,
  };
  console.log('Verification:', JSON.stringify(verification, null, 2));
  if (escrowBalFinal !== 0n) throw new Error('VERIFY FAIL: escrow not empty');
  if (sellerTusdc !== MANDATE_AMOUNT) throw new Error('VERIFY FAIL: seller tUSDC != 25');
  if (statusNum !== 3) throw new Error('VERIFY FAIL: record not Settled');
  if (!evtOk) throw new Error('VERIFY FAIL: SettlementExecuted event mismatch');

  // ---- Receipt JSON (same shape as settle.mjs) ------------------------------
  const receipt = {
    mandateHash,
    status: 'Settled',
    payer: payer.address,
    payee: seller.address,
    token: TOKEN,
    amount: MANDATE_AMOUNT.toString(),
    taskHash: conditions.taskHash,
    deliverableHash,
    expiry: new Date(Number(mandate.expiry) * 1000).toISOString(),
    txHash: settleRes.hash,
    explorerTx: `https://hsk.blockscout.com/tx/${settleRes.hash}`,
    blockNumber: settleRes.receipt.blockNumber.toString(),
    settlementEvent: verification.eventArgs,
    recordedAt: new Date().toISOString(),
  };
  const dir = join(dirname(fileURLToPath(import.meta.url)), 'receipts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mandateHash}.json`), JSON.stringify(receipt, null, 2));
  console.log(`Receipt written: receipts/${mandateHash}.json`);

  progress.verification = verification;
  progress.totalSpentHSK = formatEther(spent);
  progress.endBalanceHSK = formatEther(endBalance);
  progress.sellerEndBalanceHSK = formatEther(sellerEndBalance);
  progress.success = true;
  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify(progress, null, 2));
} catch (err) {
  progress.success = false;
  progress.error = err.message;
  progress.totalSpentHSK = formatEther(spent);
  console.error('\n=== FAILED — circuit breaker, no retry ===');
  console.error(JSON.stringify(progress, null, 2));
  console.error('Error:', err.message);
  process.exit(1);
}
