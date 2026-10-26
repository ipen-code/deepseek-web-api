import { complete } from '../src/client.mjs';

const mk = (i) => complete({ prompt: `Reply with exactly the two characters: R${i}` });

for (const n of [2, 2, 3]) {
  const t0 = Date.now();
  const rs = await Promise.all(Array.from({ length: n }, (_, i) => mk(i + 1).catch((e) => ({ err: e.message }))));
  console.log(`\n--- n=${n} wall=${Date.now() - t0}ms ---`);
  rs.forEach((r, i) =>
    console.log(
      `  #${i + 1} text=${JSON.stringify(r.text)} status=${r.status} tokens=${r.tokens} ` +
        `msgId=${r.messageId} ${r.err ? 'ERR ' + r.err : ''}`
    )
  );
}
