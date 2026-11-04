/**
 * dsh-memo Host 半边自测（不依赖 DSH 进程）。
 *
 * 跑法：node test/host.test.mjs
 * 覆盖：路由登记、读/写往返、宿主信任层拒绝 / 缺失 / 抛错、方法/载荷校验。
 *
 * 信任判定本身归 `dsh-client-connection` 管，这里用可切换的替身代表它：
 * 插件只负责「问一次、按状态码停」，不再自己解析 Host / socket / Origin。
 */
import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('../lib/index.js', import.meta.url));
const workdir = await mkdtemp(join(tmpdir(), 'dsh-memo-'));
process.env['DSH_MEMO_FILE'] = join(workdir, 'memo', 'memo.md');

const mod = await import(pathToFileURL(here).href);

/** 收集登记的路由。 */
const routes = [];
/** 收集副作用释放函数。 */
const disposers = [];
/** connection.requestRejection 的替身：默认放行，各用例覆写。 */
let rejectWith = undefined;
/** 把 connection 服务整个拿掉，用来验 fail closed。 */
let hideConnection = false;
/** 让 requestRejection 抛错，用来验异常也 fail closed。 */
let throwFromConnection = false;

const ctx = {
  logger: { warn() {} },
  effect(callback) {
    const dispose = callback();
    disposers.push(dispose);
    return dispose;
  },
  get(name) {
    if (name === 'webServer') {
      return {
        register(route) {
          routes.push(route);
          return () => {};
        },
      };
    }
    if (name === 'connection' && !hideConnection) {
      return {
        requestRejection() {
          if (throwFromConnection) throw new Error('trust layer crashed');
          return rejectWith;
        },
      };
    }
    return undefined;
  },
  inject() {},
};

mod.apply(ctx);

assert.equal(routes.length, 1, '应只登记一条路由');
assert.equal(routes[0].path, '/api/dsh-memo');
assert.equal(routes[0].kind, 'exact');

/**
 * 造一个请求。LAN 绑定时本机请求的 Host / remoteAddress 都是绑定 IP，
 * 这里照实模拟，供 connection 替身按需检查。
 * @param {object} options - 方法、请求头、载荷、socket 地址。
 * @returns 可被 handler 消费的假请求。
 */
function makeReq({ method = 'GET', headers = {}, body = '', remoteAddress = '192.168.124.2' } = {}) {
  const payload = Buffer.from(body, 'utf8');
  return {
    method,
    url: '/api/dsh-memo',
    headers: { host: '192.168.124.2:3080', 'sec-fetch-site': 'same-origin', ...headers },
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() {
      if (payload.length > 0) yield payload;
    },
  };
}

/** 收集响应的假 res。 */
function makeRes() {
  return {
    status: 0,
    headers: {},
    body: '',
    headersSent: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      this.headersSent = true;
    },
    end(text) {
      this.body = text;
    },
  };
}

const call = async (options) => {
  const res = makeRes();
  await routes[0].handler(makeReq(options), res);
  return { status: res.status, headers: res.headers, json: res.body === '' ? null : JSON.parse(res.body) };
};

const post = (content, extra = {}) => call({ method: 'POST', body: JSON.stringify({ content }), ...extra });

// 1. 空状态：文件还不存在也不算错误。
let res = await call({});
assert.equal(res.status, 200);
assert.equal(res.json.exists, false);
assert.equal(res.json.content, '');
assert.match(res.json.path, /memo[\\/]memo\.md$/);

// 2. 写 → 读往返（含中文与换行）。
res = await post('第一行\n第二行 ✅');
assert.equal(res.status, 200);
assert.equal(res.json.ok, true);
assert.equal(await readFile(process.env['DSH_MEMO_FILE'], 'utf8'), '第一行\n第二行 ✅');

res = await call({});
assert.equal(res.json.content, '第一行\n第二行 ✅');
assert.equal(res.json.exists, true);

// 3. 覆盖写：不会留下临时文件或半截内容。
res = await post('只有这一行');
assert.equal(res.status, 200);
assert.equal(await readFile(process.env['DSH_MEMO_FILE'], 'utf8'), '只有这一行');

// 4. 信任层：插件把判定交给宿主，自己只按状态码停。
//    LAN 绑定 + 同源 + 已登录（替身返回 undefined）必须放行。
res = await call({ headers: { origin: 'http://192.168.124.2:3080' } });
assert.equal(res.status, 200, 'LAN 绑定下已登录的同源请求必须放行');

rejectWith = 403;
res = await post('x', { headers: { origin: 'http://evil.example' } });
assert.equal(res.status, 403, '宿主判定跨站 / Host 不可信时必须拒绝');
assert.match(res.json.error, /未通过宿主信任校验/);

rejectWith = 401;
res = await post('x', { headers: { 'sec-fetch-site': 'cross-site' } });
assert.equal(res.status, 401, '没有登录 cookie 时按 401 返回，提示重新登录');
assert.match(res.json.error, /token/);

hideConnection = true;
res = await call({});
assert.equal(res.status, 503, '缺 connection 服务必须 fail closed');
assert.match(res.json.error, /缺少 connection/);
hideConnection = false;

throwFromConnection = true;
res = await call({});
assert.equal(res.status, 403, '信任层抛错也必须 fail closed');
throwFromConnection = false;
rejectWith = undefined;

// 4b. 方法 / 载荷校验。
res = await call({ method: 'DELETE' });
assert.equal(res.status, 405);

res = await call({ method: 'POST', body: '不是 json' });
assert.equal(res.status, 400);

res = await call({ method: 'POST', body: JSON.stringify({ content: 42 }) });
assert.equal(res.status, 400, 'content 必须是字符串');

res = await post('y'.repeat(1024 * 1024 + 1));
assert.equal(res.status, 413, '超过上限必须拒绝');

// 5. 内容没被上面的失败请求破坏。
res = await call({});
assert.equal(res.json.content, '只有这一行');

// 6. 落盘权限：私人笔记不该让同机其他用户读到（POSIX 才有意义）。
if (process.platform !== 'win32') {
  const mode = (await stat(process.env['DSH_MEMO_FILE'])).mode & 0o777;
  assert.equal(mode, 0o600, '备忘录应以 0600 落盘');
}

// 7. 符号链接：写到真实目标，链接本身不能被 rename 顶掉（否则同步就断了）。
const realFile = join(workdir, 'real-memo.md');
const linkFile = join(workdir, 'link-memo.md');
await writeFile(realFile, '原始\n', 'utf8');
let canSymlink = true;
try {
  await symlink(realFile, linkFile, 'file');
} catch {
  // Windows 上没开开发者模式 / 非管理员时建不了软链，跳过这条。
  canSymlink = false;
}
if (canSymlink) {
  const configured = process.env['DSH_MEMO_FILE'];
  process.env['DSH_MEMO_FILE'] = linkFile;
  res = await post('通过链接写入\n');
  assert.equal(res.status, 200);
  assert.equal(res.json.path, linkFile, '回给客户端的仍是配置里的路径');
  assert.ok((await lstat(linkFile)).isSymbolicLink(), '链接必须还在');
  assert.equal(await readFile(realFile, 'utf8'), '通过链接写入\n', '内容应落到真实目标');
  process.env['DSH_MEMO_FILE'] = configured;
} else {
  console.log('  (跳过符号链接用例：当前环境不允许创建软链)');
}

// 8. 卸载时路由要能被收回。
for (const dispose of disposers) if (typeof dispose === 'function') dispose();
await rm(workdir, { recursive: true, force: true });

console.log('host.test.mjs: 全部通过');
