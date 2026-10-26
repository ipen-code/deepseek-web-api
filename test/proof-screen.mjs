import { createRequire } from 'node:module';
const require = createRequire('C:/Users/ipen/.dsh/profiles/desktop/package.json');
const puppeteer = require('puppeteer-core');

const OUT = 'D:\\ipen\\Documents\\deepseek-web-api\\proof';
import { mkdir } from 'node:fs/promises';
await mkdir(OUT, { recursive: true });

const b = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9333', defaultViewport: null });
const pages = await b.pages();
const p = pages.find((x) => x.url().includes('deepseek.com')) ?? (await b.newPage());

// Force a reload so the sidebar pulls fresh history from the server.
// NOTE: never use networkidle here — the app holds an open SSE/websocket and it never settles.
await p.goto('https://chat.deepseek.com/a/chat/s/721cf245-95a9-4250-bb5b-a9d864e74eb6', {
  waitUntil: 'domcontentloaded',
  timeout: 60000,
});
await new Promise((r) => setTimeout(r, 6000));

const info = await p.evaluate(() => ({
  url: location.href,
  title: document.title,
  bodyLen: document.body.innerText.length,
}));
console.log('page:', JSON.stringify(info));

await p.screenshot({ path: `${OUT}\\1-mcp-ok-session.png` });
console.log(`wrote ${OUT}\\1-mcp-ok-session.png`);

// Also show the sidebar with recent conversations.
const item = await p.$('textarea, div[contenteditable="true"]');
if (item) {
  await item.click();
  await new Promise((r) => setTimeout(r, 800));
}
await p.screenshot({ path: `${OUT}\\2-after-click.png` });
console.log(`wrote ${OUT}\\2-after-click.png`);

// Dump what the sidebar actually lists, straight from the DOM.
const sidebar = await p.evaluate(() => {
  const rows = [...document.querySelectorAll('a[href*="/a/chat/s/"], [class*="chat-item"], [class*="session"]')];
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const t = (r.innerText || '').trim().split('\n')[0];
    const href = r.getAttribute?.('href') || '';
    const key = `${t}|${href}`;
    if (t && !seen.has(key)) {
      seen.add(key);
      out.push({ t, href });
    }
  }
  return out.slice(0, 30);
});
console.log('\nSIDEBAR DOM:');
for (const s of sidebar) console.log(`  "${s.t}"  ${s.href}`);

await b.disconnect();
