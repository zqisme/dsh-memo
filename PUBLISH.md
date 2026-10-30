# 发布与迁移（交接文档）

这份文档是给「以后在新会话里把 dsh-memo 推上 GitHub、再装到其他设备」准备的。
它记录了两类东西：**这个插件本身的取舍**，以及**摸索出来的 DSH 插件契约**（省得下个会话重新翻源码）。

---

## 1. 它是什么

DSH（DeepSeek Harness）的 Web 图形界面插件：左侧栏一个「备忘录」按钮，主面板一块自动保存的
Markdown 便签。数据是**一个普通文件** `~/.dsh/memo/memo.md`，跟工作区无关，任何编辑器都能打开。

- 纯外部插件：只走官方 Slot 机制与 `webServer` 路由，**不改 DSH 任何源码**；
- 零三方依赖、**零构建步骤**：`lib/client.js` 是手写的模块表产物，`lib/index.js` 只用 Node 内置模块；
- 单文件 + 目录 + 单节编辑（不拆分文件，也不做多便签）。

## 2. 文件清单

| 文件 | 职责 |
|---|---|
| `package.json` | `dsh.bundle.patch`（profile 补丁）、`dsh.client`（浏览器半边）、`exports["./client"]` |
| `cordis.patch.yml` | bundle 层：往 profile 名册里插入 `id: memo` / `name: dsh-memo` 一行 |
| `lib/index.js` | Host 半边：一条 `/api/dsh-memo` 路由，读/写固定文件；自带回环 + 同源围栏；原子写 |
| `lib/client.js` | 客户端半边：注册侧栏按钮 + 主面板；目录解析、单节编辑、自动保存、选区落地、显示偏好记忆 |
| `test/host.test.mjs` | Host 自测：路由登记、读写往返、跨站/局域网拒绝、方法/载荷校验 |
| `test/client.test.mjs` | 客户端自测：工厂格式、槽位注册、渲染一遍、`parseOutline` / `sectionRange` / `appendSection` |
| `tools/patch-profile.mjs` | 把包名写进 profile 的 `dsh.profile.bundles`（pnpm 只管 node_modules，不管这个） |
| `README.md` | 用户向说明：怎么用、数据在哪、设计取舍 |
| `LICENSE` | MIT |

## 3. DSH 插件契约（0.2.1-rc.2 实测）

这些是从本机 `@deepseek-ai/*` 产物里读出来的，下个会话直接照做即可，别重新猜：

1. **客户端 bundle 不是 ESM，也不是 CJS**，而是「模块表工厂」：

   ```js
   window.__ModuleLoader__.load({
     id: 'dsh-memo',                       // 必须是包名
     factory: (require) => {
       var module = { exports: {} };
       var exports = module.exports;
       const React = require('react');     // 只能要平台种子模块
       // …插件代码…
       exports.apply = apply;
       exports.inject = ['slots'];
       return module.exports;
     },
   });
   ```

   宿主把 `exports["./client"]` 指向的文件内容当作脚本执行，因此**文件里不能有 `import`**。

2. **`require` 只能解析平台种子模块**：`react`、`react/jsx-runtime`、`@deepseek-ai/dsh-client-ui-primitives`、
   `@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/cordis`、
   `@tanstack/react-virtual`、`zod` 等。表外的名字必须自己打进 bundle —— 本插件一个都没用，所以零依赖。

3. **侧栏按钮**：槽位 `sidebar.panellist`，注册项 `{ name, id, order, label }`。
   `label` 可以是字符串，也可以是返回字符串的函数（`resolveSlotLabel` 两种都认）。
   组件会收到 `{ size, active }` 两个 prop（图标尺寸 / 是否当前面板）。

4. **主面板**：槽位 `main`，注册项 `{ name, key }` —— **`key` 必须等于侧栏按钮的 `id`**。
   布局层用 `renderSlot('main', {}, { entryKey: activePanelId ?? 'conversation' })` 选中条目，
   `activePanelId` 就是点侧栏按钮时写进去的那个 id。

5. **客户端插件面**：`exports.apply(ctx)` + `exports.inject = ['slots']`。
   注册一律包在 `ctx.slots.inject(槽位名, () => ctx.slots.register(...))` 里：槽位由别的插件声明，
   本插件可能先加载；未来某个席位被删掉时也只是不显示，不会让启动失败。

6. **宿主路由**：`ctx.webServer.register({ kind: 'exact' | 'prefix', path, handler })`，
   handler 收原始的 `(req, res)`（Node 的 http 对象）。重复的 `(kind, path)` 会直接 throw。

7. **`webServer` 没有任何鉴权/来源策略**（官方注释：*No server-wide authentication or origin policy*）。
   它还会绕过 `dsh web` 的 URL token 门（那层归 `@deepseek-ai/dsh-client-connection` 管，只覆盖 `/api/*`）。
   所以能写磁盘的路由**必须自己立围栏**：校验 socket 回环 + `Host` 头回环 + `sec-fetch-site` 非 cross-site
   + `Origin` 与 `Host` 同源。`lib/index.js` 里的 `isTrusted()` 就是现成实现。

8. **宿主插件面**：`export const name` / `export const inject = []` / `export function apply(ctx)`。
   `webServer` 是可选依赖，用 `ctx.get('webServer')` 或 `ctx.inject(['webServer'], (sub) => …)` 惰性取 ——
   声明进 `inject` 会让插件在没有 Web 载体的部署（headless / SDK）里永远等下去。

9. **客户端 bundle 在启动时读取并缓存**：改完 `lib/*.js` 必须重启 `dsh web`，热改磁盘不生效。

10. **profile 要两件事**才生效：`pnpm add` 进 `node_modules`，**并且**包名出现在
    `package.json` 的 `dsh.profile.bundles` 里（后者才让 `cordis.patch.yml` 被应用）。
    `tools/patch-profile.mjs` 干后面这件。

11. **`$DSH_HOME` 可覆盖 `~/.dsh`**（profile、sessions、storages 全跟着走）。调试时用它隔离。

## 4. 自测

```powershell
node --check lib/index.js
node --check lib/client.js
node test/host.test.mjs      # 路由 / 围栏 / 读写往返 / 载荷校验
node test/client.test.mjs    # 工厂格式 / 槽位注册 / 渲染 / 三个纯函数
```

两个脚本都不启动 DSH、不碰真实数据（Host 自测写系统临时目录）。

## 5. 上传 GitHub

1. 新建仓库（名字建议 `dsh-memo`，public/private 都行）。
2. 推这些文件：`package.json` / `cordis.patch.yml` / `lib/` / `test/` / `tools/` / `README.md` /
   `PUBLISH.md` / `LICENSE` / `.gitignore`。
   **`lib/` 必须提交** —— 它是手写产物，没有构建步骤能重建它（`.gitignore` 里已注明）。
3. ~~把 `package.json` 里的占位符替换掉~~ —— 已完成：`author` / `repository.url` /
   `homepage` / `bugs.url` 都指向 `zqisme/dsh-memo`。
4. ~~`LICENSE` 的版权行~~ —— 已完成：`Copyright (c) 2026 zqisme`。
5. 打个 tag（可选）：`git tag v0.1.0 && git push --tags`。
6. 之后改代码记得同时改 `package.json` 的 `version`。

> 不打算发 npm 也没关系：GitHub 装法（下一节）完全够用。真要发 npm，先跑 `npm publish --dry-run`
> 看一眼打包内容（`files` 现在是 `lib/`、`tools/`、补丁、README、LICENSE）。
> **`tools/` 不能从 `files` 里删**：git 依赖装进 `node_modules` 时只带 `files` 列出的东西，
> 而下一节第 3 步跑的正是 `node_modules/dsh-memo/tools/patch-profile.mjs`，缺了它安装会断在那里。

## 6. 在其他设备上安装

前提：那台机器上 DSH ≥ 0.2.1-rc.2，且有一个带 Web 界面的 profile（默认名字 `web`）。

**方式 A：直接从 GitHub 装（推荐，无需 clone）**

```powershell
# 1) 确认/创建 profile（已存在会直接成功）
dsh --profile web --from-default-profile web --dump-config > $null

# 2) 从仓库装
dsh plugin --profile web add "git+https://github.com/zqisme/dsh-memo.git"

# 3) 登记进 bundle 清单（关键，漏了插件不会出现）
node "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-memo\tools\patch-profile.mjs" "$env:USERPROFILE\.dsh\profiles\web\package.json"

# 4) 重启
dsh web
```

**方式 B：先 clone 再 link（改代码时方便）**

```powershell
git clone https://github.com/zqisme/dsh-memo.git C:\path\to\dsh-memo
dsh plugin --profile web add "link:C:/path/to/dsh-memo"
node C:\path\to\dsh-memo\tools\patch-profile.mjs "$env:USERPROFILE\.dsh\profiles\web\package.json"
dsh web
```

注意：`bundles` 里写的是**包名 `dsh-memo`**，不是 git 地址或路径。

装完检查：

```powershell
# 组合后的配置里应该出现 id: memo
dsh --profile web --dump-config | Select-String -Pattern "dsh-memo" -Context 1,1
```

卸载：`dsh plugin --profile web remove dsh-memo`，再把 `dsh.profile.bundles` 里的 `"dsh-memo"` 删掉。
数据文件不会被卸载动到。

## 7. 数据不跨设备

备忘录在**每台机器各自**的 `~/.dsh/memo/memo.md`。插件不做同步。
想跨设备就自己同步这一个文件（私有 git、Syncthing、网盘都行），或者把
`DSH_MEMO_FILE` 指到一个被同步的路径。

## 8. 已知取舍（都是刻意的）

- **单文件，不拆分**：所有内容在一份 `memo.md` 里，靠 `##` 分节 + 左侧目录导航。
  想改「一条便签一个文件」是另一套数据模型（列表、重命名、删除、迁移脚本）。
- **没有 Markdown 预览**：就是一个纯文本编辑框，要渲染看别的面板。
- **单节编辑是切片视图**，不是真的折叠 DOM：编辑区显示 `全文.slice(该节起止)`，改动立刻拼回整篇，
  内存里只有一份真值。所以删掉标题行的 `## ` 会让那一节不再是独立节（内容不丢）。
- **默认视角是「只看单节」**：点进面板先看一节，想通读点「看整篇」。这个选择记在浏览器
  `localStorage` 的 `dsh-memo:prefs` 里（连同目录开合），所以只影响当前这个浏览器；
  清站点数据就回到默认的单节。正文永远只在 `memo.md` 里，偏好里一个字都不存。
- **默认落在哪一节**：一般是第一节；但 1 级标题在这个模型里会吃掉后面所有子节，若全篇
  只有一个 `#` 级标题（`# 索引` 这种），它覆盖到文末，就按「整篇的壳」处理，默认跳到它
  下面第一个 `##`（`defaultSectionIndex`，已进 `__test`）。否则默认单节和整篇长得一样。
- **第一节带上文首前导**：标题之前那段字不属于任何一节，切片时并进第一节，
  免得单节视图里「看不见但还在文件里」。所以第一节的切片起点可能是 0 而不是标题行。
- **新建节跟着「当前选中的那一节」**（`insertSection`）：级别取选中节的级别（同级 = 下一个
  兄弟），位置插在选中节（连同它的子节）末尾 —— 目录里看就是紧跟在选中行下面。没有选中时
  退回文末追加，级别用 `sectionLevel`（最后一个标题的级别；没有标题则 1 级）。
  演进过程记一下：0.1 写死 `##`，且永远追加在文末 —— 在全 `#` 的笔记里那个 `##` 会被
  上一个 `#` 节吃掉（`#` 的区间延伸到下一个 `#`），在 `##` 节里点新建又会掉出个 `#` 到最底下。
  0.4 起级别和位置都跟着选中行走，测试覆盖「选中 `##`」「选中顶层 `#` 壳」「没选中」三条路径。
- **1 MiB 上限**，超了明确报错，不静默截断。
- **路由在 token 门之外**，靠插件自己的回环 + 同源围栏保护（见契约第 7 条）。

## 9. 给新会话的开工提示（可整段粘贴）

```text
把这个目录下的 dsh-memo 推到我自己的 GitHub 仓库（仓库名 dsh-memo），然后告诉我其他设备怎么装。

背景：
- 它是一个 DSH 插件，零依赖零构建：lib/client.js 是手写的模块表产物，必须提交，不能当构建产物忽略。
- 详细契约、安装步骤、已知取舍都写在 dsh-memo/PUBLISH.md 和 dsh-memo/README.md 里，先读这两个。
- 上传前请把 package.json 里的 YOUR-GITHUB-USER / YOUR-NAME 换成我的，并检查 LICENSE 的版权行。
- 自测命令：node test/host.test.mjs && node test/client.test.mjs（应该全绿）。
- 推完请给我：仓库地址、其他设备的三行安装命令（含 patch-profile 那步）、以及怎么验证装好了。
```
