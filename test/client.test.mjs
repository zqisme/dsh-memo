/**
 * dsh-memo 客户端半边自测（不依赖浏览器 / DSH 进程）。
 *
 * 跑法：node test/client.test.mjs
 * 覆盖：模块表工厂格式、apply 里的两个槽位注册、面板能渲染出树而不抛错、
 *       默认「只看单节」与偏好记忆、新建定位、写串行、离开再回来时回到上次那一节。
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

/** fetch 替身：读到一份固定内容（具体内容由各用例改 loadContent）。 */
let postCalls = [];
let loadContent = '旧内容';
globalThis.fetch = async (url, options = {}) => {
  if (options.method === 'POST') {
    postCalls.push({ url, body: options.body, keepalive: options.keepalive });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, exists: true, content: loadContent, path: '/home/u/.dsh/memo/memo.md' }),
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
// 这里只要求「至少登记了四个」，不锁死个数 —— 以后加 effect 不该让这条先红，
// 真正的行为断言在下面的用例里。
hookIndex = 0;
effects.length = 0;
main.component({});
assert.ok(effects.length >= 4, '应登记载入、beforeunload、宽度监听、选区落地等 effect');
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

// 传入已解析的目录时结果必须一样（面板正是这么复用的，省掉每帧一次全文扫描）。
assert.deepEqual(sectionRange(sample, 1, parseOutline(sample)), sectionRange(sample, 1), '传目录与现解析应等价');
assert.equal(sectionRange(sample, 99, parseOutline(sample)), null, '越界仍然返回 null');

// 序号钳位：删标题会让 activeIndex 越界，越界就等于「悄悄退回整篇」。
const { clampSectionIndex } = mod.__test;
assert.equal(clampSectionIndex(5, 3), 2, '越界钳到最后一节');
assert.equal(clampSectionIndex(2, 3), 2, '合法序号原样返回');
assert.equal(clampSectionIndex(-1, 3), 0, '没选中当作第一节');
assert.equal(clampSectionIndex(0, 0), 0, '没有标题时返回 0');

// 新建一节：级别与位置都跟着「当前选中的那一节」，没选中才退回文末追加。
const { insertSection } = mod.__test;

// 空文档 / 没有选中：1 级、追加到文末。
const bare = insertSection('', -1);
assert.equal(bare.text, '# 新的一节\n\n');
assert.equal(bare.index, 0);
assert.equal(bare.level, 1);
assert.equal(bare.selectStart, 2);
assert.equal(bare.selectEnd, 2 + '新的一节'.length);

// 没选中且已有标题：级别跟最后一个标题，位置在文末。
const tailCase = insertSection('# 第一篇\n内容\n', -1);
assert.equal(tailCase.text, '# 第一篇\n内容\n\n# 新的一节\n\n');
assert.equal(tailCase.index, 1);
assert.equal(tailCase.level, 1);

// 上一节是 ### 时兜底也跟着走。
assert.equal(insertSection('# A\n\n### 细节\n内容', -1).text, '# A\n\n### 细节\n内容\n\n### 新的一节\n\n');

// 已有尾随空行时不重复叠加，避免越建越多空行。
assert.equal(insertSection('## A\n内容\n\n\n', -1).text, '## A\n内容\n\n## 新的一节\n\n');

// 选中第一个 # 节 → 新节是同级的 #，插在它和下一节之间（不是文末）。
const twoTop = '# A\n\n内容A\n\n# B\n\n内容B\n';
const midTop = insertSection(twoTop, 0);
assert.equal(midTop.text, '# A\n\n内容A\n\n# 新的一节\n\n# B\n\n内容B\n');
assert.equal(midTop.index, 1);
assert.equal(midTop.level, 1);

// 选中 ## 节（最常见的场景）：新节是 ##，紧跟在它后面。
const nested = '# 索引\n\n## 提示词一\n\n内容一\n\n## 提示词二\n\n内容二\n';
const nestedIn = insertSection(nested, 1);
assert.equal(nestedIn.text, '# 索引\n\n## 提示词一\n\n内容一\n\n## 新的一节\n\n## 提示词二\n\n内容二\n');
assert.equal(nestedIn.index, 2);
assert.equal(nestedIn.level, 2);
assert.equal(nestedIn.selectStart, 3);
assert.equal(nestedIn.selectEnd, 3 + '新的一节'.length);

// 选中的是「壳」（区间到文末）：新节插在整棵子树后面，仍是同级。
const shellTree = '# 索引\n\n## a\n\n甲\n\n## b\n\n乙\n';
assert.equal(
  insertSection(shellTree, 0).text,
  '# 索引\n\n## a\n\n甲\n\n## b\n\n乙\n\n# 新的一节\n\n',
  '选中 # 壳时新节应在它的子树之后，且同为 #',
);

// 序号越界当作没选中。
assert.equal(insertSection(twoTop, 99).index, parseOutline(twoTop).length);

// 选中带子节的 #：新节排在整棵子树之后，序号必须跳过子节，不能只 +1。
// （回归：曾经返回 picked + 1，于是新建后高亮/编辑区落到子节上。）
const withChild = '# A\n\n## a1\n\n内容\n\n# B\n\n内容B\n';
const skipped = insertSection(withChild, 0);
assert.equal(skipped.index, 2, '带一个子节时应落在第 2 位');
assert.equal(parseOutline(skipped.text)[skipped.index].text, '新的一节', '序号必须指向新节本身');
assert.equal(skipped.level, 1, '新节级别仍是选中节的级别');

// 级别兜底判定：只认 1-3 级，没有标题时退回 1 级。
const { sectionLevel } = mod.__test;
assert.equal(sectionLevel(''), 1);
assert.equal(sectionLevel('正文而已'), 1);
assert.equal(sectionLevel('# 索引\n\n## 提示词一'), 2);
assert.equal(sectionLevel('# A\n\n# B'), 1);
assert.equal(sectionLevel('## A\n\n### B'), 3);

// 默认选中哪一节：唯一的 1 级标题若吃掉全篇，就当「壳」跳过。
const { defaultSectionIndex } = mod.__test;
const shellDoc = '# 索引\n\n## 提示词一\n\n内容一\n\n## 提示词二\n\n内容二\n';
assert.equal(defaultSectionIndex(shellDoc, parseOutline(shellDoc)), 1, '壳级标题应让位给它下面的第一节');
const multiTop = '# A\n\n甲\n\n# B\n\n乙\n';
assert.equal(defaultSectionIndex(multiTop, parseOutline(multiTop)), 0, '有多个 1 级节时仍从第一节开始');
const flatDoc = '## 一\n\n甲\n\n## 二\n\n乙\n';
assert.equal(defaultSectionIndex(flatDoc, parseOutline(flatDoc)), 0, '没有 1 级标题时就是第一节');
assert.equal(defaultSectionIndex('', []), 0, '没有标题时退回 0');
assert.equal(defaultSectionIndex(sample, parseOutline(sample)), 1, '只有 # 索引 一个 1 级标题时也跳过它');

// 「上次看的那一节」认不认得回来：标题文字是主键，序号只在文字没了时兜底。
const { resolveSectionIndex } = mod.__test;
const bookmarkDoc = '# A\n\n## 一\n\n## 二\n\n# B\n';
assert.equal(resolveSectionIndex({ level: 1, text: 'B', index: 3 }, parseOutline(bookmarkDoc)), 3, '按文字认回来');

// 在它前面插了一节：序号变了，文字还认得 —— 这正是只存序号会错的地方。
const grownDoc = '# 新\n\n# A\n\n## 一\n\n## 二\n\n# B\n';
assert.equal(
  resolveSectionIndex({ level: 1, text: 'B', index: 3 }, parseOutline(grownDoc)),
  4,
  '前面多了一节也不影响，位置跟着文字走',
);

// 重名多条：取离原序号最近的那个。
const dupDoc = parseOutline('## 备注\n\n甲\n\n## 备注\n\n乙\n');
assert.equal(resolveSectionIndex({ level: 2, text: '备注', index: 1 }, dupDoc), 1, '重名时取离原序号最近的（后一条）');
assert.equal(resolveSectionIndex({ level: 2, text: '备注', index: 0 }, dupDoc), 0, '重名时取离原序号最近的（前一条）');
assert.equal(resolveSectionIndex({ text: '备注' }, dupDoc), 0, '没存序号时当作从 0 找起');

// 级别不同的同名标题不算同一节：文字对不上就退回序号。
assert.equal(
  resolveSectionIndex({ level: 3, text: '备注', index: 2 }, parseOutline('## A\n\n## 备注\n\n## C\n')),
  2,
  '级别对不上时不该认成那个 ## 节',
);

// 标题改名 / 删掉：退回序号并钳进范围，落在附近而不是跳回最开头。
assert.equal(resolveSectionIndex({ level: 1, text: '已删掉', index: 1 }, parseOutline('# A\n\n# B\n\n# C\n')), 1);
assert.equal(resolveSectionIndex({ level: 1, text: '已删掉', index: 99 }, parseOutline('# A\n\n# B\n')), 1, '序号越界时钳到最后一节');

// 认不出来的各种情况统一返回 -1，让调用处走 defaultSectionIndex。
assert.equal(resolveSectionIndex(null, parseOutline(bookmarkDoc)), -1, '没存过');
assert.equal(resolveSectionIndex({ level: 1, text: 'A' }, []), -1, '正文没有标题');
assert.equal(resolveSectionIndex({}, parseOutline(bookmarkDoc)), -1, '书签是空的');
assert.equal(resolveSectionIndex('坏数据', parseOutline(bookmarkDoc)), -1, '书签类型不对也不炸');

// ——— 显示模式：默认「只看单节」，并把选择记住 ———

/** 拼一个最小 localStorage：只实现本插件用到的那三个方法。 */
globalThis.window.localStorage = {
  store: new Map(),
  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  },
  setItem(key, value) {
    this.store.set(key, String(value));
  },
  removeItem(key) {
    this.store.delete(key);
  },
};

/** 把渲染树压平，方便按类型 / 文案找节点。 */
function flatten(node, out = []) {
  if (node === null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out);
    return out;
  }
  out.push(node);
  if (node.children) flatten(node.children, out);
  return out;
}
const findArea = (tree) => flatten(tree).find((n) => n.type === 'textarea');
const findButton = (tree, label) => flatten(tree).find((n) => n.type === 'button' && (n.children || []).includes(label));
const prefs = () => JSON.parse(globalThis.window.localStorage.getItem('dsh-memo:prefs') ?? '{}');

/** 再渲染一次（不动 effect）：替身 React 不自动重渲染，手动来。 */
function rerender() {
  hookIndex = 0;
  effects.length = 0;
  return main.component({});
}

/** 等一拍：写请求现在排队发出，fetch 要到下一轮微任务才会被调用。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * 跑一遍完整生命周期：清空 hook → 首渲染 → 跑 effect（拉取正文）→ 再渲染。
 * 替身 React 不会自动重渲染，所以这里手动来第二遍，拿到的才是载入后的树。
 */
async function renderLoaded() {
  hookState.length = 0;
  hookIndex = 0;
  effects.length = 0;
  main.component({});
  const cleanups = effects.map((fn) => fn());
  await new Promise((resolve) => setTimeout(resolve, 10));
  hookIndex = 0;
  effects.length = 0;
  const tree = main.component({});
  for (const cleanup of cleanups) if (typeof cleanup === 'function') cleanup();
  return tree;
}

const head = '前言\n\n';
const firstSlice = '## 提示词一\n\n内容一\n\n';
const tail = '## 提示词二\n\n内容二\n';
const doc = head + firstSlice + tail;
loadContent = doc;

// 1) 没存过偏好 → 点进来就是单节：编辑区只有第一节，按钮是「看整篇」。
//    文首前导文字跟着第一节走，所以这里期望 head + firstSlice。
let tree2 = await renderLoaded();
assert.equal(
  findArea(tree2).props.value,
  head + firstSlice,
  '默认应只显示第一节（含文首前导），而不是整篇',
);
assert.ok(findButton(tree2, '看整篇'), '单节模式下按钮文案应是「看整篇」');
assert.ok(findButton(tree2, '收起目录'), '面板够宽时目录默认展开，按钮应是「收起目录」');
assert.ok(!findButton(tree2, '只看单节'), '单节模式下不该同时出现「只看单节」');

// 2) 切一次「看整篇」→ 写进偏好，下次进来就是整篇。
findButton(tree2, '看整篇').props.onClick();
assert.equal(prefs().mode, 'whole', '切换模式后应写入偏好');

tree2 = await renderLoaded();
assert.equal(findArea(tree2).props.value, doc, '记住「整篇」后应显示全文');
assert.ok(findButton(tree2, '只看单节'), '整篇模式下按钮文案应是「只看单节」');

// 3) 目录收起后再切单节：应顺手把目录打开 —— 单节模式靠目录换节。
findButton(tree2, '收起目录').props.onClick();
assert.equal(prefs().outline, false, '收起目录后应写入偏好');

tree2 = await renderLoaded();
assert.ok(!findButton(tree2, '收起目录'), '偏好为收起时不应渲染目录');
assert.equal(findArea(tree2).props.value, doc, '目录收起不影响整篇视图');

findButton(tree2, '只看单节').props.onClick();
assert.equal(prefs().outline, true, '切到单节模式应把目录一并打开');

// 4) 单节里改的内容必须拼回整篇 —— 切片视图不能变成第二份真值。
tree2 = await renderLoaded(); // 上一步刚切到单节，偏好记住了
assert.equal(findArea(tree2).props.value, head + firstSlice, '记住「单节」后点进来就只看第一节');

const edited = head + '## 提示词一\n\n改过了\n';
findArea(tree2).props.onChange({ target: { value: edited } });
hookIndex = 0;
effects.length = 0;
tree2 = main.component({});
assert.equal(findArea(tree2).props.value, edited, '单节视图应显示改后的内容');

findButton(tree2, '看整篇').props.onClick();
hookIndex = 0;
effects.length = 0;
tree2 = main.component({});
assert.equal(findArea(tree2).props.value, edited + tail, '单节里的修改必须拼回整篇');

// 5) 只有「壳」级 1 级标题时，默认单节落在它下面的第一节，而不是把整篇当成一节。
globalThis.window.localStorage.removeItem('dsh-memo:prefs');
loadContent = shellDoc;
tree2 = await renderLoaded();
assert.equal(
  findArea(tree2).props.value,
  '## 提示词一\n\n内容一\n\n',
  '壳级 # 索引 底下应直接落到第一个 ## 节',
);

// 6) 目录里选中某一节后点「+ 新建」：级别 / 位置都跟着选中的那一节走。
//    这是「选中 ## 却新建出 # 并掉到文末」那个 bug 的回归测试。
globalThis.window.localStorage.removeItem('dsh-memo:prefs');
loadContent = shellDoc;
tree2 = await renderLoaded();
const outlineRow = flatten(tree2).find(
  (node) => node.props && node.props.title === '提示词一' && typeof node.props.onClick === 'function',
);
assert.ok(outlineRow, '目录里应能点到「提示词一」');
outlineRow.props.onClick();
tree2 = rerender();

postCalls = [];
findButton(tree2, '+ 新建').props.onClick();
await settle();
assert.equal(postCalls.length, 1, '新建应落盘一次');
const posted = JSON.parse(postCalls[0].body).content;
assert.ok(posted.includes('## 新的一节'), '选中 ## 时应新建 ##，不该是 #');
assert.ok(posted.indexOf('## 新的一节') > posted.indexOf('## 提示词一'), '应插在选中节之后');
assert.ok(posted.indexOf('## 新的一节') < posted.indexOf('## 提示词二'), '应插在下一节之前，而不是文末');

// 7) 单节模式下没点过目录也不要紧：新建跟着「面板上显示的那一节」走。
globalThis.window.localStorage.removeItem('dsh-memo:prefs');
loadContent = shellDoc;
tree2 = await renderLoaded();
postCalls = [];
findButton(tree2, '+ 新建').props.onClick();
await settle();
const postedDefault = JSON.parse(postCalls[0].body).content;
assert.ok(postedDefault.includes('## 新的一节'), '默认落在 ## 节时就该新建 ##');
assert.ok(
  postedDefault.indexOf('## 新的一节') < postedDefault.indexOf('## 提示词二'),
  '应紧跟在当前显示的那一节后面',
);

// 8) 选中「带子节的顶层节」再新建：目录高亮与编辑区都要落在**新节**上，
//    而不是它的第一个子节（截图里那个「选中了 ## 做什么」的 bug）。
globalThis.window.localStorage.removeItem('dsh-memo:prefs');
loadContent = '# 建立索引?\n\n## 做什么\n\n内容\n\n# 备忘录\n\n内容B\n';
tree2 = await renderLoaded();
const topRow = flatten(tree2).find(
  (node) => node.props && node.props.title === '建立索引?' && typeof node.props.onClick === 'function',
);
assert.ok(topRow, '目录里应能点到「建立索引?」');
topRow.props.onClick();
tree2 = rerender();

postCalls = [];
findButton(tree2, '+ 新建').props.onClick();
await settle();
const postedChild = JSON.parse(postCalls[0].body).content;
assert.ok(postedChild.indexOf('# 新的一节') > postedChild.indexOf('## 做什么'), '新节应在子节之后');
assert.ok(postedChild.indexOf('# 新的一节') < postedChild.indexOf('# 备忘录'), '新节应在下一节之前');

tree2 = rerender();
assert.equal(
  findArea(tree2).props.value,
  '# 新的一节\n\n',
  '新建后编辑区应停在新节上，而不是它前面的子节',
);

// 9) 删掉标题让选中序号越界时，单节视图要钳到最后一节，不能悄悄退回整篇。
globalThis.window.localStorage.removeItem('dsh-memo:prefs');
loadContent = '# A\n\n甲\n\n# B\n\n乙\n\n# C\n\n丙\n';
tree2 = await renderLoaded();
const rowC = flatten(tree2).find(
  (node) => node.props && node.props.title === 'C' && typeof node.props.onClick === 'function',
);
assert.ok(rowC, '目录里应能点到「C」');
rowC.props.onClick();
tree2 = rerender();
assert.equal(findArea(tree2).props.value, '# C\n\n丙\n', '先切到最后一节');

// 把这一节整段删掉 → 目录只剩 2 条，而 activeIndex 还是 2。
findArea(tree2).props.onChange({ target: { value: '' } });
tree2 = rerender();
assert.equal(
  findArea(tree2).props.value,
  '# B\n\n乙\n\n',
  '序号越界时应钳到最后一节，而不是显示整篇',
);

// 10) 两笔保存串行：上一笔没落地，下一笔不会提前发出（否则 rename 可能倒序）。
const originalFetch = globalThis.fetch;
const sent = [];
const releases = [];
globalThis.fetch = (url, options = {}) => {
  // 读请求（GET）照旧走替身；只接管写请求。
  if (options.method !== 'POST') return originalFetch(url, options);
  sent.push(JSON.parse(options.body).content);
  return new Promise((resolve) => {
    releases.push(() => resolve({ ok: true, status: 200, json: async () => ({ ok: true }) }));
  });
};

loadContent = '';
tree2 = await renderLoaded();
findArea(tree2).props.onChange({ target: { value: 'A' } });
findArea(tree2).props.onBlur();
await settle();
assert.equal(sent.length, 1, '第一笔应已发出');

findArea(tree2).props.onChange({ target: { value: 'AB' } });
findArea(tree2).props.onBlur();
await settle();
assert.equal(sent.length, 1, '上一笔没落地时，第二笔不该发出');

releases[0]();
await settle();
await settle();
assert.equal(sent.length, 2, '上一笔落地后才发第二笔');
assert.equal(sent[1], 'AB', '第二笔带的是最新内容');

releases[1]();
await settle();
globalThis.fetch = originalFetch;

// 11) 离开面板再回来：应回到上次看的那一节，而不是第一节。
//     每切一次界面主面板都会卸载重建，state 归零 —— 这是「总是回到第一项」的根因。
globalThis.window.localStorage.removeItem('dsh-memo:prefs');
loadContent = '# A\n\n甲\n\n# B\n\n乙\n\n# C\n\n丙\n';
tree2 = await renderLoaded();
const rowB = flatten(tree2).find(
  (node) => node.props && node.props.title === 'B' && typeof node.props.onClick === 'function',
);
assert.ok(rowB, '目录里应能点到「B」');
rowB.props.onClick();
tree2 = rerender();
assert.equal(findArea(tree2).props.value, '# B\n\n乙\n\n', '先切到 B 节');
assert.deepEqual(prefs().section, { level: 1, text: 'B', index: 1 }, '换节应把书签写进偏好');

tree2 = await renderLoaded();
assert.equal(findArea(tree2).props.value, '# B\n\n乙\n\n', '再点进来应回到上次那一节');

// 标题被改名（文字认不回来）时退回序号：还留在附近，不会跳回开头。
loadContent = '# A\n\n甲\n\n# B 改名了\n\n乙\n\n# C\n\n丙\n';
tree2 = await renderLoaded();
assert.equal(findArea(tree2).props.value, '# B 改名了\n\n乙\n\n', '标题改名后应按序号落在原位置附近');

// 显式选过「壳」级标题时也一样：用户自己点的，回来就还是它（不走默认跳过壳的规则）。
globalThis.window.localStorage.removeItem('dsh-memo:prefs');
loadContent = shellDoc;
tree2 = await renderLoaded();
const rowShell = flatten(tree2).find(
  (node) => node.props && node.props.title === '索引' && typeof node.props.onClick === 'function',
);
rowShell.props.onClick();
tree2 = rerender();
assert.equal(findArea(tree2).props.value, shellDoc, '选中壳级标题时单节视图就是整篇');
tree2 = await renderLoaded();
assert.equal(findArea(tree2).props.value, shellDoc, '回来仍停在壳级标题上，不被默认规则拽去第一个子节');

// 12) 新建一节后离开再回来：应停在新节上（书签跟着新建走）。
globalThis.window.localStorage.removeItem('dsh-memo:prefs');
loadContent = '# 索引\n\n## 提示词一\n\n内容一\n\n## 提示词二\n\n内容二\n';
tree2 = await renderLoaded();
postCalls = [];
findButton(tree2, '+ 新建').props.onClick();
await settle();
assert.equal(prefs().section.text, '新的一节', '新建后书签应指向新节');
loadContent = JSON.parse(postCalls[0].body).content; // 假装已经落盘，再读回来
tree2 = await renderLoaded();
assert.equal(findArea(tree2).props.value, '## 新的一节\n\n', '再进来应停在新节上');

console.log('client.test.mjs: 全部通过');
