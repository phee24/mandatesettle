# MandateSettle — Agent-to-Agent Settlement on HashKey Chain (HSP)

**HSK Chain Horizon Hackathon · Seoul — Track: Agent Payments & A2A Settlement**

MandateSettle lets AI agents hire and pay each other safely on HashKey Chain.
It settles payments two ways, behind one adapter:

**Mode 1 — HSP MCP (the official HSP rail).** The buyer agent pays through
HSP's own **Agentic Payment MCP server**: the server builds an **EIP-3009
`TransferWithAuthorization`** under the token's EIP-712 domain, bound to the
seller's cart mandate via `cart_hash`; the buyer verifies the typed data
field-by-field against its spend policy and signs it; HSP's gateway executes
the transfer (the payer is gasless) and the receipt records the HSP
`flow_id`. **This direct transfer is how HSP itself settles.**

**Mode 2 — escrow gateway (our extension).** For task-based work, paying on
delivery is safer than paying instantly, so MandateSettle adds its own
on-chain escrow on top of the same mandate discipline:

1. **Recipient conditions** — the seller agent publishes signed payment
   conditions (payee, token, amount, task reference, expiry).
2. **Payment mandate** — the buyer agent checks the conditions against its
   spend policy (per-transaction and daily caps), then signs a bounded
   **EIP-712 PaymentMandate** with its wallet.
3. **Verification + gateway execution** — the signed mandate is verified
   (signature recovery, amount cap, expiry, nonce replay protection) and the
   funds are escrowed on-chain by the settlement gateway contract.
4. **Delivery proof** — the seller agent submits a deliverable hash on-chain.
5. **Settlement** — the buyer confirms, or anyone settles after a challenge
   window; the escrow releases to the seller and emits a
   **`SettlementExecuted` event — a settlement receipt anyone can verify on
   the block explorer**. If no delivery happens before expiry, the buyer is
   refunded automatically.

> **Honesty note:** the escrow in Mode 2 is MandateSettle's own additional
> safeguard for pay-on-delivery tasks. It is **not** part of HSP's built-in
> flow — HSP settles by direct transfer (Mode 1) — and we never describe it
> as such.

## Architecture

```
 seller agent ──signed conditions──▶ buyer agent
      │                                │ policy check (caps)
      │                                │ EIP-712 mandate signature
      │                                ▼
      │                         HspGateway adapter ──▶ A2AEscrow (gateway contract)
      │                                │                 HashKey Chain (133 testnet / 177 mainnet)
      └── delivery proof ─────────────┴──▶ settle ──▶ SettlementExecuted receipt (explorer-verifiable)
```

- `app/contracts/A2AEscrow.sol` — the settlement gateway: EIP-712 mandate
  verification, escrow, delivery proofs, settlement, expiry refunds.
- `app/contracts/MockERC20.sol` — test stablecoin for testnet/local demos.
- `app/agent/src/hsp.mjs` — the **gateway adapter**, with both modes:
  `HspGateway` (self-hosted escrow gateway, Mode 2) and `HspMcpGateway`
  (Mode 1: the official HSP Agentic Payment MCP rail — 8 tools, EIP-3009
  payload, `checkTypedData` + spend-cap checks before signing, `flow_id`
  recorded in the receipt). HSP publishes no SDK (the `project-hsp` GitHub
  org has no public repositories as of 21 Nov 2026); the MCP mode follows
  the tool schemas recorded in the Mumbai-edition winner's public fixtures
  (reviewed, not executed — see `docs-notes.md` §7.2/§8). The agents call
  the adapter, so neither mode changes buyer/seller/settle.
- `app/agent/src/buyer.mjs` — payer agent (policy + mandate signing + escrow funding).
- `app/agent/src/seller.mjs` — recipient agent (conditions + delivery proof).
- `app/agent/src/settle.mjs` — settlement executor + receipt writer/verifier.
- `app/agent/src/demo.mjs` — full end-to-end demo on a local chain.

## Quick start (local demo)

```bash
cd app && forge build && forge test        # 10 contract tests
anvil &                                     # local chain on :8545
cd agent && npm install && node src/demo.mjs
```

## HSP-MCP mode tests + probe

```bash
cd agent && npm test                       # 8 offline tests: full MCP flow vs a
                                           # fixture-shaped mock transport, EIP-3009
                                           # structure + signature recovery, tamper/cap refusals
npm run probe:hsp                          # read-only probe of the live QA MCP server
                                           # (initialize + tools/list + get_chain_config only)
```

Status of the live rail: the QA MCP server was unreachable from our sandbox
(proxy tunnel opens, origin sends no bytes — `docs-notes.md` §8.1), so
Mode 1 is currently proven against the mock transport, not yet live. The
escrow mode is deployed and demoed end-to-end on HashKey testnet
(chain 133) and mainnet (chain 177) — see **Deployments & proofs** below.

## Testnet / mainnet runs

```bash
cd app
forge script script/Deploy.s.sol --rpc-url hsk_testnet --broadcast \
  --private-key $DEPLOYER_PRIVATE_KEY       # env DEPLOY_MOCK_TOKEN=1 on testnet
cd agent && cp .env.example .env            # fill in keys (never commit .env)
HSK_NETWORK=testnet node src/seller.mjs issue --token <tUSDC> --amount 25 --task "invoice#1: ..."
HSK_NETWORK=testnet node src/buyer.mjs  pay   --escrow <A2AEscrow> --conditions conditions.json
HSK_NETWORK=testnet node src/seller.mjs deliver --escrow <A2AEscrow> --mandate-hash <hash> --deliverable "..."
HSK_NETWORK=testnet node src/settle.mjs settle  --escrow <A2AEscrow> --mandate-hash <hash>
```

Networks: HashKey Chain testnet (chain ID 133, https://testnet.hsk.xyz) for
iteration; mainnet (chain ID 177, https://mainnet.hsk.xyz) for the final
deployment required by the hackathon rules. Settlement tokens on mainnet:
bridged USDC `0x054ed45810DbBAb8B27668922D110669c9D88D0a`, USDT
`0xf1b50ed67a9e2cc94ad3c477779e2d4cbfff9029` (per official HashKey Chain docs).

## Safety properties

- A mandate is a **bounded authorization**: exact payee, token, amount,
  task hash, expiry and single-use nonce — a tampered amount invalidates the
  signature (covered by tests).
- Buyer agent enforces **spend caps** before signing (defaults: 50/tx, 200/day).
- Funds are only released against an on-chain delivery proof, and are
  **refundable** if delivery never happens before expiry.
- Private keys are read from env vars or the mode-600 project wallet file and
  are never printed or committed.

## Status

Phase 1 + 2a + 2b (HSP-MCP mode) complete; testnet and mainnet deployments
are live with full end-to-end demos verified on-chain (below). Research
notes on HSP and HashKey Chain: `docs-notes.md`.

## Deployments & proofs (live)

### HashKey Chain mainnet (chain 177) — explorer: https://hsk.blockscout.com

| Contract | Address | Deploy tx |
|---|---|---|
| A2AEscrow | `0xdD1B64B493eEF154Bfd0369e892ec5062Da0fFE8` | `0x834799c6a980975d4605c0eaa5e5a7d342c3d3777b9d23819e034256329e720d` |
| MockERC20 (tUSDC) | `0xF60f13515E7Aa621D8bee6ff3496fA1E6619bd09` | `0x3cf0647c35f02460ab4775617b359e9dd04f1ae488e152a8af6326bcbc11ce11` |

Full agent cycle executed on mainnet (22 Nov 2026) — mandate
`0x2a685d77febd0429a028fb41393d8548bf7c59aefd7670eef7280c181f560c5e`,
25 tUSDC, task "invoice#mainnet-001: market brief for HSK Chain":

- createMandate (escrow funded): `0xcf20b3af00a4f53a1f5fb14083b6dc6e209072b111c4ef8c4b72a2cd441afc7e`
- submitDelivery: `0x2c953ab8df409049569db49602f2d430f258ba4d0affb5914ed7e9bd59198ae4`
- **Settlement tx: `0x3b9f55a6533cba13b68af94fb1d72d37acd42d9cc1fe4872b4648a38a7032178`**
- Verified by independent direct RPC reads: escrow tUSDC balance **0** after
  settlement (25 while funded), seller balance **0 → 25 tUSDC**, record
  status **Settled**, and the `SettlementExecuted` event present in the
  settlement tx with matching mandateHash / payer / payee / token / amount /
  deliverableHash. Receipt JSON:
  `app/agent/receipts/0x2a685d77febd0429a028fb41393d8548bf7c59aefd7670eef7280c181f560c5e.json`

### HashKey Chain testnet (chain 133) — explorer: https://testnet-explorer.hskchain.net

| Contract | Address | Deploy tx |
|---|---|---|
| A2AEscrow | `0xfD47C2d8AF88Bfc7A696bA1Bf3d4c47f22AB7b5A` | `0x8cabd73a73da5a1864592956ebbb8a53050adb5dc9c708d9a458ca3a166e1a44` |
| MockERC20 (tUSDC) | `0xdD1B64B493eEF154Bfd0369e892ec5062Da0fFE8` | `0x0c75e757dbdc0d5bfc76f850d4ab7d916c73aa750ebe93cdc29207bb74949333` |

The same full cycle ran on testnet first (22 Nov 2026) — mandate
`0x6db9812fcf8f8286f8d5beab61bb6d11c96a68f74db9436ddabc459125aa0df5`,
25 tUSDC, settlement tx
`0xd77afa2d335176804831f5f768de0a7dee945efca39c9925e111620dc4512169`,
with the same independent RPC verification (escrow emptied, seller paid,
status Settled, `SettlementExecuted` emitted). Receipt JSON:
`app/agent/receipts/0x6db9812fcf8f8286f8d5beab61bb6d11c96a68f74db9436ddabc459125aa0df5.json`
