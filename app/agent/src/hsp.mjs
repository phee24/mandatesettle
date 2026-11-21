// HspGateway — adapter between the agents and the settlement layer.
//
// The hackathon track requires the HSP (HashKey Settlement Protocol) flow:
//   recipient conditions -> payer-signed payment mandate -> verification ->
//   on-chain execution through a gateway -> auditable settlement receipt.
//
// This adapter ships in two modes; the agents above it do not change:
//
// 1. "self-hosted gateway" mode (class HspGateway, below): drives our
//    A2AEscrow contract, which implements mandate semantics on HashKey Chain
//    and additionally escrows funds until a delivery proof — an EXTENSION
//    for pay-on-delivery tasks, not HSP's own settlement flow.
// 2. "HSP-MCP" mode (class HspMcpGateway, bottom of this file): the official
//    agent-facing HSP rail — the HSP Agentic Payment MCP server
//    (mcp-qa.hashkeymerchant.com, no credentials needed). Settlement there is
//    a direct EIP-3009 transfer executed by the HSP gateway; the payer is
//    gasless. Schemas follow the public fixtures of the Mumbai-edition
//    winner (0xultravioleta/agentsettle-hsk), reviewed — not run — in
//    Phase 2b; see docs-notes.md §7.2 and §8.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  http,
  recoverTypedDataAddress,
  getAddress,
  isAddress,
  isHex,
  formatUnits,
} from 'viem';

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function loadArtifact(name) {
  const p = join(APP_ROOT, 'out', `${name}.sol`, `${name}.json`);
  const art = JSON.parse(readFileSync(p, 'utf8'));
  return { abi: art.abi, bytecode: art.bytecode.object };
}

export const MANDATE_TYPES = {
  PaymentMandate: [
    { name: 'payer', type: 'address' },
    { name: 'payee', type: 'address' },
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'taskHash', type: 'bytes32' },
    { name: 'expiry', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
  ],
};

export function mandateDomain(chainId, escrowAddress) {
  return { name: 'MandateSettle', version: '1', chainId, verifyingContract: escrowAddress };
}

export const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'a', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 't', type: 'address' }, { name: 'a', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
];

export class HspGateway {
  constructor({ chain, rpcUrl, escrowAddress }) {
    this.chain = chain;
    this.rpcUrl = rpcUrl;
    this.escrowAddress = escrowAddress;
    this.publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    this.escrowAbi = loadArtifact('A2AEscrow').abi;
  }

  wallet(account) {
    return createWalletClient({ account, chain: this.chain, transport: http(this.rpcUrl) });
  }

  read(fn, args) {
    return this.publicClient.readContract({ address: this.escrowAddress, abi: this.escrowAbi, functionName: fn, args });
  }

  async write(account, fn, args) {
    const wallet = this.wallet(account);
    const hash = await wallet.writeContract({
      address: this.escrowAddress,
      abi: this.escrowAbi,
      functionName: fn,
      args,
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`${fn} reverted (tx ${hash})`);
    return { hash, receipt };
  }

  /** Off-chain verification of a payer's EIP-712 mandate signature. */
  async verifyMandate(mandate, signature) {
    const signer = await recoverTypedDataAddress({
      domain: mandateDomain(this.chain.id, this.escrowAddress),
      types: MANDATE_TYPES,
      primaryType: 'PaymentMandate',
      message: mandate,
      signature,
    });
    return signer.toLowerCase() === mandate.payer.toLowerCase();
  }

  hashMandate(mandate) {
    return this.read('hashMandate', [mandate]);
  }

  createMandate(relayerAccount, mandate, signature) {
    return this.write(relayerAccount, 'createMandate', [mandate, signature]);
  }

  submitDelivery(payeeAccount, mandateHash, deliverableHash) {
    return this.write(payeeAccount, 'submitDelivery', [mandateHash, deliverableHash]);
  }

  confirmAndSettle(payerAccount, mandateHash) {
    return this.write(payerAccount, 'confirmAndSettle', [mandateHash]);
  }

  settleAfterWindow(anyAccount, mandateHash) {
    return this.write(anyAccount, 'settleAfterWindow', [mandateHash]);
  }

  refund(anyAccount, mandateHash) {
    return this.write(anyAccount, 'refund', [mandateHash]);
  }

  getRecord(mandateHash) {
    return this.read('getRecord', [mandateHash]);
  }
}

export const STATUS = ['None', 'Funded', 'Delivered', 'Settled', 'Refunded'];

// ===========================================================================
// HSP-MCP mode — the official HSP Agentic Payment rail (docs-notes.md §7.2).
//
// Flow: get_chain_config -> create_order -> get_order -> prepare_payment ->
// [our checks: checkTypedData + spend caps] -> payer signs the EIP-3009
// TransferWithAuthorization under the TOKEN's EIP-712 domain -> finalize_payment
// -> submit_payment (gateway broadcasts; payer is gasless) -> query_payment
// until a stop state. The receipt records the HSP flow_id so one receipt can
// link this rail with the escrow rail.
//
// The MCP transport is injectable (`call` / `listTools`) so the whole flow is
// testable offline against a mock transport shaped by the recorded fixtures.
// ===========================================================================

export const HSP_MCP_QA_URL = 'https://mcp-qa.hashkeymerchant.com/';
export const HSP_MCP_TOOLS = [
  'get_chain_config',
  'create_order',
  'get_order',
  'prepare_payment',
  'finalize_payment',
  'estimate_fee',
  'submit_payment',
  'query_payment',
];
/** QA sandbox token used by the MCP rail on HashKey testnet (chain 133):
 *  USDC, 6 decimals, EIP-3009, EIP-712 domain "USD Coin" version "2"
 *  (confirmed by the recorded get_chain_config fixture, docs-notes.md §7.2). */
export const HSP_TESTNET_USDC = '0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6';
/** Polling cadence and pending threshold from the HSP guide (via Mumbai repo). */
export const HSP_POLL_MS = 15_000;
export const HSP_PENDING_AFTER_MS = 10 * 60_000;
/** token_total_raw may exceed the agreed price by at most this (gas-fee slack). */
export const HSP_MAX_OVER_PRICE_PCT = 10n;
/** validBefore must not reach further than this into the future. */
export const HSP_MAX_VALIDITY_SECONDS = 3600;
/** Statuses at which polling stops; the first two mean the payment is on-chain. */
export const HSP_STOP_STATES = ['payment-safe', 'payment-finalized', 'payment-failed'];
export const HSP_ON_CHAIN_STATES = ['payment-safe', 'payment-finalized'];
export const X402_METHOD = 'https://www.x402.org/';

export class HspToolError extends Error {
  constructor(tool, message) {
    super(`${tool}: ${message}`);
    this.tool = tool;
  }
}

/**
 * Minimal Streamable-HTTP MCP client (JSON-RPC over POST, JSON or SSE
 * replies, mcp-session-id handling). No credentials are ever sent; the payer
 * private key never leaves the wallet — only signatures do.
 * Returns { connect, listTools, call, close } where call(name, args) resolves
 * to the tool's structured result and throws HspToolError on tool errors.
 */
export function createMcpHttpTransport(url, { fetchImpl = fetch, timeoutMs = 30_000, clientInfo = { name: 'mandatesettle', version: '0.1.0' } } = {}) {
  let sessionId = null;
  let nextId = 1;

  function parseBody(text, contentType) {
    if (!text) return null;
    if ((contentType ?? '').includes('text/event-stream')) {
      const msgs = text
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => JSON.parse(l.slice('data:'.length).trim()));
      return msgs.at(-1) ?? null;
    }
    return JSON.parse(text);
  }

  async function post(body) {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    const res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;
    if (res.status === 202) return null; // notification accepted, no body
    const text = await res.text();
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 200)}`);
    return parseBody(text, res.headers.get('content-type') ?? '');
  }

  async function request(method, params) {
    const msg = await post({ jsonrpc: '2.0', id: nextId++, method, params });
    if (!msg) throw new Error(`MCP ${method}: empty response`);
    if (msg.error) throw new Error(`MCP ${method}: ${msg.error.message ?? JSON.stringify(msg.error)}`);
    return msg.result;
  }

  return {
    async connect() {
      const result = await request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo,
      });
      await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
      return result;
    },
    async listTools() {
      const r = await request('tools/list', {});
      return (r?.tools ?? []).map((t) => t.name);
    },
    async call(name, args) {
      const res = await request('tools/call', { name, arguments: args });
      const text = Array.isArray(res?.content)
        ? res.content.filter((c) => c && c.type === 'text').map((c) => String(c.text)).join('\n')
        : '';
      if (res?.isError) throw new HspToolError(name, text || 'tool error');
      if (res?.structuredContent !== undefined) return res.structuredContent;
      try {
        return JSON.parse(text);
      } catch {
        throw new HspToolError(name, `no structured result: ${text.slice(0, 200)}`);
      }
    },
    async close() {
      // Streamable HTTP is request-scoped; nothing persistent to tear down.
    },
  };
}

/** Typed wrappers over the eight HSP MCP tools. Argument names match the
 *  live tool schemas recorded in the Mumbai fixtures exactly. */
export class HspMcpClient {
  constructor(call) {
    this.call = call;
  }

  getChainConfig = () => this.call('get_chain_config', {});
  createOrder = (args) => this.call('create_order', args);
  getOrder = (flowId) => this.call('get_order', { flow_id: flowId });
  preparePayment = (flowId, payer, protocol = 'eip3009') =>
    this.call('prepare_payment', { flow_id: flowId, payer, protocol });
  /** The three prepare_payment values go back unchanged; only the signature is ours. */
  finalizePayment = (signature, prep) =>
    this.call('finalize_payment', {
      signature,
      payment_payload: prep.payment_payload,
      payment_mandate_contents: prep.payment_mandate_contents,
      cart_hash: prep.cart_hash,
    });
  estimateFee = (args) => this.call('estimate_fee', args);
  submitPayment = (paymentMandateJson) => this.call('submit_payment', { payment_mandate_json: paymentMandateJson });
  queryPayment = (flowId, expectedMerchantName) =>
    this.call('query_payment', { flow_id: flowId, expected_merchant_name: expectedMerchantName });
}

const sameAddress = (a, b) =>
  typeof a === 'string' && isAddress(a, { strict: false }) && getAddress(a) === getAddress(b);

const uint = (v) => {
  if (typeof v === 'bigint') return v >= 0n ? v : undefined;
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : undefined;
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  return undefined;
};

/**
 * The EIP-3009 token to pay with, read from THIS get_chain_config: the entry
 * on `chainId` at `address`, protocol eip3009. Duplicate identical rows (the
 * QA server lists some tokens twice) are fine; conflicting rows are not.
 */
export function selectHspToken(cfg, { chainId, address }) {
  const tokens = (cfg?.tokens ?? []).filter((t) => t.chain_id === chainId && sameAddress(t.address, address));
  if (!tokens.length) throw new Error(`get_chain_config has no token ${address} on chain ${chainId}`);
  const distinct = new Set(tokens.map((t) => JSON.stringify([t.symbol, t.name, t.decimals, t.version, t.payment_protocol])));
  if (distinct.size > 1) throw new Error(`get_chain_config lists ${address} on chain ${chainId} with different settings`);
  const token = tokens[0];
  if (token.payment_protocol !== 'eip3009') {
    throw new Error(`${token.symbol} on chain ${chainId} is ${token.payment_protocol}, not eip3009`);
  }
  const network = (cfg?.networks ?? []).find((n) => n.chain_id === chainId);
  if (!network) throw new Error(`get_chain_config has no network ${chainId}`);
  return { network, token };
}

/** The ceiling for token_total_raw: the agreed price plus the fee slack. */
export const maxRawFor = (price) => price + (price * HSP_MAX_OVER_PRICE_PCT) / 100n;

/** EIP-3009's struct, field for field — anything else is a different signature. */
export const TRANSFER_WITH_AUTHORIZATION_TYPES = [
  { name: 'from', type: 'address' },
  { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' },
  { name: 'nonce', type: 'bytes32' },
];

const isTransferWithAuthorization = (fields) =>
  Array.isArray(fields) &&
  fields.length === TRANSFER_WITH_AUTHORIZATION_TYPES.length &&
  fields.every(
    (f, i) => f && typeof f === 'object' && f.name === TRANSFER_WITH_AUTHORIZATION_TYPES[i].name && f.type === TRANSFER_WITH_AUTHORIZATION_TYPES[i].type,
  );

/**
 * Why the server's typed data must NOT be signed, or undefined when it is
 * exactly the transfer we agreed to: TransferWithAuthorization under the
 * token's own domain (name/version/chain/verifyingContract cross-checked
 * against this session's get_chain_config), from the payer to the pay_to,
 * for token_total_raw, within the cap, valid for at most one hour.
 * Adapted from the Mumbai winner's checkTypedData discipline (reviewed).
 */
export function checkTypedData(prep, { chainId, token, payer, payTo, maxRaw, now = new Date() }) {
  const d = prep?.eip712;
  if (!d || typeof d !== 'object' || !d.domain || !d.message || !d.types) return 'eip712 is missing domain, types or message';
  if (d.primaryType !== 'TransferWithAuthorization') return `primaryType is ${d.primaryType}, not TransferWithAuthorization`;
  if (!isTransferWithAuthorization(d.types.TransferWithAuthorization)) return 'types.TransferWithAuthorization is not the EIP-3009 struct';
  const extra = Object.keys(d.domain).filter((k) => !['name', 'version', 'chainId', 'verifyingContract'].includes(k));
  if (extra.length) return `domain has unexpected fields: ${extra.join(', ')}`;
  if (uint(d.domain.chainId) !== BigInt(chainId)) return `domain.chainId is ${String(d.domain.chainId)}, not ${chainId}`;
  if (!sameAddress(d.domain.verifyingContract, token.address)) {
    return `domain.verifyingContract is ${String(d.domain.verifyingContract)}, not ${token.symbol} ${token.address}`;
  }
  if (d.domain.name !== token.name || d.domain.version !== token.version) {
    return `domain is "${String(d.domain.name)}" v${String(d.domain.version)}, not "${token.name}" v${token.version}`;
  }
  if (!sameAddress(d.message.from, payer)) return `message.from is ${String(d.message.from)}, not the payer ${payer}`;
  if (!sameAddress(d.message.to, payTo)) return `message.to is ${String(d.message.to)}, not the confirmed pay_to ${payTo}`;
  const total = uint(prep.token_total_raw);
  if (total === undefined || total === 0n) return `token_total_raw "${prep.token_total_raw}" is not a positive integer`;
  if (uint(d.message.value) !== total) return `message.value ${String(d.message.value)} is not token_total_raw ${prep.token_total_raw}`;
  if (total > maxRaw) return `token_total_raw ${total} is over the cap of ${maxRaw}`;
  if (uint(d.message.validAfter) === undefined) return `validAfter ${String(d.message.validAfter)} is not an integer`;
  const before = uint(d.message.validBefore);
  const nowSec = BigInt(Math.floor(now.getTime() / 1000));
  if (before === undefined || before <= nowSec) return `validBefore ${String(d.message.validBefore)} has already passed`;
  if (before > nowSec + BigInt(HSP_MAX_VALIDITY_SECONDS)) {
    return `validBefore ${before} is more than ${HSP_MAX_VALIDITY_SECONDS / 60} min away`;
  }
  if (!isHex(d.message.nonce) || d.message.nonce.length !== 66) return 'message.nonce is not a bytes32';
  return undefined;
}

/** viem signTypedData input, built only from fields checkTypedData has passed. */
export function toSignable(eip712) {
  return {
    domain: {
      name: String(eip712.domain.name),
      version: String(eip712.domain.version),
      chainId: Number(uint(eip712.domain.chainId)),
      verifyingContract: getAddress(String(eip712.domain.verifyingContract)),
    },
    types: { TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION_TYPES },
    primaryType: 'TransferWithAuthorization',
    message: {
      from: getAddress(String(eip712.message.from)),
      to: getAddress(String(eip712.message.to)),
      value: uint(eip712.message.value),
      validAfter: uint(eip712.message.validAfter),
      validBefore: uint(eip712.message.validBefore),
      nonce: eip712.message.nonce,
    },
  };
}

/**
 * CartMandate contents for create_order, following the schema in the HSP
 * guide as recorded in the Mumbai fixtures: amounts in USD only, one x402
 * method_data entry per payment method, network/token taken from
 * get_chain_config (never invented). merchant_authorization is signed by the
 * server and must NOT be sent.
 */
export function buildCartContents({ cartId, paymentRequestId, merchantName, label, amountRaw, token, network, payTo, expiresAt }) {
  const value = Number(formatUnits(amountRaw, token.decimals)).toFixed(2);
  return {
    id: cartId,
    user_cart_confirmation_required: true,
    payment_request: {
      method_data: [
        {
          supported_methods: X402_METHOD,
          data: {
            x402Version: 2,
            network: network.name,
            chain_id: network.chainId,
            contract_address: token.address,
            pay_to: payTo,
            coin: token.symbol,
          },
        },
      ],
      details: {
        id: paymentRequestId,
        display_items: [{ label, amount: { currency: 'USD', value } }],
        total: { label: 'Total', amount: { currency: 'USD', value } },
      },
    },
    cart_expiry: expiresAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    merchant_name: merchantName,
  };
}

/**
 * HSP-MCP mode of the gateway adapter. Same adapter seam as HspGateway; the
 * agents' interfaces are untouched — this class is driven by its own caller
 * (tests today; a CLI wrapper can be added without changing buyer/seller/
 * settle). Settlement on this rail is HSP's direct transfer; the escrow
 * delivery-gating stays exclusive to the self-hosted mode.
 */
export class HspMcpGateway {
  constructor({
    mcpUrl = HSP_MCP_QA_URL,
    transport = null,
    call = null,
    chainId = 133,
    tokenAddress = HSP_TESTNET_USDC,
    merchantName,
    pollMs = HSP_POLL_MS,
    pendingAfterMs = HSP_PENDING_AFTER_MS,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = () => new Date(),
  } = {}) {
    if (!merchantName) throw new Error('HspMcpGateway: merchantName is required (payment attribution)');
    this.mcpUrl = mcpUrl;
    this.transport = transport ?? (call ? null : createMcpHttpTransport(mcpUrl));
    this.injectedCall = call;
    this.chainId = chainId;
    this.tokenAddress = tokenAddress;
    this.merchantName = merchantName;
    this.pollMs = pollMs;
    this.pendingAfterMs = pendingAfterMs;
    this.sleep = sleep;
    this.now = now;
    this.client = null;
    this.tools = null;
  }

  /** Connect (unless a call transport was injected) and refuse to proceed
   *  unless all eight HSP tools are present — the guide's rule. */
  async connect() {
    if (this.injectedCall) {
      this.client = new HspMcpClient(this.injectedCall);
      return this;
    }
    await this.transport.connect();
    this.tools = await this.transport.listTools();
    const missing = HSP_MCP_TOOLS.filter((t) => !this.tools.includes(t));
    if (missing.length) {
      await this.transport.close();
      throw new Error(`HSP MCP at ${this.mcpUrl} is missing ${missing.join(', ')}: not paying`);
    }
    this.client = new HspMcpClient((name, args) => this.transport.call(name, args));
    return this;
  }

  async close() {
    if (this.transport) await this.transport.close();
  }

  /**
   * Full A2A payment over the HSP MCP rail. `payerAccount` is a viem
   * LocalAccount (address + signTypedData); the key never leaves this
   * process. `maxPerTxRaw` is the buyer's local spend cap in raw token
   * units — the effective signing cap is min(price + fee slack, cap).
   * Returns a receipt object carrying the HSP flow_id.
   */
  async payViaMcp({ payerAccount, payTo, amountRaw, label = 'A2A task payment', maxPerTxRaw = null, cartId, paymentRequestId, expiresAt }) {
    if (!this.client) await this.connect();
    const payer = payerAccount.address;
    if (maxPerTxRaw !== null && amountRaw > maxPerTxRaw) {
      throw new Error(`Policy: amount ${amountRaw} exceeds per-tx cap ${maxPerTxRaw} (refused before create_order)`);
    }

    // 1. What the gateway accepts right now: our token on our chain, eip3009.
    const cfg = await this.client.getChainConfig();
    const { network, token } = selectHspToken(cfg, { chainId: this.chainId, address: this.tokenAddress });

    // 2. Order from the seller's cart mandate (contents built from config).
    const ts = this.now().getTime().toString(36);
    const contents = buildCartContents({
      cartId: cartId ?? `cart-${ts}`,
      paymentRequestId: paymentRequestId ?? `payreq-${ts}`,
      merchantName: this.merchantName,
      label,
      amountRaw,
      token,
      network: { name: network.name, chainId: network.chain_id },
      payTo,
      expiresAt: expiresAt ?? new Date(this.now().getTime() + 30 * 60_000),
    });
    const order = await this.client.createOrder({
      merchant_name: this.merchantName,
      pay_to: payTo,
      cart_mandate: { contents },
    });
    const flowId = order.flow_id;
    await this.client.getOrder(flowId);

    // 3. Server builds the EIP-3009 typed data, bound to the cart via cart_hash.
    const prep = await this.client.preparePayment(flowId, payer, 'eip3009');

    // 4. NEVER sign what we have not checked: typed data + spend caps.
    const cap = maxRawFor(amountRaw);
    const maxRaw = maxPerTxRaw !== null && maxPerTxRaw < cap ? maxPerTxRaw : cap;
    const complaint = checkTypedData(prep, {
      chainId: this.chainId,
      token,
      payer,
      payTo,
      maxRaw,
      now: this.now(),
    });
    if (complaint) throw new Error(`Refusing to sign HSP typed data: ${complaint}`);

    // 5. Sign exactly what prepare_payment returned, then finalize + submit.
    const signature = await payerAccount.signTypedData(toSignable(prep.eip712));
    const fin = await this.client.finalizePayment(signature, prep);
    await this.client.submitPayment(fin.payment_mandate_json);

    // 6. Poll until a stop state; past the pending threshold we report the
    //    payment as pending-confirmation (resumable via flow_id), not failed.
    const started = this.now().getTime();
    let q = null;
    for (;;) {
      q = await this.client.queryPayment(flowId, this.merchantName);
      if (HSP_STOP_STATES.includes(q.status)) break;
      if (this.now().getTime() - started > this.pendingAfterMs) break;
      await this.sleep(this.pollMs);
    }

    return {
      mode: 'hsp-mcp',
      rail: 'HSP Agentic Payment (MCP)',
      flowId,
      paymentRequestId: order.payment_request_id ?? contents.payment_request.details.id,
      paymentHash: fin.payment_hash ?? null,
      cartHash: fin.cart_hash ?? prep.cart_hash,
      status: HSP_STOP_STATES.includes(q?.status) ? q.status : 'payment-pending-confirmation',
      onChain: HSP_ON_CHAIN_STATES.includes(q?.status),
      txSignature: q?.payment?.tx_signature ?? null,
      attributionVerified: q?.attribution_verified ?? null,
      merchantName: this.merchantName,
      payer,
      payTo,
      token: token.address,
      tokenSymbol: token.symbol,
      chainId: this.chainId,
      amountRaw: prep.token_total_raw,
      recordedAt: this.now().toISOString(),
    };
  }
}
