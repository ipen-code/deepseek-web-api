import { complete } from '../src/client.mjs';

const t0 = Date.now();
let firstDeltaAt = null;
const r = await complete({
  prompt: '请只回复这一句话：底层直连成功，没有打开任何页面。',
  thinking: false,
  search: false,
  onDelta: (d, full) => {
    if (firstDeltaAt == null) {
      firstDeltaAt = Date.now() - t0;
      console.log(`[first token @${firstDeltaAt}ms]`);
    }
    process.stdout.write(d);
  },
});
console.log('\n---');
console.log('elapsed', r.elapsedMs, 'ms  sessionId', r.sessionId, ' msgId', r.messageId);
console.log('len', r.text.length);
console.log('text:', JSON.stringify(r.text.slice(0, 300)));
