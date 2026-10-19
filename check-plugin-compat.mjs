/**
 * DSH 插件兼容自检（对着**当前运行中**的 DSH 安装跑）。
 *
 * 用法：node check-plugin-compat.mjs [dshInstallDir]
 *   exit 0 = 无硬性不兼容；exit 1 = 有需要处理的问题（图标导出缺失且无兜底 / 宿主半边 import 解析不了）
 *
 * 宿主有两套装法，脚本都要认：
 *   1. **目录式**（CLI / pnpm 装出来的）：`…/node_modules/@deepseek-ai/dsh`，
 *      兄弟目录里就是全套内核包，直接读文件系统。
 *   2. **asar 式**（桌面客户端 Electron 应用）：宿主包全在 `app.asar` 里面，
 *      文件系统上看不到 —— 得读 asar 的文件头。PC 上的
 *      "DeepSeek Harness" 就是这一套：客户端半边依赖的
 *      `dsh-client-ui-primitives` 根本不在 CLI 的 npx 树里。
 *
 * 检查项：
 *   1. profile 组合：用 dshmarket 自己的 analyzeProfile 跑一遍 loader 行与错误。
 *   2. 客户端半边：bundle 引用的 `IconXxx*` 是否都还在宿主的 primitives 里导出，
 *      并把「本地别名兜底 / 上游 pickIcon 回落 / 只出现在注释 / 本地自己定义 / 已改用同基名 Regular」
 *      这五种安全情形区分出来（旧版脚本对这些一律误报，会把已修好的插件标红）。
 *   3. 客户端半边：require 的 `@deepseek-ai/*` 客户端模块 id 是否还存在。
 *   4. 宿主半边：`from '@deepseek-ai/...'` 的裸导入是否可解析（按子路径 exports 解析，不靠 /package.json 探针）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const NS = '@deepseek-ai';

/** profile 目录：优先 desktop（桌面客户端用的就是它），否则 web。 */
function resolveProfile() {
  const root = path.join(os.homedir(), '.dsh', 'profiles');
  const named = process.env.DSH_PROFILE;
  const candidates = named ? [named] : ['desktop', 'web'];
  for (const name of candidates) {
    const dir = path.join(root, name);
    if (fs.existsSync(dir)) return dir;
  }
  return path.join(root, candidates[0]);
}
const PROFILE = resolveProfile();

/** 桌面客户端的安装候选：asar 形态（包在 asar 里）与目录形态（app/node_modules 是真目录）。 */
function appCandidates() {
  const out = [];
  if (process.env.DSH_ASAR) out.push({ kind: 'asar', path: process.env.DSH_ASAR });
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  const apps = [
    path.join(local, 'Programs', 'DeepSeek Harness', 'resources'),
    '/Applications/DSH Desktop Beta.app/Contents/Resources',
    '/Applications/DeepSeek Harness.app/Contents/Resources',
  ];
  for (const res of apps) {
    const asar = path.join(res, 'app.asar');
    if (fs.existsSync(asar)) out.push({ kind: 'asar', path: asar });
    const dir = path.join(res, 'app', 'node_modules', '@deepseek-ai');
    if (fs.existsSync(dir)) out.push({ kind: 'dir', path: dir });
  }
  return out;
}

/**
 * 打开一个 asar，返回按相对路径读文件 / 列目录的能力。
 *
 * asar 头部：4 字节 pickle 头 + 4 字节 header 大小 + 4 字节 JSON 长度 + 4 字节对齐，
 * 之后是 JSON 头；文件内容从 `8 + headerSize` 开始，每个条目自带 offset。
 */
function openAsar(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const headerSize = head.readUInt32LE(4);
  const jsonSize = head.readUInt32LE(12);
  const json = Buffer.alloc(jsonSize);
  fs.readSync(fd, json, 0, jsonSize, 16);
  const header = JSON.parse(json.toString('utf8'));
  const base = 8 + headerSize;

  function node(rel) {
    // asar 的文件树是「名字 → 条目」，条目里的下一层在 entry.files。
    const segs = rel.split('/').filter(Boolean);
    let cur = header.files;
    for (let i = 0; i < segs.length; i++) {
      const entry = cur?.[segs[i]];
      if (!entry) return null;
      if (i === segs.length - 1) return entry;
      cur = entry.files;
      if (!cur) return null;
    }
    return null;
  }
  function read(rel) {
    const entry = node(rel);
    if (!entry || entry.size === undefined) return null;
    const buf = Buffer.alloc(entry.size);
    fs.readSync(fd, buf, 0, entry.size, base + Number(entry.offset));
    return buf;
  }
  function list(rel) {
    const entry = node(rel);
    if (!entry?.files) return [];
    return Object.keys(entry.files);
  }
  return { read, list, path: asarPath, close: () => fs.closeSync(fd) };
}

/**
 * 宿主包视图：不管宿主是目录式还是 asar 式，都用同一套接口取包。
 * - packages(): 宿主提供的包名集合
 * - packageJson(name): 读某个宿主包的 package.json
 * - readFile(name, rel): 读宿主包里的某个文件
 */
function hostFromDir(scopeDir) {
  const names = new Set();
  for (const e of fs.readdirSync(scopeDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('@')) {
      for (const s of fs.readdirSync(path.join(scopeDir, e.name))) names.add(`${e.name}/${s}`);
    } else names.add(e.name);
  }
  return {
    kind: 'dir',
    scopeDir,
    packages: () => names,
    packageJson: (name) => {
      const p = path.join(scopeDir, name, 'package.json');
      return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
    },
    readFile: (name, rel) => {
      const p = path.join(scopeDir, name, rel);
      return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
    },
  };
}

function hostFromAsar(asar) {
  // 桌面客户端的 asar 里，内核包可能散在几个作用域下（应用根的 node_modules、
  // dsh/node_modules……），打包布局随版本变 —— 全部收进来，取并集。
  const prefixes = ['node_modules/', 'dsh/node_modules/'];
  const scopes = prefixes.map((p) => ({ prefix: p, names: asar.list(`${p}@deepseek-ai`) })).filter((s) => s.names.length > 0);
  if (!scopes.length) throw new Error('asar holds no @deepseek-ai package scope');
  // 某个包名在哪个作用域下能找到，就用哪个
  const where = new Map();
  for (const { prefix, names } of scopes) {
    for (const name of names) if (!where.has(name)) where.set(name, prefix);
  }
  const names = new Set(where.keys());
  const read = (name, rel) => {
    const buf = asar.read(`${where.get(name)}${name}/${rel}`);
    return buf ? buf.toString('utf8') : null;
  };
  return {
    kind: 'asar',
    asarPath: asar.path,
    prefix: scopes.map((s) => s.prefix).join('+'),
    packages: () => names,
    packageJson: (name) => {
      const text = read(name, 'package.json');
      return text ? JSON.parse(text) : null;
    },
    readFile: read,
  };
}

/** npx 缓存根：Windows 在 %LOCALAPPDATA%\npm-cache\_npx，macOS/Linux 在 ~/.npm/_npx。 */
function npxRoots() {
  const roots = [];
  if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, 'npm-cache', '_npx'));
  if (process.env.npm_config_cache) roots.push(path.join(process.env.npm_config_cache, '_npx'));
  roots.push(path.join(os.homedir(), '.npm', '_npx'));
  return roots.filter((r) => fs.existsSync(r));
}

/** 找当前运行的 DSH 安装目录：npx 最近一次写入 .package-lock.json 的那个。 */
function resolveInstall() {
  const explicit = process.argv[2] ?? process.env.DSH_INSTALL_DIR;
  if (explicit) return explicit;
  const candidates = [];
  for (const npxRoot of npxRoots()) {
    for (const e of fs.readdirSync(npxRoot, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const dir = path.join(npxRoot, e.name, 'node_modules', NS, 'dsh');
      if (!fs.existsSync(path.join(dir, 'package.json'))) continue;
      let at = 0;
      try { at = fs.statSync(path.join(npxRoot, e.name, 'node_modules', '.package-lock.json')).mtimeMs; } catch {}
      candidates.push({ dir, at });
    }
  }
  candidates.sort((a, b) => b.at - a.at);
  // 找不到 CLI 安装不是错误：桌面客户端场景下宿主就是 app.asar
  return candidates[0]?.dir ?? null;
}

const INSTALL = resolveInstall();
const SCOPE_DIR = INSTALL ? path.dirname(INSTALL) : undefined;  // …/node_modules/@deepseek-ai

/**
 * 选宿主视图：目录式里能拿到 primitives 就用目录式；否则退回 asar
 * （桌面客户端：客户端半边依赖的包只在 app.asar 里）。
 */
let host;
let asarHandle = null;
if (INSTALL && fs.existsSync(path.join(SCOPE_DIR, 'dsh-client-ui-primitives'))) {
  host = hostFromDir(SCOPE_DIR);
} else {
  // 可能同时装着多个应用（Mac 上有 DSH Desktop Beta 与 DeepSeek Harness），
  // 选内核包最多的那个 —— 客户端半边依赖的 primitives 只在完整的那份里。
  let best = null;
  for (const c of appCandidates()) {
    let view = null;
    let handle = null;
    try {
      if (c.kind === 'dir') view = hostFromDir(c.path);
      else { handle = openAsar(c.path); view = hostFromAsar(handle); }
    } catch { continue; }
    const size = view.packages().size;
    if (!best || size > best.size) { best?.handle?.close(); best = { handle, view, size }; }
    else handle?.close();
  }
  if (!best) throw new Error('no host package scope: neither a directory install nor an app.asar was found');
  asarHandle = best.handle;
  host = best.view;
}
const version = INSTALL
  ? JSON.parse(fs.readFileSync(path.join(INSTALL, 'package.json'), 'utf8')).version
  : (host.packageJson('dsh')?.version ?? 'unknown');
console.log(`DSH install : ${INSTALL}\nDSH version : ${version}\nhost        : ${host.kind === 'dir' ? host.scopeDir : `asar ${host.asarPath} (${host.prefix})`}\nprofile     : ${PROFILE}\n`);

// --- 1. profile 组合 ---
let compositionOk = true;
try {
  const check = await import(new URL(`file://${PROFILE.replace(/\\/g, '/')}/node_modules/dshmarket/lib/check.js`).href);
  const analysis = check.analyzeProfile(PROFILE, { dshInstallDir: INSTALL });
  const rows = analysis.rows ?? [];
  const off = rows.filter((r) => r.disabled === true).map((r) => r.id);
  console.log(`[1] loader 行 ${rows.length}（disabled ${off.length}${off.length ? ': ' + off.join(', ') : ''}），summary.ok=${analysis.summary?.ok}`);
  if (analysis.summary?.errors?.length) { compositionOk = false; console.log('    errors: ' + JSON.stringify(analysis.summary.errors)); }
  for (const w of (analysis.summary?.warnings ?? []).slice(0, 6)) console.log('    warn: ' + w);
  if ((analysis.summary?.warnings ?? []).length > 6) console.log(`    …另有 ${analysis.summary.warnings.length - 6} 条 warning`);
} catch (error) {
  const noMarket = /dshmarket/.test(error.message) || /Cannot find module/.test(error.message);
  if (noMarket) console.log('[1] profile 里没有 dshmarket —— 跳过 loader 组合检查');
  else { compositionOk = false; console.log(`[1] analyzeProfile 不可用：${error.message}`); }
}

// --- 宿主导出表 ---
const primPkg = host.packageJson('dsh-client-ui-primitives');
if (!primPkg) {
  console.log('[2] 宿主没有 dsh-client-ui-primitives —— 跳过图标导出检查');
}
function exportNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) { const n = part.trim().split(/\s+as\s+/).pop().trim(); if (n) names.add(n); }
  }
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  return names;
}
const primExports = new Set();
if (primPkg) {
  for (const f of [primPkg.main ?? 'lib/index.js', primPkg.exports?.['.']?.default, primPkg.dsh?.client?.entry].filter(Boolean)) {
    const src = host.readFile('dsh-client-ui-primitives', f);
    if (src) for (const n of exportNames(src)) primExports.add(n);
  }
}
const hostPkgs = host.packages();

const icons = [...primExports].filter((n) => n.startsWith('Icon'));
if (primPkg) console.log(`[2] 宿主 primitives ${primPkg.version}：${primExports.size} 个导出，其中图标 ${icons.length} 个\n`);

// --- 遍历 profile 里的插件包 ---
const nm = path.join(PROFILE, 'node_modules');
const dirs = [];
for (const e of fs.readdirSync(nm, { withFileTypes: true })) {
  if (e.name === '.bin' || e.name === '.pnpm' || e.name.startsWith('.')) continue;
  if (e.name.startsWith('@')) { for (const s of fs.readdirSync(path.join(nm, e.name))) dirs.push(path.join(nm, e.name, s)); }
  else dirs.push(path.join(nm, e.name));
}

function findClient(dir) {
  const pj = join(dir, 'package.json'); if (!fs.existsSync(pj)) return null;
  let j; try { j = JSON.parse(fs.readFileSync(pj, 'utf8')); } catch { return null; }
  const cands = [];
  const exp = j.exports?.['./client'];
  if (typeof exp === 'string') cands.push(exp); else if (exp?.default) cands.push(exp.default);
  cands.push(j.dsh?.client?.entry, 'client/client.js', 'lib/client.js', 'dist/client.js');
  for (const c of cands) if (typeof c === 'string' && fs.existsSync(join(dir, c))) return join(dir, c);
  return null;
}
function join(dir, rel) { return path.join(dir, rel); }
/** 名字是否只出现在 // 或 * 注释里 */
function commentOnly(src, name) {
  const re = new RegExp(`\\b${name}\\b`, 'g');
  let m;
  while ((m = re.exec(src)) !== null) {
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    const before = src.slice(lineStart, m.index);
    if (!/(^|\s)(\/\/|\*|\/\*)/.test(before)) return false;
  }
  return true;
}
const newCounterpart = (name) => name.replace(/\d+$/, 'Regular');

const iconProblems = [];
const moduleProblems = [];
const importProblems = [];
let withClient = 0;
for (const dir of dirs) {
  const pjPath = join(dir, 'package.json');
  if (!fs.existsSync(pjPath)) continue;
  let pj; try { pj = JSON.parse(fs.readFileSync(pjPath, 'utf8')); } catch { continue; }
  const client = findClient(dir);
  if (client) {
    withClient++;
    const src = fs.readFileSync(client, 'utf8');
    const used = [...new Set([...src.matchAll(/\bIcon[A-Za-z0-9_]+\b/g)].map((m) => m[0]))];
    const definedLocally = new Set([...src.matchAll(/(?:const|let|var|function)\s+(Icon[A-Za-z0-9_]+)/g)].map((m) => m[1]));
    const unresolved = used.filter((n) => !primExports.has(n) && !definedLocally.has(n));
    const hard = [];
    const soft = [];
    for (const n of unresolved) {
      const guard = new RegExp(`!\\s*[A-Za-z_$][\\w$]*\\.${n}\\b`).test(src);       // if (X && !X.Name)
      const alias = new RegExp(`\\b${n}\\s*:\\s*[A-Za-z_$][\\w$]*\\.`).test(src);  // { Name: X.NameRegular }
      const fallback = new RegExp(`pickIcon\\([^)]*\\b${n}\\b`).test(src);         // pickIcon(X.Name, …)
      const usesNew = src.includes(newCounterpart(n));                             // 已改用同基名 Regular
      // `<expr> ?? X.Name` —— 缺名只在 ?? 右侧时是**死兜底**，左侧表达式取到值就不会求值右侧。
      // 实测样本：@kenz1117/dsh-ui-usage-billing 1.4.12 的
      //   `let zn = Rn.IconChevronDownOutlineMedium ?? Rn.IconChevronDownOutline14`
      // 旧名 `…14` 只出现在 ?? 右侧、且只在整条 bundle 里出现 1 次，主名 Medium 在宿主
      // primitives 里真实导出 → 不可能抛 React #130。旧版脚本只认 `!X.Name`，会把这种漏成硬缺失。
      const nullishLeftOf = (name) => {
        let idx = -1;
        while ((idx = src.indexOf(name, idx + 1)) !== -1) {
          const before = src.slice(Math.max(0, idx - 80), idx);
          if (!/\?\?\s*[A-Za-z_$][\w$]*\.\s*$/.test(before)) return false;  // 至少一次不是 ?? 右侧 → 不算兜底
        }
        return true;
      };
      if (guard || alias || fallback || usesNew) soft.push(n);
      else if (nullishLeftOf(n)) soft.push(n);
      else if (commentOnly(src, n)) soft.push(n);
      else hard.push(n);
    }
    if (hard.length) iconProblems.push({ name: pj.name, rel: path.relative(nm, client), hard, soft: soft.length });
    const ids = [...new Set([...src.matchAll(/\be\(\s*[`"']([^`"']+)[`"']\s*\)/g)].map((m) => m[1]))]
      .filter((i) => i.startsWith(NS + '/') && !i.includes('${') && i.length < 60);
    const bad = ids.filter((i) => !hostPkgs.has(i.slice(NS.length + 1)));
    if (bad.length) moduleProblems.push({ name: pj.name, bad });
  }
  if (pj.dsh !== undefined) {
    const main = pj.main ?? 'index.js';
    const mainPath = join(dir, main);
    if (fs.existsSync(mainPath)) {
      const src = fs.readFileSync(mainPath, 'utf8');
      const imports = [...new Set([...src.matchAll(/from\s*[`"'](@deepseek-ai\/[^`"']+)[`"']/g)].map((m) => m[1]))];
      const req = createRequire(pjPath);
      const bad = [];
      for (const i of imports) {
        const host = hostPkgs.has(i.slice(NS.length + 1).split('/')[0]);
        if (host) continue;
        try { req.resolve(i); } catch { bad.push(i); }
      }
      if (bad.length) importProblems.push({ name: pj.name, bad });
    }
  }
}

console.log(`[3] 带客户端 bundle 的插件：${withClient}`);
console.log(`    图标导出**硬缺失**（既无兜底、也非注释/本地定义）：${iconProblems.length}`);
for (const p of iconProblems) console.log(`      ${p.name} [${p.rel.replace(/\\/g, '/')}] -> ${p.hard.join(', ')}${p.soft ? `   (另有 ${p.soft} 个已兜底)` : ''}`);
console.log(`[4] 客户端模块 id 缺失：${moduleProblems.length}`);
for (const p of moduleProblems) console.log(`      ${p.name}: ${p.bad.join(', ')}`);
console.log(`[5] 宿主半边裸导入解析失败：${importProblems.length}`);
for (const p of importProblems) console.log(`      ${p.name}: ${p.bad.join(', ')}`);

const bad = !compositionOk || iconProblems.length > 0 || moduleProblems.length > 0 || importProblems.length > 0;
console.log(`\n${bad ? 'FAIL' : 'PASS'} — ${bad ? '有需要处理的项' : '未发现硬性不兼容'}`);
asarHandle?.close();
process.exit(bad ? 1 : 0);
