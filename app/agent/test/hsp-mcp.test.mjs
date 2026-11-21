// Tests for the HSP-MCP mode of the gateway adapter (src/hsp.mjs).
//   node --test test/hsp-mcp.test.mjs
//
// No network, no real funds: the MCP transport is an in-memory mock whose
// shapes mirror the recorded HSP QA fixtures published by the Mumbai-edition
// winner (0xultravioleta/agentsettle-hsk, test/fixtures/hsp-mcp + its fake
// server): chain-133 USDC 0x8FE3…53c6 ("USD Coin" v2, eip3009), prepare_payment
// returning EIP-3009 typed data with string values, finalize_payment verifying
// the payer signature server-side. The mock is our own rewrite of that shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { getAddress, verifyTypedData, recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  HspMcpGateway,
  HSP_TESTNET_USDC,
  checkTypedData,
  selectHspToken,
  toSignable,
  maxRawFor,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
} from '../src/hsp.mjs';

// Well-known public test keys (anvil accounts #0/#1) — never used with funds.
const PAYER = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const PAYEE = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const USDT_TESTNET = '0x372325443233fEbaC1F6998aC750276468c83CC6';
const FAKE_TX = `0x${'ab'.repeat(32)}`;

const sha = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

/** Chain config shaped like the recorded get_chain_config fixture (§7.2). */
function fixtureChainConfig() {
  return {
    networks: [
      { chain_id: 133, name: 'hashkey-testnet', display_name: 'HashKey Chain Testnet', is_testnet: true },
      { chain_id: 84532, name: 'base-sepolia', display_name: 'Base Sepolia', is_testnet: true },
    ],
    tokens: [
      {
        address: HSP_TESTNET_USDC, chain_id: 133, decimals: 6, name: 'USD Coin', symbol: 'USDC',
        version: '2', payment_protocol: 'eip3009', permit2_spender: '0x85Afd346143690AFbEc392524A8bae1e9ea8f500',
      },
      {
        address: USDT_TESTNET, chain_id: 133, decimals: 6, name: 'Tether USD', symbol: 'USDT',
        version: '1', payment_protocol: 'permit2', permit2_spender: '0x85Afd346143690AFbEc392524A8bae1e9ea8f500',
      },
    ],
  };
}

/** In-memory mock of the HSP MCP server's 8 tools (fixture-shaped). */
function mockHspMcp({ tamper = null } = {}) {
  const calls = [];
  const orders = new Map();
  const preps = new Map();
  const state = { lastPrep: null, lastSignature: null };
  const cfg = fixtureChainConfig();
  const tokenFor = (chainId, address) =>
    cfg.tokens.find((t) => t.chain_id === chainId && getAddress(t.address) === getAddress(address));
  const nowSec = () => Math.floor(Date.now() / 1000);

  const handlers = {
    get_chain_config: () => cfg,
    estimate_fee: () => ({ fee_raw: '0', currency: 'USD' }),
    create_order: (a) => {
      if (!a.merchant_name) throw new Error('create_order: no merchant_name');
      if (a.cart_mandate?.merchant_authorization) throw new Error('create_order: merchant_authorization must not be sent');
      const c = a.cart_mandate?.contents;
      const m = c?.payment_request?.method_data?.[0];
      if (!c?.id || !c?.cart_expiry || !m || m.supported_methods !== 'https://www.x402.org/' || m.data?.x402Version !== 2) {
        throw new Error('create_order: cart_mandate shape');
      }
      if (!tokenFor(m.data.chain_id, m.data.contract_address)) throw new Error('create_order: token not in get_chain_config');
      if (c.payment_request.details.total.amount.currency !== 'USD') throw new Error('create_order: currency must be USD');
      const flowId = `flow-${orders.size + 1}`;
      const contents = { ...c, merchant_name: a.merchant_name };
      contents.payment_request.method_data = c.payment_request.method_data.map((md) => ({
        ...md,
        data: { ...md.data, pay_to: a.pay_to },
      }));
      orders.set(flowId, { flowId, paymentRequestId: c.payment_request.details.id, payTo: getAddress(a.pay_to), contents });
      return { merchant_name: a.merchant_name, payment_request_id: c.payment_request.details.id, flow_id: flowId, payment_url: `https://pay-qa.example/flow/${flowId}` };
    },
    get_order: (a) => {
      const o = orders.get(a.flow_id);
      if (!o) throw new Error('get_order: unknown flow_id');
      return { payment_request_id: o.paymentRequestId, cart_mandate_id: o.contents.id, merchant_name: o.contents.merchant_name, status: 'payment-required', method_data: o.contents.payment_request.method_data, gas_fee_configs: [{ network: 'hashkey-testnet', gas_fee_advanced: true }] };
    },
    prepare_payment: (a) => {
      const o = orders.get(a.flow_id);
      if (!o) throw new Error('prepare_payment: unknown flow_id');
      if (a.protocol !== 'eip3009') throw new Error('prepare_payment: protocol');
      const md = o.contents.payment_request.method_data[0].data;
      const token = tokenFor(md.chain_id, md.contract_address);
      const raw = BigInt(Math.round(Number(o.contents.payment_request.details.total.amount.value) * 1e6));
      const message = {
        from: getAddress(a.payer), to: o.payTo, value: raw.toString(),
        validAfter: '0', validBefore: String(nowSec() + 600), nonce: `0x${randomBytes(32).toString('hex')}`,
      };
      const eip712 = {
        domain: { name: token.name, version: token.version, chainId: md.chain_id, verifyingContract: token.address },
        types: {
          EIP712Domain: [
            { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
            { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' },
          ],
          TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION_TYPES,
        },
        primaryType: 'TransferWithAuthorization',
        message,
      };
      const detailsId = `pd-${randomBytes(6).toString('hex')}`;
      const answer = {
        eip712,
        cart_hash: sha(o.contents),
        token_total_raw: raw.toString(),
        quote_expires_at: new Date((nowSec() + 300) * 1000).toISOString(),
        pay_to: o.payTo,
        payer: getAddress(a.payer),
        payment_request_id: o.paymentRequestId,
        payment_details_id: detailsId,
        payment_details_total: (Number(raw) / 1e6).toFixed(2),
        payment_payload: {
          x402Version: 2,
          accepted: { scheme: 'exact', network: `eip155:${md.chain_id}`, asset: token.address, payTo: o.payTo, amount: raw.toString(), maxTimeoutSeconds: 600, extra: { protocol: 'eip3009' } },
          payload: { signature: '', authorization: message },
        },
        payment_mandate_contents: { payment_mandate_id: o.paymentRequestId, payment_details_id: detailsId, merchant_agent: 'mandatesettle' },
      };
      if (tamper) tamper(answer);
      preps.set(message.nonce, { flowId: o.flowId, eip712: answer.eip712 });
      state.lastPrep = answer;
      return answer;
    },
    finalize_payment: async (a) => {
      const p = preps.get(a.payment_payload?.payload?.authorization?.nonce);
      if (!p) throw new Error('finalize_payment: unknown payment_payload');
      const { EIP712Domain: _ignored, ...types } = p.eip712.types;
      const ok = await verifyTypedData({
        address: p.eip712.message.from, domain: p.eip712.domain, types,
        primaryType: p.eip712.primaryType, message: p.eip712.message, signature: a.signature,
      });
      if (!ok) throw new Error('finalize_payment: the signature does not verify for the payer');
      state.lastSignature = a.signature;
      return { payment_mandate_json: JSON.stringify({ payment_mandate: { payment_mandate_contents: a.payment_mandate_contents } }), payment_hash: sha(a.payment_mandate_contents), cart_hash: a.cart_hash };
    },
    submit_payment: () => ({ data: { status: 'payment-submitted' } }),
    query_payment: (a) => ({
      merchant_name: 'MandateSettle', expected_merchant_name: a.expected_merchant_name,
      payment_request_id: 'payreq-test', flow_id: a.flow_id, status: 'payment-finalized',
      attribution_verified: true,
      payment: { gas_fee_advanced: true, payer_address: PAYER.address, to_pay_address: PAYEE, token_address: HSP_TESTNET_USDC, tx_signature: FAKE_TX, amount: '0.10' },
    }),
  };

  const call = async (name, args) => {
    calls.push(name);
    const h = handlers[name];
    if (!h) throw new Error(`unknown tool ${name}`);
    return h(args);
  };
  return { call, calls, state };
}

function gateway(mock, extra = {}) {
  return new HspMcpGateway({ call: mock.call, merchantName: 'MandateSettle', pollMs: 1, sleep: async () => {}, ...extra });
}

test('full HSP-MCP flow completes and the receipt carries the HSP flow_id', async () => {
  const mock = mockHspMcp();
  const gw = gateway(mock);
  const receipt = await gw.payViaMcp({ payerAccount: PAYER, payTo: PAYEE, amountRaw: 100_000n });
  assert.equal(receipt.mode, 'hsp-mcp');
  assert.equal(receipt.flowId, 'flow-1');
  assert.equal(receipt.status, 'payment-finalized');
  assert.equal(receipt.onChain, true);
  assert.equal(receipt.txSignature, FAKE_TX);
  assert.equal(receipt.attributionVerified, true);
  assert.ok(receipt.paymentHash && receipt.cartHash);
  assert.equal(receipt.amountRaw, '100000');
  assert.deepEqual(mock.calls, [
    'get_chain_config', 'create_order', 'get_order', 'prepare_payment',
    'finalize_payment', 'submit_payment', 'query_payment',
  ]);
});

test('the produced EIP-3009 payload is structurally exact and its signature recovers to the payer', async () => {
  const mock = mockHspMcp();
  const gw = gateway(mock);
  await gw.payViaMcp({ payerAccount: PAYER, payTo: PAYEE, amountRaw: 100_000n });
  const prep = mock.state.lastPrep;
  // Domain: the token's own EIP-712 domain on chain 133 (fixture values).
  assert.equal(prep.eip712.domain.name, 'USD Coin');
  assert.equal(prep.eip712.domain.version, '2');
  assert.equal(prep.eip712.domain.chainId, 133);
  assert.equal(getAddress(prep.eip712.domain.verifyingContract), getAddress(HSP_TESTNET_USDC));
  // Types: the EIP-3009 struct, field for field, in order.
  assert.deepEqual(
    prep.eip712.types.TransferWithAuthorization.map((f) => `${f.name}:${f.type}`),
    ['from:address', 'to:address', 'value:uint256', 'validAfter:uint256', 'validBefore:uint256', 'nonce:bytes32'],
  );
  assert.match(prep.eip712.message.nonce, /^0x[0-9a-f]{64}$/);
  // Signature recovery over the signable form equals the payer.
  const recovered = await recoverTypedDataAddress({ ...toSignable(prep.eip712), signature: mock.state.lastSignature });
  assert.equal(recovered, PAYER.address);
});

test('checkTypedData accepts the honest payload and the cap math is price + 10%', () => {
  const cfg = fixtureChainConfig();
  const { token } = selectHspToken(cfg, { chainId: 133, address: HSP_TESTNET_USDC });
  assert.equal(maxRawFor(100_000n), 110_000n);
  assert.equal(token.name, 'USD Coin');
  assert.equal(token.version, '2');
});

test('selectHspToken refuses the permit2 token for the eip3009 rail', () => {
  const cfg = fixtureChainConfig();
  assert.throws(() => selectHspToken(cfg, { chainId: 133, address: USDT_TESTNET }), /permit2, not eip3009/);
});

test('a tampered payee in the typed data aborts the flow before any signature', async () => {
  const mock = mockHspMcp({ tamper: (prep) => { prep.eip712.message.to = PAYER.address; } });
  const gw = gateway(mock);
  await assert.rejects(() => gw.payViaMcp({ payerAccount: PAYER, payTo: PAYEE, amountRaw: 100_000n }), /Refusing to sign/);
  assert.ok(!mock.calls.includes('finalize_payment'));
  assert.ok(!mock.calls.includes('submit_payment'));
  assert.equal(mock.state.lastSignature, null);
});

test('a token_total_raw above the price + 10% cap aborts the flow', async () => {
  const mock = mockHspMcp({
    tamper: (prep) => {
      prep.token_total_raw = '150000';
      prep.eip712.message.value = '150000';
    },
  });
  const gw = gateway(mock);
  await assert.rejects(() => gw.payViaMcp({ payerAccount: PAYER, payTo: PAYEE, amountRaw: 100_000n }), /over the cap/);
  assert.ok(!mock.calls.includes('finalize_payment'));
});

test('a wrong token domain name aborts the flow', async () => {
  const mock = mockHspMcp({ tamper: (prep) => { prep.eip712.domain.name = 'Bridged USDC'; } });
  const gw = gateway(mock);
  await assert.rejects(() => gw.payViaMcp({ payerAccount: PAYER, payTo: PAYEE, amountRaw: 100_000n }), /Refusing to sign/);
  assert.ok(!mock.calls.includes('finalize_payment'));
});

test('the buyer per-tx spend cap refuses before create_order is called', async () => {
  const mock = mockHspMcp();
  const gw = gateway(mock);
  await assert.rejects(
    () => gw.payViaMcp({ payerAccount: PAYER, payTo: PAYEE, amountRaw: 600_000n, maxPerTxRaw: 500_000n }),
    /per-tx cap/,
  );
  assert.deepEqual(mock.calls, []);
});
