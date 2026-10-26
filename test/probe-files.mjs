import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'D:\\Program Files\\nodejs\\node.exe',
  args: ['D:\\ipen\\Documents\\deepseek-web-api\\index.mjs'],
  cwd: 'D:\\ipen\\Documents\\deepseek-web-api',
});

const client = new Client({ name: 'probe', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);

const tools = await client.listTools();
console.log('TOOLS:', tools.tools.map((t) => t.name).join(', '));

const show = (r) => {
  const t = r.content?.find((c) => c.type === 'text')?.text ?? '';
  console.log(`isError=${r.isError ?? false}`);
  console.log(t.slice(0, 2000));
};

console.log('\n===== status =====');
show(await client.callTool({ name: 'status', arguments: {} }, undefined, { timeout: 120000 }));

console.log('\n===== upload_file =====');
show(
  await client.callTool(
    {
      name: 'upload_file',
      arguments: { paths: ['C:\\Users\\ipen\\Desktop\\PCM温控仿真\\论文\\V3.8\\TIE_V3.8_main.tex'], verbose: true },
    },
    undefined,
    { timeout: 300000 }
  )
);

await client.close();
