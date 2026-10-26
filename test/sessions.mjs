import { loadToken, BASE } from '../src/client.mjs';

const authorization = await loadToken();
const H = {
  authorization,
  'content-type': 'application/json',
  'x-client-bundle-id': 'com.deepseek.chat',
  'x-client-version': '2.7.0',
  'x-client-platform': 'web',
  'x-client-locale': 'zh_CN',
  origin: BASE,
  referer: BASE + '/',
};

// Try the shapes a fetch_page call might take.
const attempts = [
  ['POST', '/api/v0/chat_session/fetch_page', { count: 5 }],
  ['POST', '/api/v0/chat_session/fetch_page', { count: 5, page_token: null }],
  ['GET', '/api/v0/chat_session/fetch_page?count=5', null],
  ['POST', '/api/v0/chat_session/fetch_page', {}],
];

for (const [method, path, body] of attempts) {
  const res = await fetch(BASE + path, {
    method,
    headers: H,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const t = await res.text();
  console.log(`${method} ${path} ${JSON.stringify(body)} -> HTTP ${res.status}: ${t.slice(0, 400)}`);
}
