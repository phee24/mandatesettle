// Read-only probe of the HSP Agentic Payment MCP server (QA).
//   node src/probe-hsp-mcp.mjs
// Performs ONLY: MCP initialize, tools/list, and the read-only tool
// get_chain_config. It never creates an order and never signs or submits a
// payment. No credentials exist for this rail and none are sent.
// Override the endpoint with HSP_MCP_URL.
import { createMcpHttpTransport, HSP_MCP_QA_URL, HSP_MCP_TOOLS } from './hsp.mjs';

const url = process.env.HSP_MCP_URL ?? HSP_MCP_QA_URL;
const transport = createMcpHttpTransport(url, { timeoutMs: 30_000 });

try {
  const init = await transport.connect();
  console.log('initialize ->', JSON.stringify(init?.serverInfo ?? init, null, 2));
  const tools = await transport.listTools();
  console.log('tools ->', tools.join(', '));
  const missing = HSP_MCP_TOOLS.filter((t) => !tools.includes(t));
  if (missing.length) console.log('MISSING tools:', missing.join(', '));
  const cfg = await transport.call('get_chain_config', {});
  console.log('get_chain_config ->');
  console.log(JSON.stringify(cfg, null, 2));
} finally {
  await transport.close();
}
