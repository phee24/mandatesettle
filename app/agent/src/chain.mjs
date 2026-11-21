// Chain configuration + wallet loading for the MandateSettle agents.
// Private keys are loaded from env vars or from the project wallet file and
// are NEVER printed. The project wallet file lives outside the app tree at
// a local cast-wallet JSON file (mode 600), path via PROJECT_WALLET_FILE.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const hskTestnet = defineChain({
  id: 133,
  name: 'HashKey Chain Testnet',
  nativeCurrency: { name: 'HSK', symbol: 'HSK', decimals: 18 },
  rpcUrls: { default: { http: ['https://testnet.hsk.xyz'] } },
  blockExplorers: { default: { name: 'HSK Testnet Explorer', url: 'https://testnet-explorer.hskchain.net' } },
});

export const hskMainnet = defineChain({
  id: 177,
  name: 'HashKey Chain',
  nativeCurrency: { name: 'HSK', symbol: 'HSK', decimals: 18 },
  rpcUrls: { default: { http: ['https://mainnet.hsk.xyz'] } },
  blockExplorers: { default: { name: 'HSK Explorer', url: 'https://explorer.hsk.xyz' } },
});

export const NETWORKS = {
  testnet: hskTestnet,
  mainnet: hskMainnet,
  local: {
    id: 31337,
    name: 'Anvil (local)',
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } },
  },
};

export function networkFromEnv() {
  const name = process.env.HSK_NETWORK ?? 'testnet';
  const chain = NETWORKS[name];
  if (!chain) throw new Error(`Unknown HSK_NETWORK "${name}" (testnet|mainnet|local)`);
  const rpcUrl = process.env.RPC_URL ?? chain.rpcUrls.default.http[0];
  return { name, chain, rpcUrl };
}

/** Extract a 0x-prefixed 32-byte private key from the cast-wallet JSON file
 *  without ever logging it. */
export function loadProjectWalletAccount() {
  const path =
    process.env.PROJECT_WALLET_FILE ?? join(homedir(), '.mandatesettle', 'wallet.json');
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const entry = Array.isArray(data?.data) ? data.data[0] : data;
  const pk = entry?.private_key ?? entry?.privateKey;
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error('Project wallet file has no usable key');
  return privateKeyToAccount(pk);
}

export function accountFromEnv(envName) {
  const pk = process.env[envName];
  if (!pk) throw new Error(`Missing env ${envName}`);
  return privateKeyToAccount(pk);
}

export function explorerTx(chain, hash) {
  const base = chain?.blockExplorers?.default?.url;
  return base ? `${base}/tx/${hash}` : hash;
}

export function explorerAddress(chain, address) {
  const base = chain?.blockExplorers?.default?.url;
  return base ? `${base}/address/${address}` : address;
}
