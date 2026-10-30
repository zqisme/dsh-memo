/**
 * dsh-memo — Host 半边。
 *
 * 只做一件事：读 / 写一个固定的 Markdown 文件。路由挂在官方 `webServer` 上，
 * 客户端半边（./client）用同源 fetch 调它。
 *
 * 刻意保持这么小，是因为 Host 半边有真实的磁盘写权限，代码越少越好审：
 * - **没有路径参数**：文件路径在服务端算好，客户端传不进来，因此没有 `../` 穿越面；
 * - **只接受本机同源请求**：webServer 自身不做鉴权（见 dsh-host-webserver 的说明），
 *   所以这里自己校验回环地址 + Host 头 + 浏览器同源标记，挡住 CSRF；
 * - **原子写**：先写同目录临时文件再 rename，中途失败不会留下半个文件。
 */
import { lstat, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** cordis 插件名（稳定标识，与 cordis.patch.yml 里的行 id 无关）。 */
export const name = 'memo';

/**
 * 不声明必需服务：`webServer` 是可选依赖，用 `ctx.inject(['webServer'])` 惰性等它。
 * 声明成 inject 会让插件在没有 Web 载体的部署（headless / SDK）里永远等下去。
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
 * 地址是否属于回环。socket 地址是权威依据，永不看 X-Forwarded-For。
 *
 * @param address - `req.socket.remoteAddress`。
 * @returns 是否回环。
 */
function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false;
  const value = address.toLowerCase();
  if (value === '::1') return true;
  if (value.startsWith('::ffff:')) return isLoopbackAddress(value.slice(7));
  const parts = value.split('.');
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part));
}

/**
 * 请求级信任围栏：回环地址 + 回环 Host 头 + 浏览器同源标记。
 *
 * @param req - 原始请求。
 * @returns 是否可以继续处理。
 */
function isTrusted(req) {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return false;

  const host = req.headers['host'];
  if (typeof host !== 'string') return false;
  let hostUrl;
  try {
    hostUrl = new URL('http://' + host);
  } catch {
    return false;
  }
  const hostname = hostUrl.hostname.toLowerCase();
  if (hostname !== 'localhost' && hostname !== '[::1]' && !isLoopbackAddress(hostname)) return false;

  // 跨站请求一律拒绝：浏览器里任何页面都不能替用户改备忘录。
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false;

  const origin = req.headers['origin'];
  if (typeof origin !== 'string') return true; // curl / 本地脚本没有 Origin 头
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
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
 */
async function handler(req, res, logger) {
  try {
    if (!isTrusted(req)) {
      sendJson(res, 403, { error: 'forbidden: 只接受本机同源请求' });
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
 * @param host - 用来登记副作用释放的上下文。
 */
function mount(ws, host) {
  host.effect(() => ws.register({ kind: 'exact', path: ROUTE, handler: (req, res) => handler(req, res, host.logger) }), 'memo: route');
}

/**
 * 挂载插件。
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
