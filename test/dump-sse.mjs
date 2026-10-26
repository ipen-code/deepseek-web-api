import { loadToken, BASE } from '../src/client.mjs';
import { solveChallenge, powHeader } from '../src/pow.mjs';

const authorization = await loadToken();
const CLIENT = {
  'x-client-bundle-id': 'com.deepseek.chat',
  'x-client-version': '2.7.0',
  'x-client-platform': 'web',
  'x-client-locale': 'zh_CN',
  'x-client-timezone-offset': '28800',
};
const H = { ...CLIENT, 'content-type': 'application/json', origin: BASE, referer: BASE + '/' };

const ch = await (await fetch(BASE + '/api/v0/chat/create_pow_challenge', {
  method: 'POST', headers: { ...H, authorization }, body: JSON.stringify({ target_path: '/api/v0/chat/completion' }),
})).json();
const challenge = ch.data.biz_data.challenge;
const { answer } = await solveChallenge(challenge);

const sess = await (await fetch(BASE + '/api/v0/chat_session/create', {
  method: 'POST', headers: { ...H, authorization }, body: '{}',
})).json();
const sid = sess.data.biz_data.chat_session.id;

const res = await fetch(BASE + '/api/v0/chat/completion', {
  method: 'POST',
  headers: { ...H, authorization, accept: 'text/event-stream', 'x-ds-pow-response': powHeader(challenge, answer, '/api/v0/chat/completion') },
  body: JSON.stringify({
    chat_session_id: sid, parent_message_id: null, model_type: null, prompt: 'say exactly: OK',
    ref_file_ids: [], thinking_enabled: false, search_enabled: false, action: null, preempt: false,
  }),
});
console.log('HTTP', res.status, res.headers.get('content-type'));
const text = await res.text();
console.log('--- RAW (first 4000 chars) ---');
console.log(text.slice(0, 4000));
console.log('--- total chars:', text.length);
