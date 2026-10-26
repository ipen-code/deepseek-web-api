import { complete } from '../src/client.mjs';

const cases = [
  { name: 'long-stream', prompt: 'Count from 1 to 30, one number per line, nothing else.', thinking: false },
  { name: 'thinking', prompt: 'What is 17*23? Answer with the number only.', thinking: true },
];

for (const c of cases) {
  let deltas = 0;
  const t0 = Date.now();
  const r = await complete({
    prompt: c.prompt,
    thinking: c.thinking,
    search: false,
    onDelta: () => { deltas += 1; },
    onReasoning: () => {},
  });
  console.log(
    `${c.name.padEnd(12)} ms=${String(r.elapsedMs).padStart(6)} deltas=${String(deltas).padStart(4)} ` +
      `len=${String(r.text.length).padStart(4)} reasoning=${String(r.reasoning.length).padStart(5)} ` +
      `status=${r.status} tokens=${r.tokens} powMs=${r.powMs}`
  );
  console.log(`  text: ${JSON.stringify(r.text.slice(0, 160))}`);
  if (r.reasoning) console.log(`  reasoning: ${JSON.stringify(r.reasoning.slice(0, 160))}`);
}
