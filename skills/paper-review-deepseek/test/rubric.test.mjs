import {
  DIMENSIONS,
  DIMENSION_IDS,
  parseScores,
  weightedTotal,
  aggregateScores,
  renderScorecard,
  verdictFor,
  SCORE_BLOCK_INSTRUCTION,
} from '../src/rubric.mjs';

console.log('dims:', DIMENSIONS.length, '->', DIMENSION_IDS.join(','));

const replyA = [
  '## 评审',
  '',
  '正文若干意见……',
  '',
  '```score',
  '{"novelty":6,"rigor":5,"method":6,"evidence":4,"reproducibility":5,"writing":7,"fit":7,"robustness":4}',
  '```',
].join('\n');

const replyB = [
  '意见……',
  '',
  '```json',
  '{"novelty":7,"rigor":7,"method":5,"evidence":6,"reproducibility":4,"writing":6,"fit":8,"robustness":6}',
  '```',
].join('\n');

const replyC = '没有分数块的回复。';
const replyD = '尾部裸对象：{"novelty":3,"rigor":3,"method":3,"evidence":3,"reproducibility":3,"writing":3,"fit":3,"robustness":3}';

for (const [name, r] of [['A(score fence)', replyA], ['B(json fence)', replyB], ['C(no block)', replyC], ['D(bare tail)', replyD]]) {
  const s = parseScores(r);
  console.log(`${name}: parsed=${s ? 'yes' : 'null'} total=${s ? weightedTotal(s) : '-'}`);
}

const agg = aggregateScores([
  { title: 'A', scores: parseScores(replyA) },
  { title: 'B', scores: parseScores(replyB) },
  { title: 'C', scores: parseScores(replyC) },
]);
console.log('\nverdictFor(7.2)=', verdictFor(7.2), '| verdictFor(4.9)=', verdictFor(4.9));
console.log('\n' + renderScorecard(agg));
console.log('\n--- SCORE_BLOCK_INSTRUCTION (first 400 chars) ---');
console.log(SCORE_BLOCK_INSTRUCTION.slice(0, 400));
