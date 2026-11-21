# HSP + HashKey Chain — Research Notes (Phase 1)

Researched: 21 Nov 2026 (WIB). Sources are official/primary wherever possible; access gaps are stated honestly.

## 1. What HSP is

- **HSP = HashKey Settlement Protocol / HashKey Settlement Platform**, built by HashKey On-Chain (HashKey Group, HKEX: 3887.HK).
- A settlement protocol for digital-asset payments with two core modules (per HashKey's ONERWAY partnership release, PR Newswire):
  - **Master Account** — intelligent aggregation & distribution of merchants' on-chain funds.
  - **Settlement Protocol** — transaction authorization/verification standard so every transaction is auditable; native on-chain AML/risk controls.
- HashKey positions HSP in the agent-payments standards race: core contributor / early member of **Google's Agent Payments Protocol (AP2)** and exploring **ERC-8004** (HSK Whitepaper 2.0, group-oss.hashkey.com).
- Commercial proof: strategic partnership with ONERWAY (licensed cross-border payment provider; UK EMI, EU PI, HK MSO, US MSB, SG MPI) — first Web2 payment institution connected to HSP; 2,000+ merchants reachable.

## 2. What the hackathon track actually requires (Agent Payments & A2A Settlement)

From the official hackathon description (DoraHacks page mirrored verbatim on HackathonRadar / competehub / TechFlowPost):

> "Utilize A2A scenario combined with HSP's API interface — leverage the HSP API to **establish payment mandates based on conditions provided by recipient agents**, **complete wallet signatures**, and **verify and execute on-chain payments via HSP's existing gateways**."

So the canonical HSP A2A flow is:

1. **Recipient (seller) agent publishes conditions** — amount, token, deliverable/task reference, expiry.
2. **Payer (buyer) agent creates a payment mandate** from those conditions and **signs it with its wallet** (mandate = bounded authorization: payee, token, amount cap, conditions hash, expiry, nonce).
3. **Verification** — the mandate signature + conditions are verified (by the counterparty agent and/or the HSP gateway).
4. **Execution** — payment is executed on-chain through an HSP gateway on HashKey Chain; the resulting transaction is the auditable settlement proof.

Series rules (from the verified analysis file): project must be built on HashKey Chain, **must use HSP** for this track, and a **smart contract must be deployed on HashKey Chain MAINNET** or the project is treated as withdrawn from demo selection.

## 3. Official developer resources (verified live, 21 Nov 2026)

| Resource | URL | Status |
|---|---|---|
| HSP hackathon docs | https://hsp-hackathon.hashkeymerchant.com/docs | Linked from official hackathon materials. **Could not be fetched from this sandbox** (the text fetcher cannot resolve the domain) — needs a live-browser read in Phase 2. Endpoint-level details below are therefore from official secondary descriptions, not yet from the docs portal itself. |
| HSP SDK repo | https://github.com/project-hsp/hsp | Org `project-hsp` exists on GitHub, but as of 21 Nov 2026 the org page states **"This organization has no public repositories"** and the repo URL returns 404. → The SDK is **not publicly available** right now. Do not substitute random third-party "HSP" packages. |
| HSP merchant dashboard | https://merchant.hashkey.com | Production merchant backend (login required) — API credentials for the live HSP gateway are issued through HashKey's merchant onboarding; hackathon access path is via the docs portal above. Registration is a Phase-2 step (may need givi's hand — no account was created in Phase 1). |
| HSP user manual | via https://hashfans.io/ top navigation | HashFans = official HashKey Chain developer community hub (verified live). |
| HashKey Chain docs | https://docs.hashkeychain.net | Official chain docs (token contracts page verified, see §4). |
| Developer group | https://t.me/+LBRNQQKVmo83OTg1 | Official HashKey Chain Telegram (from hackathon resources list). |

**Implication for the build:** Phase 1 implements the HSP mandate flow faithfully against our own gateway contract on HashKey Chain (mandate → EIP-712 wallet signature → verification → on-chain escrow settlement → event receipt), behind a clean `HspGateway` adapter interface. When HSP API credentials/SDK access become available (Phase 2), the adapter's `executeSettlement()` can be pointed at the official HSP gateway without changing the agents. This mirrors how the India-edition track project AgentSettle worked: HSP integration built to the mandate model, settlement executed on-chain with a verifiable receipt contract on HashKey mainnet, buyer spend caps enforced (theirs: 0.50 USDC/tx, 5 USDC/day).

## 4. HashKey Chain networks & tokens (verified on-chain / official docs)

| Network | Chain ID | RPC | Explorer | Status 21 Nov 2026 |
|---|---|---|---|---|
| Mainnet | 177 | https://mainnet.hsk.xyz | https://explorer.hsk.xyz (hsk.blockscout.com) | RPC live (chain-id check OK) |
| Testnet | 133 | https://testnet.hsk.xyz | testnet explorer via HashKey docs | RPC live (chain-id check OK) |

Official token contracts on HashKey Chain mainnet (docs.hashkeychain.net → Token Contracts, verified 21 Nov 2026):

| Token | Address |
|---|---|
| USDC (Bridged USDC) | `0x054ed45810DbBAb8B27668922D110669c9D88D0a` |
| USDT (OptimismMintableERC20) | `0xf1b50ed67a9e2cc94ad3c477779e2d4cbfff9029` |
| WHSK | `0xB210D2120d57b758EE163cFfb43e73728c471Cf1` |
| WETH (OptimismMintableERC20) | `0xefd4bC9afD210517803f293ABABd701CaeeCdfd0` |
| HSK | native gas token |

Project wallet: `0x5c859A2B9436DdcFDee904A78BaF680cac72a4d6`
- Mainnet: 13.199491367 HSK (verified on-chain 21 Nov 2026), 0 USDC.
- Testnet: 0 HSK — needs faucet funds for testnet iteration (see STATUS.md).

## 5. Design mapping: HSP concepts → this project (MandateSettle)

| HSP concept | Implementation in `app/` |
|---|---|
| Recipient agent conditions | Seller agent issues a signed **invoice/conditions object** (payee, token, amount, task hash, expiry) — `agent/src/seller.ts` |
| Payment mandate | Buyer agent builds an **EIP-712 `PaymentMandate`** struct and signs it with its wallet — `agent/src/buyer.ts`, types in `contracts/A2AEscrow.sol` |
| Mandate verification | Contract recovers the signer via ECDSA and checks payee/token/amount-cap/expiry/nonce; buyer agent also enforces local spend caps before signing |
| HSP gateway execution | `A2AEscrow` contract acts as the settlement gateway in self-hosted mode: escrows funds at mandate creation, releases on delivery proof, refunds after expiry — behind `HspGateway` adapter (`agent/src/hsp.ts`) |
| Auditable settlement proof | `SettlementExecuted` event + stored receipt record (mandate hash, tx hash, block) — printable explorer link; `agent/src/settle.ts` + receipt JSON |
| Master Account (aggregation) | Out of scope for the hackathon demo; noted as the production HSP module our gateway adapter would plug into |

## 6. Open items for Phase 2 (research)

- Read https://hsp-hackathon.hashkeymerchant.com/docs in a live browser: exact API base URL, auth (API key/HMAC?), mandate endpoints, gateway contract addresses on testnet/mainnet, testnet USDC availability.
- Re-check github.com/project-hsp for public SDK release.
- HashKey testnet faucet location & limits (for testnet HSK + test USDC).
- Whether hackathon HSP access needs merchant-account registration (would need givi's hand — no registration done in Phase 1).

---

## 7. Phase 2a findings (21 Nov 2026, later session) — HSP docs access + compatibility

### 7.1 The docs portal is not reachable — and it is not (only) a sandbox problem

Attempts made this session, in order:

1. `curl` from the sandbox to `https://hsp-hackathon.hashkeymerchant.com/docs` and `/`:
   TLS tunnel establishes through the sandbox egress proxy, then the server
   returns an **empty reply** (curl exit 52, HTTP 000). No content served.
2. **Public DNS check (Google DoH + Cloudflare DoH):** `hsp-hackathon.hashkeymerchant.com`
   has **no A, no AAAA, and no CNAME record**. The apex `hashkeymerchant.com` and
   `www.hashkeymerchant.com` likewise have **no A records** — both resolvers return
   only the zone's SOA (Cloudflare nameservers `sreeni.ns.cloudflare.com`).
   → The subdomain is simply **not published in public DNS** right now; no browser
   anywhere can resolve it. This matches Phase 1's fetcher failure and upgrades it
   from "sandbox can't resolve" to "the portal is effectively offline/unpublished
   as of 21 Nov 2026".
3. The text-fetcher (`browser.open`) independently failed with "requires a resolvable
   public HTTP(S) URL" — consistent with (2).
4. Related subdomains differ: **`mcp-qa.hashkeymerchant.com` DOES resolve**
   (Cloudflare A records 104.21.54.174 / 172.67.168.196). A read-only MCP
   `initialize` probe from this sandbox did not complete (proxy returned HTTP 000;
   one attempt was interrupted by a service restart with unknown outcome; a further
   attempt was not approved in time). A live `get_chain_config` read is still
   outstanding — Phase 2b, via a route that can hold an MCP session.
5. `github.com/project-hsp` re-checked via GitHub API: org still has
   **0 public repositories**. No official SDK has appeared.
6. Per the Mumbai-edition winner's public repo (below), the endpoint-level HSP
   details were distributed to teams as **"the setup guide HSP sent the teams"** —
   i.e. the authoritative guide is gated behind team registration, not only behind
   the dead portal. Registration (givi's hand) is therefore on the critical path
   for official-guide access.

**Conclusion:** the portal's contents remain unread. Nothing below invents them;
the compatibility analysis is built from other primary sources that ARE public.

### 7.2 How HSP actually works — from public primary sources

Best public primary source: **AgentSettle** (Ultravioleta DAO), winner-track
project of the Mumbai (India) edition of this same hackathon series, same track
(Agent Payments & A2A Settlement). Repo `github.com/0xultravioleta/agentsettle-hsk`
is public, including `src/rails/hsp-mcp.ts`, `src/rails/hsp-merchant.ts`,
`docs/hsp/REGISTRATION.md`, and recorded MCP fixtures (`test/fixtures/hsp-mcp/`).
Cross-checked against HashKey's own materials (ONERWAY release; Arkreen × HSP
case study: HSP issues a **Cart Mandate**, confirms via **webhook**; HashKey is a
core contributor to Google's **AP2**, whose terminology HSP follows).

HSP has **two rails**:

**Rail A — HSP Agentic Payment (MCP server). The agent-facing rail.**
- Endpoint (QA): `https://mcp-qa.hashkeymerchant.com/` — Streamable HTTP MCP,
  **8 tools**: `get_chain_config`, `create_order`, `get_order`, `prepare_payment`,
  `finalize_payment`, `estimate_fee`, `submit_payment`, `query_payment`.
- **No registration or credentials needed** for the QA MCP server.
- Flow (payer agent pays a seller's cart mandate):
  1. `get_chain_config` → networks + tokens (chain 133 included; per-token
     `payment_protocol`: `eip3009` for USDC, `permit2` for USDT/HSK).
  2. `create_order { merchant_name, pay_to, cart_mandate: { contents } }` → `flow_id`.
  3. `get_order { flow_id }`.
  4. `prepare_payment { flow_id, payer, protocol: "eip3009" }` → returns the
     EIP-712 typed data to sign, plus `payment_payload`, `payment_mandate_contents`,
     and `cart_hash`. The typed data is an **EIP-3009 `TransferWithAuthorization`**
     (`from, to, value, validAfter, validBefore, nonce`) under the **token's own
     EIP-712 domain** — e.g. testnet USDC domain `"USD Coin"` v2.
  5. Payer agent **verifies the typed data itself** (their `checkTypedData`:
     domain, payee, amount, validity window ≤10 min) and signs with its wallet.
  6. `finalize_payment { signature, payment_payload, payment_mandate_contents, cart_hash }`.
  7. `submit_payment { payment_mandate_json }` — the gateway broadcasts; **payer is gasless**.
  8. `query_payment { flow_id, expected_merchant_name }` until final.
- QA tokens on hashkey-testnet (133): USDC `0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6`
  (6 dp, EIP-3009, domain "USD Coin" v2); USDT `0x372325443233fEbaC1F6998aC750276468c83CC6`
  (Permit2). Mainnet bridged USDC `0x054ed45810DbBAb8B27668922D110669c9D88D0a`,
  domain "Bridged USDC" v2 (matches §4).

**Rail B — HSP REST (HashKey Merchant API). Merchant onboarding required.**
- Onboarding is an **ops invite**: the team sends `organization_name`, `email`,
  `description`, `default_language`, `service_rate`, a **secp256k1 public key**
  (SPKI PEM; private key generated locally, never shared), the
  `supported_chain_tokens` table, an **egress IP allowlist**, and an optional
  webhook URL. The console then issues `app_key` / `app_secret`.
  → The org name + email are givi's data: **this registration needs givi's hand**
  (consistent with Phase 1 notes). Nothing was sent.
- Requests are **HMAC-SHA256** signed; cart mandates are authorized with an
  **ES256K `merchant_authorization` JWT** over the canonical cart hash; payment
  status via signed **webhooks** or `GET /api/v1/merchant/payments`.
- The Mumbai winner marked this rail **off the critical path**: its QA API still
  answered 403 from their setup, while Rail A needed nothing. We mirror that priority.

**Settlement semantics of real HSP:** settlement is a **direct transfer** — the
signed EIP-3009 authorization is executed by the gateway/facilitator; there is no
escrow holding period in HSP itself. Auditability comes from the mandate/order
records (+, in AgentSettle's design, a separate on-chain receipts contract that
stores the HSP payment id alongside the settle tx).

### 7.3 Compatibility verdict: MandateSettle vs official HSP

**Aligned (keep):**
- Lifecycle shape is the same: recipient conditions/cart → payer-signed mandate →
  independent verification → on-chain execution → auditable receipt.
- Our buyer **spend caps (per-tx + daily)** mirror HSP's SpendGuard shape
  (theirs: 0.50 USDC/tx, 5 USDC/day) and our sign-only-after-policy-check mirrors
  their `checkTypedData` discipline.
- EIP-712 is the right signature substrate on both sides.

**Differences (must be handled honestly in the pitch, and in code in Phase 2b):**
1. **Signed payload differs.** Ours: a bespoke `PaymentMandate` struct
   (payer/payee/token/amount/taskHash/expiry/nonce) verified by our own contract
   under a `MandateSettle` domain. HSP's: an **EIP-3009 TransferWithAuthorization**
   under the **token's** domain, bound to a merchant **cart mandate** via `cart_hash`,
   with the mandate contents carried by the MCP flow. Our mandate is *semantically*
   equivalent (bounded, expiring, nonce-protected authorization) but is **not**
   wire-compatible with HSP.
2. **Escrow ≠ HSP settlement.** HSP settles by immediate direct transfer; our
   `A2AEscrow` holds funds until delivery proof (with refund after expiry). This is
   a deliberate **extension for task-based A2A** (pay-on-delivery), not HSP's own
   flow. The pitch must frame it that way — never claim escrow is how HSP works.
3. **Integration surface.** The official agent integration is the **MCP server
   (Rail A)**, not a REST API + self-hosted gateway. Our `HspGateway` adapter is
   the right seam, but today it only implements the self-hosted mode.

**Adjustments queued for Phase 2b (no agent-interface changes):**
- Add an **HSP-MCP mode** to `HspGateway`: connect to `https://mcp-qa.hashkeymerchant.com/`,
  run `get_chain_config` → `create_order` → `prepare_payment`, apply the existing
  policy checks to the returned typed data (payee, amount vs caps, token/domain,
  validity window), sign with the buyer wallet, `finalize_payment` →
  `submit_payment` → poll `query_payment`. Rail: chain 133 + sandbox USDC
  `0x8FE3…53c6` first.
- Record the HSP `flow_id` in our settlement receipt (AgentSettle's receipt
  carries `hspPaymentId`; mirror that field) so one receipt links both rails.
- Keep the escrow gateway as the "delivery-gated" mode; demo shows both:
  direct settlement via HSP MCP, and escrow settlement for deliverable-based tasks.
- REST Rail B stays deferred: only if judging requires it, and only with givi's
  org data + a generated merchant keypair (public key only leaves this machine).

### 7.4 Testnet faucet — official one exists for chain 133, but is captcha-gated

- Official docs (docs.hskchain.net → Tools/Faucet, read live this session) name
  **`faucet.hsk.xyz`** as the HSKChain Testnet Faucet. It redirects to
  `https://faucet.hskchain.net/faucet`; API at `https://faucet-api.hashkeychain.net`.
- The faucet's JS bundle references **chain ID 133** (the current testnet — not the
  discarded 230315) and the drip call is
  `POST /api/faucet/drip` with body `{ token: <reCAPTCHA token>, address }`.
- **Claiming requires a Google reCAPTCHA v2 token** (site key in the page config),
  i.e. a real browser interaction. This session has no live-browser capability, and
  programmatic captcha bypass would be a grey route → **not attempted**.
- Fallback in the same docs page: bridge Sepolia WETH → testnet HSK. The project
  wallet holds **0 Sepolia ETH** (checked this session), and Sepolia faucets are
  likewise captcha-gated, so this route is equally blocked from here.
- State at end of Phase 2a: testnet RPC live (chainId 0x85 = 133 ✓), project
  wallet testnet balance **0 HSK** → **no testnet deploy/demo could run this
  session**. Toolchain (forge/cast in `~/.foundry/bin`), contracts, deploy script
  and agent CLIs are ready; the moment the wallet is funded, the deploy + e2e run
  is a single scripted pass.
- **Unblock options (for parent/givi):** (a) a browser task on givi's Chrome
  claiming faucet.hskchain.net for `0x5c859A2B9436DdcFDee904A78BaF680cac72a4d6`
  (reCAPTCHA is a normal user check there); or (b) givi claims it manually
  (~1 minute); or (c) ask for testnet HSK in the official dev Telegram
  (`t.me/+LBRNQQKVmo83OTg1`, human step).

---

## 8. Phase 2b findings (22 Nov 2026) — MCP probe + HSP-MCP mode implemented

### 8.1 Read-only probe of the QA MCP server — still unreachable from the sandbox

One probe attempt was made this session (a second attempt was not run: the
runtime's approval for the network action timed out, so per instruction the
probe was not retried — a retry needs fresh approval):

```bash
curl -sS -i --max-time 60 -X POST 'https://mcp-qa.hashkeymerchant.com/' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"mandatesettle-probe","version":"0.1.0"}}}'
```

Exact result:

```
curl: (28) Operation timed out after 60002 milliseconds with 0 bytes received
HTTP/1.1 200 Connection Established        <- sandbox egress proxy: tunnel opened
```

So: the hostname resolves (Phase 2a §7.1.4) and the egress proxy establishes
the tunnel, but the origin never sends a single byte within 60 s — the MCP
`initialize` never completed, so `get_chain_config` / `estimate_fee` could
not be called at all. No credentials were sent (none exist for this rail) and
no order/payment was created. This matches Phase 2a's outcome (HTTP 000).
A repeat probe script now ships in the repo for the next attempt from a route
that can hold the session: `app/agent/src/probe-hsp-mcp.mjs`
(`npm run probe:hsp`) — read-only: initialize + tools/list + get_chain_config
only.

### 8.2 HSP-MCP mode implemented in the adapter (app/agent/src/hsp.mjs)

Added alongside the self-hosted mode; **buyer/seller/settle are unchanged**.
New exports: `createMcpHttpTransport` (minimal Streamable-HTTP MCP client:
initialize → session-id → tools/call, JSON or SSE replies, no credentials),
`HspMcpClient` (typed wrappers over all 8 tools, argument names exactly as
the recorded live schemas), `selectHspToken`, `checkTypedData`, `toSignable`,
`buildCartContents`, `maxRawFor`, and `HspMcpGateway.payViaMcp()`:

1. `get_chain_config` → select the chain-133 token (default sandbox USDC
   `0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6`) and require `eip3009`.
2. `create_order { merchant_name, pay_to, cart_mandate: { contents } }` —
   contents built from the config (x402 method, USD amounts, cart expiry);
   `merchant_authorization` is never sent (server signs it). → `flow_id`.
3. `get_order { flow_id }`.
4. `prepare_payment { flow_id, payer, protocol: "eip3009" }` → EIP-712 typed
   data + `payment_payload` + `payment_mandate_contents` + `cart_hash`.
5. **Local checks before signing** (the discipline that matters): buyer
   per-tx spend cap, then `checkTypedData` — EIP-3009 struct field-for-field;
   domain = the token's own domain cross-checked against this session's
   `get_chain_config` (for the sandbox USDC: name `"USD Coin"`, version `"2"`,
   chainId 133, verifyingContract = the token address); `from` = payer,
   `to` = confirmed pay_to; `message.value` = `token_total_raw` ≤ price +
   10% fee slack and ≤ spend cap; validity window ≤ 1 h; nonce is bytes32.
   Any complaint aborts the flow before a signature exists.
6. Payer signs **exactly** the returned typed data (EIP-3009
   `TransferWithAuthorization`) with its wallet; the key never leaves the
   process.
7. `finalize_payment { signature, payment_payload, payment_mandate_contents,
   cart_hash }` (the three prepare values passed back unchanged) →
   `submit_payment { payment_mandate_json }` (gateway broadcasts; payer is
   gasless) → `query_payment { flow_id, expected_merchant_name }` polled
   every 15 s until `payment-safe` / `payment-finalized` / `payment-failed`;
   past 10 min the receipt reports `payment-pending-confirmation` with the
   flow_id for resumption (not a failure).
8. The returned **receipt records the HSP `flow_id`** (plus payment_request_id,
   payment_hash, cart_hash, tx_signature, attribution flag) — one receipt can
   link the HSP rail and the escrow rail, mirroring AgentSettle's
   `hspPaymentId` practice.

Schema sources: the Mumbai winner's **public** repo
(`0xultravioleta/agentsettle-hsk`: `src/rails/hsp-mcp.ts`,
`src/rails/hsp-merchant.ts`, `test/fake-hsp-mcp.ts`, and the recorded
fixtures in `test/fixtures/hsp-mcp/`) was **read and reviewed only — none of
their code was executed or copied**; the implementation here is an
independent rewrite in this project's idioms. The recorded
`get_chain_config` fixture independently confirms the task's stated values:
chain 133 USDC `0x8FE3…53c6`, name "USD Coin", version "2", `eip3009`.

### 8.3 Tests (offline, mock transport) — 8/8 pass

`app/agent/test/hsp-mcp.test.mjs` (`cd app/agent && npm test`) drives the
full flow against an in-memory mock MCP transport shaped by the recorded
fixtures (the mock's `finalize_payment` verifies the payer signature
server-side, like the real gateway):

- full flow completes in the exact tool order; receipt carries `flow_id`,
  `payment-finalized`, tx hash, attribution;
- the produced EIP-3009 payload is structurally exact (domain `"USD Coin"`
  v2 / chain 133 / token contract; struct fields in order; bytes32 nonce)
  and **signature recovery over it returns the payer address**;
- tampered payee, over-cap `token_total_raw` (+50%), and wrong domain name
  each abort the flow **before** `finalize_payment` — no signature is made;
- the buyer per-tx cap refuses before `create_order` is even called;
- `selectHspToken` refuses the permit2 USDT for the eip3009 rail.

### 8.4 Honest framing (binding for README/pitch)

- Settlement via the HSP MCP server is **the official HSP rail**: a direct
  EIP-3009 transfer executed by HSP's gateway. That is how HSP settles.
- Our on-chain **escrow** (delivery-gated release, expiry refund) is
  **MandateSettle's own additional safeguard extension** for task-based A2A
  payments — it is **not** HSP's built-in flow and must never be described
  as such.
- The live MCP rail is **not yet exercised end-to-end**: the QA server is
  unreachable from this sandbox (§8.1) and the flow is proven against a
  fixture-shaped mock only. First live run needs (a) a route that can hold
  an MCP session to mcp-qa.hashkeymerchant.com and (b) testnet USDC in the
  payer wallet.
