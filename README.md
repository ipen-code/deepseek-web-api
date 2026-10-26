# deepseek-web-api

Talk to `chat.deepseek.com` through **your own logged-in web session** — from Node, with no browser window open at run time, and no per-token billing.

```
$ node test/smoke.mjs
first token @1183ms
text: 底层直连成功，没有打开任何页面。
```

## 为什么

网页端和 API 端是两套完全不同的东西：

| | 网页端 | platform.deepseek.com API |
| --- | --- | --- |
| 计费 | 账号订阅 / 免费额度 | 按 token 计费 |
| 鉴权 | `userToken`（localStorage）+ PoW | `sk-` key |
| 反爬 | `DeepSeekHashV1` 工作量证明 | 无 |
| 可用性 | 你自己的账号 | 每个 key 的配额 |

很多"想批量问几句"的场景用网页额度就够了，却因为拿不到 API key 或者不想花钱而做不了。这个库把网页端那层壳剥掉，只留下 HTTP + PoW。

## 它不是什么

- 不是绕过计费的破解。它用的就是**你自己账号**的额度，和你在浏览器里打字完全等价。
- 不是共享账号池。token 存在本机，不上传。
- 不适合当生产 API。网页端有限速，并发上限约 2。

## 快速开始

```bash
npm install

# 1. 让桥接浏览器处于已登录状态（见下"登录态"），然后抓 token
node tools/capture-token.mjs

# 2. 验证通道
node test/smoke.mjs

# 3. 问一句
node test/stream.mjs
```

## 用法

```js
import { loadToken, complete } from './src/client.mjs';

const r = await complete({
  prompt: '用三句话解释可辨识性。',
  thinking: true,        // 深度思考
  refFileIds: [],        // 附件（file- 前缀）
});

console.log(r.text);       // 正文
console.log(r.reasoning);  // 思考过程（thinking 开启时）
console.log(r.tokens, r.powMs, r.elapsedMs, r.sessionId);
```

带附件：

```js
import { uploadFile } from './src/files.mjs';

const authorization = await loadToken();
const file = await uploadFile('./paper.tex', { authorization });
// file.id === 'file-…'  ← 必须保留 file- 前缀，否则服务端返回 422

const r = await complete({
  prompt: '这份稿子的主要问题是什么？',
  refFileIds: [file.id],
});
```

## MCP 服务器

`index.mjs` 是一个 stdio MCP server，把它接进任何 MCP 客户端即可：

```json
{
  "mcpServers": {
    "deepseek-web": {
      "command": "node",
      "args": ["D:/path/to/deepseek-web-api/index.mjs"]
    }
  }
}
```

工具：

| 工具 | 作用 |
| --- | --- |
| `ask` | 发一条消息；可带 `files` 路径做真附件 |
| `upload_file` | 上传文件，拿 `file-` id |
| `ask_with_files` | 按路径或 id 附文件并追问 |
| `paper_review` | 上传论文一次 → 多路评审 → 8 维度评分 → 合并报告 |
| `new_chat` | 开一个新会话 |
| `list_sessions` | 列最近会话 |
| `status` | 检查 token 与账号 |
| `pow_selftest` | 跑一次 PoW，站点改版后第一时间发现 |

## 论文评审 Skills：`paper-review-deepseek`

`skills/paper-review-deepseek/` 是自包含的：把整个目录拷到任何地方都能跑，不需要另外 clone 这个仓库（已实测：复制到临时目录后独立运行，exit=0）。

它实现一个循环：**发文件 → 要意见 → 你判断 → 可改则改、不可改则弃 → 改完再问。**

```bash
# 要一个分数
node skills/paper-review-deepseek/tools/ask-paper.mjs paper.tex

# 换观察角度（附件只上传一次，串行问多条）
node skills/paper-review-deepseek/tools/ask-paper.mjs paper.tex --lens reject-tie,selfdeceive

# 问完让它自己交代哪些没核实（第二轮，同一会话）
node skills/paper-review-deepseek/tools/ask-paper.mjs paper.tex --lens sweep --follow verify
```

提问是**写死的常量**，上限 50 字，没有 `--question` 开关——换问法等于换尺子。内置 17 条镜头（`sweep`、`reject-tie`、`selfdeceive`、`boundary`、`next`、`top` …）和 4 条追问（`verify`、`evidence`、`strongest`、`counter`），每条都不超过 50 字。

**关于分数，一件必须说清楚的事：** 同一份未改动的稿子，在四组实验里拿到 **5.46 / 7.5 / 8.2 / 8.5**。所以工具不把分数平均成结论，而是并排显示让不稳定性可见，真正的工作放在"哪些抱怨反复出现"上。**用镜头找问题，不用镜头定分。**

**关于问法，一件有 ground truth 支撑的事：** 拿一篇稿子自己通读全文、列出 6 条可逐条核对的真实缺陷，再给各种问法判分——`sweep` + `reject-tie` **2 次调用就覆盖 6/6**，而 4 条镜头 × 2 次重复要 8 次才到 6/6。所以菜单不是越长越好；想省调用，就先用这两条。

详见 [SKILL.md](skills/paper-review-deepseek/SKILL.md)。多路 persona 评审（`tools/review-paper.mjs`）作为可选方案保留，但日常改稿用单路循环更省判断成本。

## 登录态

token 来自浏览器的 `localStorage['userToken']`。`tools/capture-token.mjs` 通过 Chrome 调试端口读取，**只读不写、只 detach 不关窗**：

```bash
# 桥接浏览器需要在调试端口上（默认 9333）
node tools/capture-token.mjs
# token captured len=64 -> ~/.dsh/deepseek-web/token.json
# verify /users/current -> HTTP 200 code=0
```

token 过期时（`status` 报 40002/40003）重新登录网页端再跑一次即可。也可以用 `DS_WEB_TOKEN` 环境变量直接注入。

## PoW 是怎么解的

`POST /api/v0/chat/completion` 要求 `x-ds-pow-response` 头，内容是：

```json
{"algorithm":"DeepSeekHashV1","challenge":"…","salt":"…","answer":69369,
 "signature":"…","target_path":"/api/v0/chat/completion"}
```

其中 `answer` 必须满足

```
challenge === sha3_256(`${salt}_${expireAt}_${answer}`)`,  answer ∈ [0, difficulty)
```

难点在于：这里的 `sha3_256` **不是标准 SHA3-256**，而是站点自己实现的一套 Keccak sponge 变体。在 Node 里用 `crypto` 复现会全部失败——这不是拼装串写错了，是哈希函数本身不同。

所以本项目**直接执行站点自己的 wasm**（`wasm/sha3_wasm_bg.wasm`，26612 字节）：

```js
const { instance } = await WebAssembly.instantiate(bytes, { wbg: {} });
// wasm_solve(ret_ptr, challenge_ptr, challenge_len, prefix_ptr, prefix_len, difficulty)
// → DataView.getInt32(ret_ptr, true)  非 0 表示成功
// → DataView.getFloat64(ret_ptr + 8, true)  答案
```

一个 challenge 通常 10–50ms 就能解出来。详见 `src/pow.mjs`。

## 目录

```
src/
  client.mjs     HTTP 客户端、SSE reducer、会话管理
  pow.mjs        PoW 求解（wasm）
  files.mjs      文件上传与解析状态
  rubric.mjs     8 维度评分卡：定义、解析、聚合、渲染
tools/
  capture-token.mjs   从浏览器读 token
  review-tex.mjs      （旧版）把 tex 粘进 prompt 的评审 CLI
index.mjs        MCP 服务器
wasm/
  sha3_wasm_bg.wasm
test/            端到端与探针脚本
skills/
  paper-review-deepseek/   论文评审 Skills 包（自包含，可直接拷走）
    core/                  vendored 直连客户端（client/files/pow）
    wasm/                  PoW 用的哈希器
    src/lenses.mjs         16 条镜头 + 长度校验 + 定位符抽取
    tools/ask-paper.mjs    主入口
```

## 已知限制

| 限制 | 说明 |
| --- | --- |
| 并发 ≈ 2 | 第 3 路会静默返回空流。所有并行逻辑都要限流 + 重试 |
| 首个 token 可能 >120s | 深度思考 + 联网搜索同时开时尤其明显 |
| 附件要 `file-` 前缀 | 去掉前缀 → HTTP 422 空 body |
| wasm 会变 | 站点换哈希实现就得重新取 `sha3_wasm_bg.wasm`；`pow_selftest` 会暴露 |
| SSE 的 `-1` | 指"最后新增的 fragment"，不是 message id。按 type 重组，不要猜 |

## 合规

只用于你自己的账号、你自己的机器。不要把 token 提交进仓库或分享给别人——那等于分享账号。本项目不含任何凭据。
