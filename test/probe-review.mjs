import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'D:\\Program Files\\nodejs\\node.exe',
  args: ['D:\\ipen\\Documents\\deepseek-web-api\\index.mjs'],
  cwd: 'D:\\ipen\\Documents\\deepseek-web-api',
});

const client = new Client({ name: 'probe', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);

const t0 = Date.now();
const r = await client.callTool(
  {
    name: 'paper_review',
    arguments: {
      texPath: 'C:\\Users\\ipen\\Desktop\\PCM温控仿真\\论文\\V3.8\\TIE_V3.8_main.tex',
      outPath: 'D:\\ipen\\Documents\\deepseek-web-api\\out\\TIE-V3.8-review.md',
      personas: 5,
      concurrency: 2,
    },
  },
  undefined,
  { timeout: 900000 }
);

console.log(`isError=${r.isError ?? false}  wall=${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(r.content?.find((c) => c.type === 'text')?.text ?? '');

await client.close();
