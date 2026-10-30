/**
 * dsh-memo 客户端半边自测（不依赖浏览器 / DSH 进程）。
 *
 * 跑法：node test/client.test.mjs
 * 覆盖：模块表工厂格式、apply 里的两个槽位注册、面板能渲染出树而不抛错。
 *
 * 这里的 React 是**最小替身**：只够跑一遍渲染，验证 hook 顺序与元素结构，
 * 不验证真实交互（那要在 GUI 里点）。
 */
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 捕获模块表注册。 */
let registration = null;
globalThis.window = {
  __ModuleLoader__: {
    load(reg) {
      registration = reg;
    },
  },
  addEventListener() {},
  removeEventListener() {},
};

/** fetch 替身：读到一份固定内容。 */
let postCalls = [];
globalThis.fetch = async (url, options = {}) => {
  if (options.method === 'POST') {
    postCalls.push({ url, body: options.body, keepalive: options.keepalive });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, exists: true, content: '旧内容', path: '/home/u/.dsh/memo/memo.md' }),
  };
};

/** 最小 React 替身：单次渲染用。 */
const hookState = [];
let hookIndex = 0;
const effects = [];
const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat() };
  },
  useState(initial) {
    const index = hookIndex++;
    if (!(index in hookState)) hookState[index] = typeof initial === 'function' ? initial() : initial;
    return [hookState[index], (next) => { hookState[index] = next; }];
  },
  useRef(initial) {
    const index = hookIndex++;
    if (!(index in hookState)) hookState[index] = { current: initial };
    return hookState[index];
  },
  useCallback(fn) {
    hookIndex++;
    return fn;
  },
  useMemo(fn) {
    hookIndex++;
    return fn();
  },
  useEffect(fn) {
    hookIndex++;
    effects.push(fn);
  },
};

const bundle = fileURLToPath(new URL('../lib/client.js', import.meta.url));

await import(pathToFileURL(bundle).href);

assert.ok(registration !== null, '客户端 bundle 必须调用 __ModuleLoader__.load');
assert.equal(registration.id, 'dsh-memo');
assert.equal(typeof registration.factory, 'function');

const mod = registration.factory((spec) => {
  assert.equal(spec, 'react', '客户端只应 require 平台自带的 react');
  return React;
});

assert.deepEqual(mod.inject, ['slots']);
assert.equal(typeof mod.apply, 'function');

/** 收集槽位注册。 */
const registrations = [];
const ctx = {
  slots: {
    inject(name, callback) {
      callback();
    },
    register(meta, component) {
      registrations.push({ meta, component });
      return () => {};
    },
  },
};

mod.apply(ctx);

assert.equal(registrations.length, 2, '应注册侧栏按钮与主面板两项');
const sidebar = registrations.find((r) => r.meta.name === 'sidebar.panellist');
const main = registrations.find((r) => r.meta.name === 'main');

assert.ok(sidebar, '缺少 sidebar.panellist 注册');
assert.ok(main, '缺少 main 注册');
assert.equal(sidebar.meta.id, 'memo');
assert.equal(main.meta.key, 'memo', '主面板 key 必须与侧栏按钮 id 一致');
assert.equal(typeof sidebar.meta.label, 'function');
assert.equal(sidebar.meta.label(), '备忘录');
assert.equal(typeof sidebar.meta.order, 'number');
assert.equal(typeof sidebar.component, 'function');
assert.equal(typeof main.component, 'function');

// 图标：能接受槽位传入的 { size, active } 并返回 svg 树。
const glyph = sidebar.component({ size: 16, active: true });
assert.equal(glyph.type, 'svg');
assert.equal(glyph.props.width, 16);

// 面板：跑一遍渲染（hook 顺序、元素结构、无异常）。
hookIndex = 0;
const tree = main.component({});
assert.equal(tree.type, 'div');
const text = JSON.stringify(tree);
assert.ok(text.includes('备忘录'), '面板标题缺失');
assert.ok(text.includes('载入中'), '初次渲染应有载入态');
// 还没有任何标题时，新建按钮必须回退到标题行 —— 否则新建入口就消失了。
assert.ok(text.includes('+ 新建'), '没有目录时新建按钮应出现在标题行');
assert.ok(text.includes('"spacer"'), '标题行应有撑开左右的占位元素');

// 载入 effect：fetch 返回固定内容后不应抛错。
hookIndex = 0;
effects.length = 0;
main.component({});
assert.equal(effects.length, 4, '应登记载入、beforeunload、宽度监听、选区落地四个 effect');
const cleanups = effects.map((fn) => fn());
await new Promise((resolve) => setTimeout(resolve, 10));
for (const cleanup of cleanups) if (typeof cleanup === 'function') cleanup();

// 目录解析：只认 1-3 级标题，且跳过代码块内部。
const { parseOutline } = mod.__test;
assert.deepEqual(parseOutline(''), []);
assert.deepEqual(parseOutline('没有标题的正文\n第二行'), []);

const sample = [
  '# 索引',
  '',
  '## 提示词一',
  '```sh',
  '# 这不是标题',
  '```',
  '## 提示词二',
  '~~~',
  '## 这也不是',
  '~~~',
  '### 子节',
  '#### 四级不算',
].join('\n');

const items = parseOutline(sample);
assert.deepEqual(
  items.map((item) => item.text),
  ['索引', '提示词一', '提示词二', '子节'],
  '代码块里的 # 与四级标题都不该进目录',
);
assert.deepEqual(
  items.map((item) => item.level),
  [1, 2, 2, 3],
);
// offset 必须指回原文那一行，否则点击跳转会偏。
const headingOne = '## 提示词一';
const headingSub = '### 子节';
assert.equal(sample.slice(items[1].offset, items[1].offset + headingOne.length), headingOne);
assert.equal(sample.slice(items[3].offset, items[3].offset + headingSub.length), headingSub);

// 单节区间：到下一个同级或更高级标题为止。
const { sectionRange } = mod.__test;
assert.equal(sectionRange('', 0), null);
assert.equal(sectionRange(sample, -1), null);
assert.equal(sectionRange(sample, 99), null);

// 1 级节包含它下面所有子节，所以一直到文末。
const s0 = sectionRange(sample, 0);
assert.equal(s0.end, sample.length, '1 级节的区间应延伸到文末（它吃掉所有子节）');

const s1 = sectionRange(sample, 1);
const t1 = sample.slice(s1.start, s1.end);
assert.ok(t1.startsWith('## 提示词一'));
assert.ok(t1.includes('# 这不是标题'), '代码块里的内容仍属于本节正文');
assert.ok(!t1.includes('## 提示词二'));

const s2 = sectionRange(sample, 2);
assert.ok(sample.slice(s2.start, s2.end).includes('### 子节'), '2 级节的区间包含它下面的 3 级节');
assert.equal(sectionRange(sample, 3).end, sample.length, '最后一个 3 级节延伸到文末');

// 新建一节：文末追加、序号正确、占位标题的选区落在本节切片内。
const { appendSection } = mod.__test;
const bare = appendSection('');
assert.equal(bare.text, '## 新的一节\n\n');
assert.equal(bare.index, 0);

const appended = appendSection('## A\n内容');
assert.equal(appended.text, '## A\n内容\n\n## 新的一节\n\n');
assert.equal(appended.index, 1);
assert.equal(appended.selectStart, 3);
assert.equal(appended.selectEnd, 3 + '新的一节'.length);

// 已有尾随空行时不重复叠加，避免越建越多空行。
assert.equal(appendSection('## A\n内容\n\n\n').text, '## A\n内容\n\n## 新的一节\n\n');

console.log('client.test.mjs: 全部通过');
