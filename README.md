# dsh-selfcheck

每次 **DSH 升级后**（以及怀疑插件被新版核心打断时）跑的两个自检脚本。都只读，
自动发现"当前运行中的那个 DSH 安装"，不依赖任何硬编码的 npx 缓存目录。

| 脚本 | 检查什么 | 判定 |
|---|---|---|
| `check-plugin-compat.mjs` | profile 组合（借用 dshmarket 自己的 `analyzeProfile`）、客户端 bundle 的**图标导出**、客户端模块 id、宿主半边裸导入 | 无硬性不兼容 → `PASS`（exit 0） |
| `check-llm-deepseek-tool-input.mjs` | 本机给核心打的 **dsh-llm-deepseek 补丁**还在不在：非法工具入参不得终止整轮 | 补丁在位 → exit 0；丢了 → exit 1 |

## 用法

```powershell
node ~/.dsh/check-plugin-compat.mjs
node ~/.dsh/check-llm-deepseek-tool-input.mjs
```

`~/.dsh/` 下这两个入口是指向本仓库的符号链接；也可以直接跑仓库里的文件。
两者都接受一个可选参数显式指定安装目录：

```powershell
node check-plugin-compat.mjs "C:\...\_npx\<hash>\node_modules\@deepseek-ai\dsh"
node check-llm-deepseek-tool-input.mjs "C:\...\_npx\<hash>\node_modules\@deepseek-ai\dsh-llm-deepseek\lib\index.js"
```

## 为什么需要它们

1. **npx 目录会换**。`@alpha` / `@next` / 具体版本各占一个 `_npx/<hash>` 目录，硬编码路径
   的自检会在换通道那天开始测错对象（旧脚本就栽在这里）。两个脚本都按
   `node_modules/.package-lock.json` 的写入时间挑"最近一次安装"。
2. **改盘补丁会被重装冲掉**。`dsh-llm-deepseek` 的补丁改在 npx 缓存里的原厂文件上，
   升级/换通道后必须重打；`check-llm-deepseek-tool-input.mjs` 就是那句"还在不在"。
   上游讨论：https://github.com/deepseek-ai/deepseek-harness/discussions/7581
3. **图标导出误报会淹没有效信号**。0.1.7-alpha.1 删掉 84 个旧图标名后，
   "bundle 里出现 `IconXxx` 但宿主没导出"有五种安全情形（本地别名、上游 `pickIcon` 回落、
   只在注释里、本地自己定义、已改用同基名 `...Regular`）。`check-plugin-compat.mjs`
   把这五种区分开，只报硬缺失。

## 已知边界

- 客户端检查是**静态**的：它证明"引用的名字还在"，不证明"渲染路径没崩"。要证后者得开一次
  真浏览器（见会话里 `client-smoke.mjs` 那种小夹具，或 playwright 走一遍设置页）。
- `check-plugin-compat.mjs` 的 peer-range warning 大多是**噪音**：schemastery 的 `*` 范围
  默认不匹配预发布版本，所以 `@deepseek-ai/dsh-*` 的 `*` 依赖会在这份 `analyzeProfile`
  里全被标成不匹配。
