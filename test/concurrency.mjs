import { complete } from '../src/client.mjs';

// Can the web backend serve several concurrent conversations on one token?
const prompts = [
  'Reply with exactly: R1',
  'Reply with exactly: R2',
  'Reply with exactly: R3',
  'Reply with exactly: R4',
];

const t0 = Date.now();
const rs = await Promise.all(
  prompts.map((p) =>
    complete({ prompt: p }).catch((e) => ({ text: `ERR ${e.message}`, elapsedMs: Date.now() - t0 }))
  )
);
console.log(`wall=${Date.now() - t0}ms`);
rs.forEach((r, i) => console.log(`  ${i + 1}: ${JSON.stringify(r.text)} (${r.elapsedMs}ms)`));
