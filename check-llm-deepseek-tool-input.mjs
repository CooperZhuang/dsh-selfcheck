// Regression check for the local dsh-llm-deepseek patch: a tool call whose streamed
// input is not a JSON object must not abort the turn.
//
// Serves a synthetic Messages SSE stream from a local HTTP server and drives the real
// DeepSeekAdapter, so this exercises the shipped code path (the strictness lives in
// lib/index.js, message_stop validation). No live model and no network are involved.
//
// Usage: node check-llm-deepseek-tool-input.mjs
//   exit 0 -> patched (tolerated)
//   exit 1 -> UNPATCHED: re-apply the patch, e.g. after a dsh reinstall/upgrade
//
// Upstream report: https://github.com/deepseek-ai/deepseek-harness/discussions/7581
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Locate the dsh-llm-deepseek build the *running* DSH loads.
 *
 * Hardcoding an npx cache directory broke this check the moment DSH changed
 * channels (`@alpha` -> `@next` runs from a different `_npx/<hash>` dir), so the
 * entry is discovered instead:
 *   1. argv[2] or $DSH_LLM_DEEPSEEK_ENTRY, when given explicitly;
 *   2. otherwise the npx install whose `node_modules/.package-lock.json` was
 *      written last - npx rewrites it whenever it (re)installs, and the newest
 *      one is the install the host was launched from.
 */
function resolveEntry() {
  const explicit = process.argv[2] ?? process.env.DSH_LLM_DEEPSEEK_ENTRY;
  if (explicit !== undefined && explicit !== '') return explicit;
  const npxRoot = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'npm-cache', '_npx');
  const candidates = fs
    .readdirSync(npxRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dir = path.join(npxRoot, e.name);
      const entry = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh-llm-deepseek', 'lib', 'index.js');
      if (!fs.existsSync(entry)) return null;
      let installedAt = 0;
      try { installedAt = fs.statSync(path.join(dir, 'node_modules', '.package-lock.json')).mtimeMs; } catch { /* no lock: keep 0 */ }
      return { entry, installedAt };
    })
    .filter(Boolean)
    .sort((a, b) => b.installedAt - a.installedAt);
  if (candidates.length === 0) throw new Error(`no dsh-llm-deepseek build found under ${npxRoot}`);
  return candidates[0].entry;
}

const PKG = resolveEntry();
const pkgRoot = path.dirname(path.dirname(PKG));
console.log(`target          : ${PKG}`);
console.log(`package version : ${JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')).version}\n`);
const mod = await import(pathToFileURL(PKG).href);

const sse = (...events) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
const open = () => ({ type: 'message_start', message: { usage: { input_tokens: 10 } } });
const blockStartTool = (id, name) => ({
  type: 'content_block_start',
  index: 0,
  content_block: { type: 'tool_use', id, name, input: {} },
});
const jsonDelta = (partial) => ({
  type: 'content_block_delta',
  index: 0,
  delta: { type: 'input_json_delta', partial_json: partial },
});
const stopBlock = { type: 'content_block_stop', index: 0 };
const messageDelta = (stopReason) => ({
  type: 'message_delta',
  delta: { stop_reason: stopReason },
  usage: { output_tokens: 20 },
});

// The shape that killed the 2026-09-23 calendar turn: ASCII double quotes inside a
// JSON string value, split across two streamed deltas.
const MALFORMED_HEAD = '{"questions": [{"description": "相当于回到"';
const MALFORMED_TAIL = '什么都不设"的原厂行为。"}]}';

const cases = [
  {
    name: 'malformed tool input (raw ASCII quotes)',
    mustTolerate: true,
    frames: sse(
      open(),
      blockStartTool('call_1', 'ask_user_question'),
      jsonDelta(MALFORMED_HEAD),
      jsonDelta(MALFORMED_TAIL),
      stopBlock,
      messageDelta('tool_use'),
      { type: 'message_stop' },
    ),
  },
  {
    name: 'valid JSON but not an object (array)',
    mustTolerate: true,
    frames: sse(
      open(),
      blockStartTool('call_2', 'ask_user_question'),
      jsonDelta('["not", "an", "object"]'),
      stopBlock,
      messageDelta('tool_use'),
      { type: 'message_stop' },
    ),
  },
  {
    name: 'valid tool input (control)',
    mustTolerate: false,
    frames: sse(
      open(),
      blockStartTool('call_3', 'ask_user_question'),
      jsonDelta('{"questions": []}'),
      stopBlock,
      messageDelta('tool_use'),
      { type: 'message_stop' },
    ),
  },
  {
    name: 'truncated tool input under max_tokens',
    mustTolerate: false,
    frames: sse(
      open(),
      blockStartTool('call_4', 'ask_user_question'),
      jsonDelta('{"questions": [{"description": "cut off'),
      stopBlock,
      messageDelta('max_tokens'),
      { type: 'message_stop' },
    ),
  },
];

let current = cases[0];
const server = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(current.frames);
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const resolved = mod.resolveAdapterOptions(
  mod.plainOptions({ baseURL: `http://127.0.0.1:${port}`, models: [{ id: 'deepseek-flash', name: 'Flash' }] }),
  undefined,
);
if (resolved.baseURL !== `http://127.0.0.1:${port}`) {
  throw new Error(`adapter ignored the local baseURL (got ${resolved.baseURL}) - the check would hit the real API`);
}

const adapter = new mod.DeepSeekAdapter({
  options: () => resolved,
  // 0.1.7-rc.1 起凭据契约从 resolveApiKey/resolveAccountToken 换成 resolveAuth(connection) -> { headers }。
  // 两个形状同时给上，脚本在 alpha / rc 两个通道上都能跑。
  resolveAuth: async () => ({ headers: { 'x-api-key': 'test-key', authorization: 'Bearer test-key' } }),
  resolveApiKey: async () => 'test-key',
  resolveAccountToken: async () => undefined,
  resolveUserId: () => 'regression-check',
  resolveAttachments: () => undefined,
  resolveImageAccess: () => undefined,
  prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
  resolveFiles: () => ({ retry: async () => false, errorMessage: (_status, message) => message }),
});

const history = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
let failures = 0;

for (const testCase of cases) {
  current = testCase;
  const seen = [];
  let failure;
  try {
    for await (const event of adapter.stream({ provider: 'deepseek-official', model: 'deepseek-flash', messages: history })) {
      seen.push(event.type === 'block-end' ? `block-end(${event.block.arguments.length}b args)` : event.type);
    }
  } catch (error) {
    failure = `${error.code ?? error.name}: ${error.message}`;
  }
  const bad = failure !== undefined;
  if (bad) failures++;
  console.log(`${bad ? 'FAIL' : 'ok  '}  ${testCase.name}`);
  console.log(`      events: ${seen.join(' -> ') || '(none)'}`);
  if (bad) console.log(`      error : ${failure}`);
}

server.close();

if (failures > 0) {
  console.log(`\n${failures} case(s) failed: the adapter still treats unusable tool input as fatal.`);
  console.log('Re-apply the patch in @deepseek-ai/dsh-llm-deepseek/lib/index.js (see the report link above).');
  process.exit(1);
}
console.log('\nAll cases tolerated: patch is in place.');
