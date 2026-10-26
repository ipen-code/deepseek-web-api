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

// 1) Who am I
const me = await (await fetch(BASE + '/api/v0/users/current', { headers: H })).json();
const u = me.data?.biz_data ?? {};
console.log('ACCOUNT:', JSON.stringify({ code: me.code, email: u.email, id: u.id, phone: u.mobile_number }, null, 0));

// 2) Recent sessions (GET only)
const list = await (await fetch(BASE + '/api/v0/chat_session/fetch_page?count=15', { headers: H })).json();
const sessions = list.data?.biz_data?.chat_sessions ?? [];
console.log(`\nSESSIONS (${sessions.length}):`);
for (const s of sessions) {
  const when = new Date(s.updated_at * 1000).toISOString().replace('T', ' ').slice(0, 19);
  console.log(`  ${s.id}  ${when}Z  pinned=${s.pinned}  "${s.title}"`);
}

// 3) Read back the actual messages of the newest few we created
const targets = sessions.filter((s) => ['13 times 17', 'MCP OK', 'Ada'].some((t) => (s.title || '').includes(t))).slice(0, 3);
if (!targets.length) targets.push(...sessions.slice(0, 2));

for (const s of targets) {
  console.log(`\n=== messages in ${s.id} ("${s.title}") ===`);
  for (const path of [
    `/api/v0/chat/history_messages?chat_session_id=${s.id}`,
    `/api/v0/chat_session/fetch_messages?chat_session_id=${s.id}`,
  ]) {
    const r = await fetch(BASE + path, { headers: H });
    const t = await r.text();
    if (r.status !== 200) {
      console.log(`  ${path.split('?')[0]} -> HTTP ${r.status}`);
      continue;
    }
    const j = JSON.parse(t);
    const msgs = j.data?.biz_data?.chat_messages ?? [];
    console.log(`  ${path.split('?')[0]} -> ${msgs.length} message(s)`);
    for (const m of msgs) {
      const content = (m.fragments ?? []).map((f) => f.content).join('');
      console.log(`    [${m.role}] ${content.slice(0, 120).replace(/\n/g, ' / ')}`);
    }
    break;
  }
}
