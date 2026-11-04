/**
 * dsh-memo — Host 半边。
 *
 * 只做一件事：读 / 写一个固定的 Markdown 文件。路由挂在官方 `webServer` 上，
 * 客户端半边（./client）用同源 fetch 调它。
 *
 * 刻意保持这么小，是因为 Host 半边有真实的磁盘写权限，代码越少越好审：
 * - **没有路径参数**：文件路径在服务端算好，客户端传不进来，因此没有 `../` 穿越面；
 * - **复用宿主的浏览器信任层**：webServer 自身不做鉴权（见 dsh-host-webserver 的说明），
 *   每个请求先问 `ctx.connection.requestRejection(req)` —— 它校验 Host（回环 /
 *   监听器绑定 IP / trustedHosts）、Origin、Sec-Fetch-Site，并要求 DSH 的签名登录
 *   cookie。`dsh web --host <局域网IP>` 时绑定 IP 也会被接受，不会再被自己的回环围栏挡住；
 * - **失败即关闭**：取不到 `connection` 服务时一律 503，不退回任何弱校验；
 * - **原子写**：先写同目录临时文件再 rename，中途失败不会留下半个文件。
 */
import { lstat, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** cordis 插件名（稳定标识，与 cordis.patch.yml 里的行 id 无关）。 */
export const name = 'memo';

/**
 * 不声明必需服务：`webServer` / `connection` 是可选依赖，用 `ctx.inject([...])` 惰性等它们。
 * 声明成 inject 会让插件在没有 Web 载体的部署（headless / SDK）里永远等下去；
 * 但一旦注册了路由，缺 `connection` 就只回答 503（见 requestRejection）。
 */
export const inject = [];

/** 唯一的路由路径。客户端 bundle 里镜像了这个字面量。 */
const ROUTE = '/api/dsh-memo';

/** 备忘录文件的大小上限（字节）。超了就拒绝，而不是把整个面板卡死。 */
const MAX_BYTES = 1024 * 1024;

/**
 * DSH 的用户数据根目录。
 *
 * 与官方 `@deepseek-ai/dsh-home-paths` 同一套规则（`$DSH_HOME` 优先，否则 `~/.dsh`），
 * 但这里不 import 那个包：它不在本插件的依赖里，而这段逻辑只有三行。
 *
 * @returns 绝对路径。
 */
function dshHome() {
  const fromEnv = process.env['DSH_HOME'];
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
  return join(homedir(), '.dsh');
}

/**
 * 备忘录文件位置。
 *
 * 默认 `~/.dsh/memo/memo.md`：与具体工作区无关 —— 备忘录本来就该跟着人走，
 * 而不是跟着某次会话的目录走。`$DSH_MEMO_FILE` 可以整体换掉这个位置。
 *
 * @returns 绝对路径。
 */
function memoFile() {
  const override = process.env['DSH_MEMO_FILE'];
  if (typeof override === 'string' && override.trim() !== '') return override.trim();
  return join(dshHome(), 'memo', 'memo.md');
}

/** 带状态码的错误。 */
class HttpError extends Error {
  /**
   * @param status - HTTP 状态码。
   * @param message - 给客户端看的说明。
   */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * 问宿主自己那套浏览器信任层要不要拒绝这次请求。
 *
 * `dsh-client-connection` 的 `requestRejection` 同时做两件事：Host/Origin/
 * Sec-Fetch-Site 围栏（防 DNS rebinding 与跨站），以及签名登录 cookie 校验。
 * 它接受的 Host 包含「监听器的绑定 IP」，所以 LAN 启动也能过；换端口、
 * trustedHosts、TLS 也全部跟着宿主配置走，插件不用再复制一份地址规则。
 *
 * 这里刻意**不**自己看 socket.remoteAddress：绑定非回环地址时，本机浏览器
 * 与本机脚本的 remoteAddress 都是那个 IP，回环判断反而会把正常请求挡掉。
 *
 * @param req - 原始请求。
 * @param ctx - 宿主插件上下文。
 * @returns HTTP 状态码；`undefined` 表示可以继续处理。
 */
function requestRejection(req, ctx) {
  const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined;
  // fail closed：没有官方信任层，就不开放一条能读写磁盘的路由。
  if (connection === undefined || connection === null || typeof connection.requestRejection !== 'function') {
    return 503;
  }
  try {
    const status = connection.requestRejection(req);
    return status === 401 || status === 403 ? status : status === undefined ? undefined : 403;
  } catch {
    // 宿主接口若抛错，宁可拒绝，也不能带着未知状态往下走。
    return 403;
  }
}

/**
 * 读请求体并解析成对象。
 *
 * @param req - 原始请求。
 * @param limit - 允许的最大字节数。
 * @returns 解析后的对象。
 * @throws HttpError 超限（413）或不是合法 JSON 对象（400）。
 */
async function readJsonBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += buffer.length;
    if (size > limit) throw new HttpError(413, '请求体过大');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') throw new HttpError(400, '请求体为空');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, '请求体必须是 JSON 对象');
  }
  return parsed;
}

/**
 * 原子写：同目录临时文件 → rename 覆盖。
 *
 * `mode: 0o600`：备忘录是私人笔记，默认不该让同机其他用户读到。POSIX 上按这个
 * umask 落盘，rename 会把它带到目标文件；Windows 忽略 mode，行为不变。
 *
 * @param target - 目标文件绝对路径。
 * @param content - 文本内容。
 */
async function writeAtomic(target, content) {
  const tmp = join(dirname(target), `.${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.tmp`);
  try {
    await writeFile(tmp, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(tmp, target);
  } catch (error) {
    try {
      await unlink(tmp);
    } catch {
      // 清理失败不掩盖原始错误。
    }
    throw error;
  }
}

/**
 * 解析出真正的写入目标。
 *
 * `memo.md` 可能是用户自己放过去的符号链接 —— 把备忘录软链到网盘 / Syncthing
 * 目录是文档里建议的跨设备同步方式。而 `rename` 替换的是链接本身，链接一断同步
 * 就停了，所以这里先把链接解析成真实路径再写；断链直接报错，不吞掉。
 *
 * @param file - 配置里的文件路径。
 * @returns 实际要写的路径。
 * @throws HttpError 断链的符号链接（409）。
 */
async function resolveWriteTarget(file) {
  try {
    const info = await lstat(file);
    if (!info.isSymbolicLink()) return file;
  } catch (error) {
    // 还没建过：直接按配置的路径写。
    if (error?.code === 'ENOENT') return file;
    throw error;
  }
  try {
    return await realpath(file);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new HttpError(409, '备忘录是一个断链的符号链接，请先修好它');
    throw error;
  }
}

/**
 * 写出 JSON 响应。
 *
 * @param res - 原始响应。
 * @param status - 状态码。
 * @param body - 可序列化对象。
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
    'x-content-type-options': 'nosniff',
  });
  res.end(text);
}

/**
 * 读备忘录。
 *
 * @param res - 原始响应。
 */
async function handleRead(res) {
  const file = memoFile();
  let info = null;
  try {
    info = await stat(file);
  } catch (error) {
    // 第一次用的时候文件不存在是正常情况，不是错误。
    if (error?.code !== 'ENOENT') throw error;
  }

  if (info === null) {
    sendJson(res, 200, { ok: true, exists: false, content: '', path: file, mtimeMs: null, limit: MAX_BYTES });
    return;
  }
  if (!info.isFile()) throw new HttpError(409, '备忘录路径不是一个文件');
  if (info.size > MAX_BYTES) throw new HttpError(413, `备忘录超过 ${MAX_BYTES} 字节，请手动处理这个文件`);

  const content = await readFile(file, 'utf8');
  sendJson(res, 200, { ok: true, exists: true, content, path: file, mtimeMs: info.mtimeMs, limit: MAX_BYTES });
}

/**
 * 写备忘录。
 *
 * @param req - 原始请求。
 * @param res - 原始响应。
 */
async function handleWrite(req, res) {
  const body = await readJsonBody(req, MAX_BYTES + 64 * 1024);
  const content = body['content'];
  if (typeof content !== 'string') throw new HttpError(400, 'content 必须是字符串');
  if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) {
    throw new HttpError(413, `备忘录超过 ${MAX_BYTES} 字节上限`);
  }

  const file = memoFile();
  const target = await resolveWriteTarget(file);
  await mkdir(dirname(target), { recursive: true });
  await writeAtomic(target, content);
  const info = await stat(target);
  // 回给客户端的仍然是配置里那个路径（可能是软链），和读接口保持一致。
  sendJson(res, 200, { ok: true, path: file, size: info.size, mtimeMs: info.mtimeMs });
}

/**
 * 路由处理入口。
 *
 * @param req - 原始请求。
 * @param res - 原始响应。
 * @param logger - 宿主 logger（可缺省）。
 * @param ctx - 宿主插件上下文，用来取 `connection`。
 */
async function handler(req, res, logger, ctx) {
  try {
    const rejection = requestRejection(req, ctx);
    if (rejection === 401) {
      sendJson(res, 401, { error: 'unauthorized: 请重新用带 token 的链接打开此页面' });
      return;
    }
    if (rejection !== undefined) {
      const reason = rejection === 503 ? '宿主缺少 connection 服务，无法校验请求' : 'forbidden: 请求未通过宿主信任校验';
      sendJson(res, rejection, { error: reason });
      return;
    }
    if (req.method === 'GET') {
      await handleRead(res);
      return;
    }
    if (req.method === 'POST') {
      await handleWrite(req, res);
      return;
    }
    sendJson(res, 405, { error: `method not allowed: ${String(req.method)}` });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status === 500) {
      try {
        logger?.warn?.(error);
      } catch {
        // logger 缺失或抛错都不影响响应。
      }
    }
    if (res.headersSent !== true) sendJson(res, status, { error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * 把路由挂到宿主提供的 webServer 上。
 *
 * @param ws - `webServer` 服务。
 * @param host - 用来登记副作用释放与读取 `connection` 的上下文。
 */
function mount(ws, host) {
  host.effect(
    () => ws.register({ kind: 'exact', path: ROUTE, handler: (req, res) => handler(req, res, host.logger, host) }),
    'memo: route',
  );
}

/**
 * 挂载插件。
 *
 * 只等 `webServer`：`connection` 是每次请求时用 `ctx.get` 现取的，避免把整条
 * 路由的生命周期绑死在 Connection 重载上；缺服务时 handler 自己 fail closed。
 *
 * @param ctx - 宿主插件上下文。
 */
export function apply(ctx) {
  const existing = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined;
  if (existing !== undefined && existing !== null) {
    mount(existing, ctx);
    return;
  }
  // 没有 Web 载体（headless / SDK）时这段永远不触发，插件也就不做任何事。
  if (typeof ctx.inject === 'function') ctx.inject(['webServer'], (sub) => mount(sub.webServer, sub));
}
