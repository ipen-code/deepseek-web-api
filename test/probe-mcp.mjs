import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['D:\\ipen\\Documents\\deepseek-web-api\\index.mjs'],
  cwd: 'D:\\ipen\\Documents\\deepseek-web-api',
  env: { ...process.env },
});
const client = new Client({ name: 'probe', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);

const { tools } = await client.listTools();
console.log('TOOLS:', tools.map((t) => t.name).join(', '));

const call = async (name, args = {}) => {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const body = r.content?.filter((c) => c.type === 'text').map((c) => c.text).join('\n') ?? '';
  console.log(`\n=== ${name} (${Date.now() - t0}ms) isError=${!!r.isError} ===`);
  console.log(body.slice(0, 800));
  return r;
};

await call('status');
await call('pow_selftest');
await call('new_chat');
await call('ask', { prompt: 'Reply with exactly: MCP OK' });
await call('ask', { prompt: 'What is 13*17? Number only.', thinking: true, includeReasoning: true });
await call('list_sessions', { count: 3 });

await client.close();
