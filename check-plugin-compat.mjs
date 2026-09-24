/**
 * DSH 插件兼容自检（对着**当前运行中**的 DSH 安装跑）。
 *
 * 用法：node ~/.dsh/check-plugin-compat.mjs [dshInstallDir]
 *   exit 0 = 无硬性不兼容；exit 1 = 有需要处理的问题（图标导出缺失且无兜底 / 宿主半边 import 解析不了）
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

const PROFILE = path.join(os.homedir(), '.dsh', 'profiles', process.env.DSH_PROFILE ?? 'web');
const NS = '@deepseek-ai';

/** 找当前运行的 DSH 安装目录：npx 最近一次写入 .package-lock.json 的那个。 */
function resolveInstall() {
  const explicit = process.argv[2] ?? process.env.DSH_INSTALL_DIR;
  if (explicit) return explicit;
  const npxRoot = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'npm-cache', '_npx');
  const candidates = fs.readdirSync(npxRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dir = path.join(npxRoot, e.name, 'node_modules', NS, 'dsh');
      if (!fs.existsSync(path.join(dir, 'package.json'))) return null;
      let at = 0;
      try { at = fs.statSync(path.join(npxRoot, e.name, 'node_modules', '.package-lock.json')).mtimeMs; } catch {}
      return { dir, at };
    })
    .filter(Boolean)
    .sort((a, b) => b.at - a.at);
  if (!candidates.length) throw new Error(`no DSH install found under ${npxRoot}`);
  return candidates[0].dir;
}

const INSTALL = resolveInstall();
const SCOPE_DIR = path.dirname(INSTALL);          // …/node_modules/@deepseek-ai
const NODE_MODULES = path.dirname(SCOPE_DIR);     // …/node_modules
const version = JSON.parse(fs.readFileSync(path.join(INSTALL, 'package.json'), 'utf8')).version;
console.log(`DSH install : ${INSTALL}\nDSH version : ${version}\nprofile     : ${PROFILE}\n`);

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
  compositionOk = false;
  console.log(`[1] analyzeProfile 不可用：${error.message}`);
}

// --- 宿主导出表 ---
const primDir = path.join(SCOPE_DIR, 'dsh-client-ui-primitives');
const primPkg = JSON.parse(fs.readFileSync(path.join(primDir, 'package.json'), 'utf8'));
function exportNames(file) {
  const src = fs.readFileSync(file, 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) { const n = part.trim().split(/\s+as\s+/).pop().trim(); if (n) names.add(n); }
  }
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  return names;
}
const primExports = new Set();
for (const f of [primPkg.main ?? 'lib/index.js', primPkg.exports?.['.']?.default, primPkg.dsh?.client?.entry].filter(Boolean)) {
  const p = path.join(primDir, f);
  if (fs.existsSync(p)) for (const n of exportNames(p)) primExports.add(n);
}
const hostPkgs = new Set(fs.readdirSync(SCOPE_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name));

const icons = [...primExports].filter((n) => n.startsWith('Icon'));
console.log(`[2] 宿主 primitives ${primPkg.version}：${primExports.size} 个导出，其中图标 ${icons.length} 个\n`);

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
      if (guard || alias || fallback || usesNew) soft.push(n);
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
process.exit(bad ? 1 : 0);

