import { loadToken, BASE } from '../src/client.mjs';
import { solveChallenge, powHeader } from '../src/pow.mjs';

const authorization = await loadToken();
const H = {
  'content-type': 'application/json',
  'x-client-bundle-id': 'com.deepseek.chat',
  'x-client-version': '2.7.0',
  'x-client-platform': 'web',
  'x-client-locale': 'zh_CN',
  'x-client-timezone-offset': '28800',
  origin: BASE,
  referer: BASE + '/',
  authorization,
};

const ch = await (await fetch(BASE + '/api/v0/chat/create_pow_challenge', {
  method: 'POST', headers: H, body: JSON.stringify({ target_path: '/api/v0/chat/completion' }),
})).json();
const challenge = ch.data.biz_data.challenge;
const { answer } = await solveChallenge(challenge);
const sess = await (await fetch(BASE + '/api/v0/chat_session/create', { method: 'POST', headers: H, body: '{}' })).json();

const res = await fetch(BASE + '/api/v0/chat/completion', {
  method: 'POST',
  headers: { ...H, accept: 'text/event-stream', 'x-ds-pow-response': powHeader(challenge, answer, '/api/v0/chat/completion') },
  body: JSON.stringify({
    chat_session_id: sess.data.biz_data.chat_session.id,
    parent_message_id: null, model_type: null,
    prompt: 'What is 17*23? Answer with the number only.',
    ref_file_ids: [], thinking_enabled: true, search_enabled: false, action: null, preempt: false,
  }),
});

const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
let n = 0;
while (n < 60) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf('\n\n')) !== -1) {
    const frame = buf.slice(0, i);
    buf = buf.slice(i + 2);
    const line = frame.split('\n').find((l) => l.startsWith('data:'));
    if (!line) continue;
    n += 1;
    console.log(`#${n} ${line.slice(5).trim().slice(0, 700)}`);
    if (n >= 60) break;
  }
}
reader.cancel().catch(() => {});
