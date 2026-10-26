import { readFile } from 'node:fs/promises';
import { complete } from '../src/client.mjs';

const tex = await readFile('C:/Users/ipen/Desktop/PCM温控仿真/论文/V3.8/TIE_V3.8_main.tex', 'utf8');
console.log(`tex chars=${tex.length}  ~tokens(est)=${Math.round(tex.length / 3.5)}`);

const t0 = Date.now();
const r = await complete({
  prompt:
    '下面是论文的 LaTeX 源码。请用一句话概括它的核心主张，然后指出你认为最严重的一个问题。\n\n' +
    tex,
  thinking: false,
  search: false,
});

console.log(`elapsed=${r.elapsedMs}ms tokens=${r.tokens} status=${r.status} textLen=${r.text.length}`);
console.log('---');
console.log(r.text.slice(0, 1500));
