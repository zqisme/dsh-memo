// dsh-memo（客户端半边）
//
// 做两件事：
//   1) 左侧栏「备忘录」按钮（官方槽位 sidebar.panellist）
//   2) 主面板一块自动保存的便签（官方槽位 main，key 与按钮 id 相同）
//
// 本文件是**手写的模块表产物**，不是构建出来的：工厂函数收 `require`，
// 最后交出 apply / inject。所以这个插件没有构建步骤，也没有任何三方依赖 ——
// 运行时只用平台已经提供的 react。
window.__ModuleLoader__.load({
  id: 'dsh-memo',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const h = React.createElement;

    /** 只声明 slots：注册槽位是硬依赖，其余（如果有）一律惰性访问。 */
    const inject = ['slots'];

    /** 侧栏按钮 id 与主面板 key 必须一致，框架靠它把「点了按钮」和「显示哪块面板」对上。 */
    const PANEL_ID = 'memo';
    /** Host 半边注册的同名字面量。 */
    const API = '/api/dsh-memo';
    /** 停止输入后多久自动保存（毫秒）。 */
    const SAVE_DELAY = 700;
    /** 浏览器 keepalive 请求体的实际上限约 64KB，超过就不带这个标志。 */
    const KEEPALIVE_LIMIT = 60000;
    /** 正文栏的最大宽度：再宽人扫一行就开始丢行。 */
    const COLUMN_MAX = 820;
    /** 面板窄于这个宽度就收起目录，把空间全给正文。 */
    const OUTLINE_MIN_WIDTH = 900;
    /** 面板偏好的存储键（显示模式、目录开合）。 */
    const PREF_KEY = 'dsh-memo:prefs';

    /**
     * 读面板偏好。
     *
     * 只放「怎么显示」这类无关数据安全的选择，写坏了最多是回到默认值 ——
     * 正文永远只在 memo.md 里，不往这里存。localStorage 不可用（隐私模式、
     * 禁用存储、自测里的假 window）时静默退回空对象。
     *
     * @returns {object} 偏好对象，可能为空。
     */
    function readPrefs() {
      try {
        const raw = window.localStorage.getItem(PREF_KEY);
        const parsed = raw === null ? null : JSON.parse(raw);
        return parsed !== null && typeof parsed === 'object' ? parsed : {};
      } catch {
        return {};
      }
    }

    /**
     * 合并写回偏好。
     *
     * @param patch - 要改的键。
     */
    function savePrefs(patch) {
      try {
        window.localStorage.setItem(PREF_KEY, JSON.stringify(Object.assign(readPrefs(), patch)));
      } catch {
        // 写不进去只是不记偏好，不影响编辑与保存。
      }
    }

    const S = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        boxSizing: 'border-box',
        padding: '16px 20px 12px',
        color: 'var(--dsw-alias-label-primary, inherit)',
        font: 'inherit',
      },
      head: { display: 'flex', alignItems: 'baseline', flex: 'none' },
      title: { fontSize: '15px', fontWeight: 600, letterSpacing: '.01em' },
      status: {
        marginLeft: '10px',
        fontSize: '12px',
        color: 'var(--dsw-alias-label-secondary, #888)',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      },
      outlineToggle: {
        marginLeft: 'auto',
        flex: 'none',
        padding: '2px 10px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l3, rgba(127,127,127,.35))',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, #888)',
        font: 'inherit',
        fontSize: '12px',
        cursor: 'pointer',
      },
      content: { display: 'flex', flex: 1, minHeight: 0, gap: '18px', marginTop: '12px' },
      aside: {
        width: '190px',
        flex: 'none',
        overflowY: 'auto',
        paddingRight: '10px',
        borderRight: '1px solid var(--dsw-alias-border-l3, rgba(127,127,127,.22))',
        fontSize: '12px',
        lineHeight: 1.6,
      },
      asideTitle: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '6px',
        fontSize: '11px',
        letterSpacing: '.08em',
        color: 'var(--dsw-alias-label-secondary, #888)',
        padding: '0 6px 6px',
      },
      /** 目录栏顶部那个紧凑的「+ 新建」：跟列表同宽，不抢视觉。 */
      newSmall: {
        flex: 'none',
        padding: '0 7px',
        borderRadius: '5px',
        border: '1px solid var(--dsw-alias-border-l3, rgba(127,127,127,.35))',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, #888)',
        font: 'inherit',
        fontSize: '11px',
        lineHeight: '18px',
        cursor: 'pointer',
        letterSpacing: 0,
      },
      item: {
        padding: '3px 6px',
        borderRadius: '6px',
        cursor: 'pointer',
        color: 'var(--dsw-alias-label-secondary, #888)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      itemActive: {
        color: 'var(--dsw-alias-label-primary, inherit)',
        background: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12))',
        fontWeight: 500,
      },
      column: { display: 'flex', flex: 1, minWidth: 0 },
      area: {
        flex: 1,
        minHeight: 0,
        width: '100%',
        maxWidth: COLUMN_MAX + 'px',
        margin: '0 auto',
        boxSizing: 'border-box',
        resize: 'none',
        padding: '16px 18px',
        borderRadius: '10px',
        border: '1px solid var(--dsw-alias-border-l3, rgba(127,127,127,.35))',
        background: 'transparent',
        color: 'inherit',
        font: '14px/1.75 var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)',
        tabSize: 2,
        outline: 'none',
      },
      placeholder: {
        flex: 1,
        maxWidth: COLUMN_MAX + 'px',
        margin: '0 auto',
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '13px',
        color: 'var(--dsw-alias-label-secondary, #888)',
        border: '1px dashed var(--dsw-alias-border-l3, rgba(127,127,127,.35))',
        borderRadius: '10px',
      },
      foot: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        flex: 'none',
        marginTop: '8px',
        fontSize: '11px',
        color: 'var(--dsw-alias-label-secondary, #888)',
      },
      path: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '55%' },
      hint: { marginLeft: 'auto', whiteSpace: 'nowrap' },
    };

    /*
     * 派生样式：直接写进 S 字面量里引用不到 S 自己，所以在定义之后补两笔。
     * 标题行右侧那几个按钮长得一样，只差间距 —— 原来是三处 Object.assign 复制粘贴。
     */
    S.headButton = Object.assign({}, S.outlineToggle, { marginLeft: '6px' });
    S.retryButton = {
      padding: '4px 12px',
      borderRadius: '6px',
      border: '1px solid var(--dsw-alias-border-l3, rgba(127,127,127,.35))',
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
      cursor: 'pointer',
    };

    /**
     * 从正文里抽出标题，做成目录。
     *
     * 只认 `#` / `##` / `###` 开头的行，并且**跳过代码块内部** —— 笔记里贴一段
     * shell 注释（`# 建索引`）不该在目录里挂一条。围栏用 ``` 或 ~~~ 都算。
     *
     * @param text - 正文。
     * @returns 标题数组：{ level, text, offset }，offset 是它在全文里的字符位置。
     */
    function parseOutline(text) {
      if (typeof text !== 'string' || text === '') return [];
      const lines = text.split('\n');
      const out = [];
      let fence = null;
      let offset = 0;
      for (const line of lines) {
        const trimmed = line.trim();
        if (fence !== null) {
          // 收尾围栏：同一字符、至少三个、后面没有别的东西。
          if (trimmed.length >= 3 && trimmed.charAt(0) === fence && /^(`{3,}|~{3,})$/.test(trimmed)) fence = null;
        } else if (/^(`{3,}|~{3,})/.test(trimmed)) {
          fence = trimmed.charAt(0);
        } else {
          const match = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(trimmed);
          if (match !== null) out.push({ level: match[1].length, text: match[2], offset });
        }
        offset += line.length + 1;
      }
      return out;
    }

    /**
     * 算出一节的字符区间：从该标题行开始，到**下一个同级或更高级标题**之前。
     *
     * 用它做「只看这一节」：编辑区只显示这段切片，改完再拼回整篇 ——
     * 文件结构不变，仍然是一个 memo.md。
     *
     * @param text - 正文。
     * @param index - 标题在 parseOutline 结果里的序号。
     * @param items - 已经解析好的目录；不传就现解析。
     *   面板里 outline 是 memo 过的，传进来就省掉一次全文扫描（1 MiB 上约 20ms）。
     * @returns { start, end }；序号越界时返回 null（调用处退回整篇）。
     */
    function sectionRange(text, index, items) {
      const list = Array.isArray(items) ? items : parseOutline(text);
      if (!Number.isInteger(index) || index < 0 || index >= list.length) return null;
      const start = list[index].offset;
      let end = text.length;
      for (let i = index + 1; i < list.length; i += 1) {
        if (list[i].level <= list[index].level) {
          end = list[i].offset;
          break;
        }
      }
      return { start, end };
    }

    /**
     * 把节序号钳进合法范围。
     *
     * 选中的序号是状态，正文会变：删掉几个标题后 activeIndex 就可能越界。越界时
     * sectionRange 返回 null，单节模式会「悄悄退回整篇」—— 按钮还写着「看整篇」，
     * 目录却一条不高亮，界面自相矛盾。这里统一钳到最后一节。
     *
     * @param index - 想选中的序号。
     * @param count - 当前目录条数。
     * @returns 合法序号（count 为 0 时返回 0）。
     */
    function clampSectionIndex(index, count) {
      if (!Number.isInteger(index) || index < 0 || count <= 0) return 0;
      return index >= count ? count - 1 : index;
    }

    /**
     * 单节模式打开时该选中哪一节。
     *
     * 一般就是第一节。但 1 级标题在本模型里会把后面所有子节一起吃掉：如果全篇只有
     * 一个 1 级标题、它已经覆盖到文末，那它更像「整篇的壳」（索引、大标题）而不是
     * 「一节」，这时落到它下面的第一节 —— 否则默认单节看起来和整篇一模一样。
     *
     * @param text - 正文。
     * @param outline - parseOutline(text) 的结果。
     * @returns 节序号；永远是合法下标（没有标题时是 0）。
     */
    function defaultSectionIndex(text, outline) {
      const items = Array.isArray(outline) ? outline : parseOutline(text);
      if (items.length < 2 || items[0].level !== 1) return 0;
      const first = sectionRange(text, 0, items);
      return first !== null && first.end >= text.length ? 1 : 0;
    }

    /** 新建一节时先填的占位标题，创建后会被自动选中，直接打字就替换掉。 */
    const NEW_TITLE = '新的一节';

    /**
     * 没有选中任何一节时，新建的节该用几级标题。
     *
     * 只在这时兜底：跟「文档里最后一个标题的级别」走 —— 往文末追加，它就是上一节的
     * 兄弟，同级才对得上。两种常见结构都因此自洽：
     *   - 全用 `#` 分节（`# A` / `# B`）→ 新建还是 `#`；
     *   - 「壳 + 子项」（`# 索引` 下面挂 `## 提示词一`）→ 新建仍是 `##`。
     *     这一条不是口味问题：`#` 级区间会一路延伸到下一个 `#`，追加一个 `##`
     *     会被上一个 `#` 吃掉，压根不算独立的一节。
     *
     * 没有标题时用 1 级（第一行不该是个没有父级的二级标题）。
     *
     * @param text - 当前正文。
     * @returns 1 / 2 / 3。
     */
    function sectionLevel(text) {
      const items = parseOutline(typeof text === 'string' ? text : '');
      if (items.length === 0) return 1;
      const level = items[items.length - 1].level;
      return level >= 1 && level <= 3 ? level : 1;
    }

    /**
     * 在「当前选中的那一节」后面插入一节。
     *
     * 两件事都跟着选中的那一节走：
     *   - **级别**：与它同级（也就是它的下一个兄弟）。选中 `## x` 就新建 `##`，
     *     不会被文末那些 `#` 带跑；
     *   - **位置**：插在它（连同它的子节）的**末尾**，所以在目录里看，新节就紧跟在
     *     选中那一行下面，而不是永远掉到全文最后。
     *
     * 没有选中（还没点过目录、滚动也没定过节、或保存的序号已失效）时退回「文末追加」，
     * 级别见 sectionLevel —— 至少和上一节同级。
     *
     * @param text - 当前正文。
     * @param index - 选中的节序号；-1 / 越界表示没有选中。
     * @returns { text, index, level, selectStart, selectEnd }：新正文、新节在目录里的
     *   序号、标题级别，以及标题在**本节切片内**的起止（供自动选中，省掉一次手打）。
     */
    function insertSection(text, index) {
      const base = typeof text === 'string' ? text : '';
      const items = parseOutline(base);
      const picked = Number.isInteger(index) && index >= 0 && index < items.length ? index : -1;

      const level = picked >= 0 ? items[picked].level : sectionLevel(base);
      const marker = '#'.repeat(level) + ' ';
      // 插在选中节的末尾；没有选中就落在全文末尾。
      const at = picked >= 0 ? sectionRange(base, picked, items).end : base.length;
      const head = base.slice(0, at).replace(/\s+$/, '');
      const rest = base.slice(at);
      const lead = head === '' ? '' : head + '\n\n';
      const body = lead + marker + NEW_TITLE + '\n\n' + rest;

      // 新节的序号要按「正文里新标题落在第几行」现算，不能简单 picked + 1：
      // 选中节若带子节，插入点在整个子树之后，序号要跳过那些子节（见下方测试）。
      const offset = lead.length;
      const found = parseOutline(body).findIndex((item) => item.offset === offset);

      return {
        text: body,
        index: found >= 0 ? found : Math.max(0, parseOutline(body).length - 1),
        level,
        // 新节（只要不是文首那节）切片就从它的标题行开始，所以偏移是标题内的偏移。
        selectStart: marker.length,
        selectEnd: marker.length + NEW_TITLE.length,
      };
    }

    /**
     * 侧栏图标（铅笔便签）。用 currentColor，跟随主题与激活态。
     * @param props - 槽位传入的 { size, active }。
     * @returns svg 元素。
     */
    function MemoGlyph(props) {
      const size = props && typeof props.size === 'number' ? props.size : 18;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M6.5 3.5h8L18.5 7.5v13h-12z' }),
        h('path', { d: 'M14.5 3.5v4h4' }),
        h('path', { d: 'M9.5 12h5.5' }),
        h('path', { d: 'M9.5 15.5h4' }),
      );
    }

    /**
     * 把毫秒时间戳格式化成「时:分」。
     * @param ms - 时间戳。
     * @returns 可读时间；格式化失败时返回空串。
     */
    function clockOf(ms) {
      try {
        return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      } catch {
        return '';
      }
    }

    /**
     * 备忘录主面板。
     * @returns 面板元素。
     */
    function MemoPanel() {
      const [text, setText] = React.useState('');
      const [phase, setPhase] = React.useState('loading');
      const [detail, setDetail] = React.useState('');
      const [file, setFile] = React.useState('');
      const [savedAt, setSavedAt] = React.useState(null);
      const [focused, setFocused] = React.useState(false);
      const [attempt, setAttempt] = React.useState(0);
      const [activeIndex, setActiveIndex] = React.useState(-1);
      /**
       * 目录开合：null = 跟着面板宽度自动收合（默认），true/false = 用户点过，
       * 就按他的意思来。这样才能既保留「窄面板让位给正文」，又不让目录按钮变死键。
       */
      const [outlineOpen, setOutlineOpen] = React.useState(() => {
        const stored = readPrefs().outline;
        return typeof stored === 'boolean' ? stored : null;
      });
      const [roomy, setRoomy] = React.useState(true);
      /**
       * 'whole' = 整篇可编辑；'section' = 只显示目录里选中的那一节。
       *
       * 默认就是 'section'：点进来先看一节，想通读再点「看整篇」。用户切过之后
       * 记住那个选择，所以这里不是硬编码，而是「没存过偏好时的初值」。
       */
      const [mode, setMode] = React.useState(() => (readPrefs().mode === 'whole' ? 'whole' : 'section'));

      const timer = React.useRef(null);
      const dirty = React.useRef(false);
      const pending = React.useRef('');
      const alive = React.useRef(true);
      const rootRef = React.useRef(null);
      const areaRef = React.useRef(null);
      /** 一次性选区请求：新建一节后把占位标题选上（渲染完才落地）。 */
      const selectRef = React.useRef(null);

      const outline = React.useMemo(() => parseOutline(text), [text]);

      /*
       * 「只看单节」的取数：编辑区显示 text 的一个切片。
       *
       * 关键约束是**不引入第二份真值**：切片永远从 text 现算，改动再 splice 回去。
       * 所以无论怎么切换、怎么编辑，磁盘上始终是同一篇 memo.md，也不存在
       * 「段落副本忘了合并」这种状态。
       */
      const sectioned = mode === 'section' && outline.length > 0;
      /*
       * 没显式选过就用默认节：一般是第一节，见 defaultSectionIndex。
       * 只在单节模式下算 —— 整篇模式用不上，别为它多解析一遍全文。
       * 再钳一次：删掉标题后 activeIndex 会越界，越界就等于「悄悄退回整篇」。
       */
      const wanted = activeIndex >= 0 ? activeIndex : sectioned ? defaultSectionIndex(text, outline) : 0;
      const current = clampSectionIndex(wanted, outline.length);
      /*
       * 第一节把文首的前导文字一起带上：标题之前那段字不属于任何一节，
       * 切到单节后如果不管它，就会「看不见但还在文件里」—— 那是最吓人的一种。
       */
      const picked = sectioned ? sectionRange(text, current, outline) : null;
      const range = picked !== null && current === 0 && picked.start > 0 ? { start: 0, end: picked.end } : picked;
      const view = range === null ? text : text.slice(range.start, range.end);

      /** 切换显示模式，并把选择记住（下次点进面板接着上次的样子）。 */
      const chooseMode = (next) => {
        setMode(next);
        savePrefs({ mode: next });
      };

      /*
       * 写请求排队：上一笔没落地就不发下一笔。
       *
       * 服务端每笔都是「写临时文件 + rename」，两笔同时在途时 rename 的完成顺序
       * 不保证等于请求顺序 —— 旧内容可能后落地，而客户端两笔都算成功。串起来最省事。
       * keepalive（关页面时最后一搏）不排队：那一刻要的是「尽量发出去」，
       * 排队等于等一个可能永远跑不完的微任务。
       */
      const queue = React.useRef(null);

      /** 发一次写请求。 */
      const send = React.useCallback((value, keepalive) => {
        const body = JSON.stringify({ content: value });
        const useKeepalive = keepalive === true && body.length < KEEPALIVE_LIMIT;
        const fire = () =>
          fetch(API, {
            method: 'POST',
            keepalive: useKeepalive,
            headers: { 'content-type': 'application/json' },
            body,
          }).then((res) => {
            if (res.ok) return res.json().catch(() => ({}));
            return res
              .json()
              .catch(() => null)
              .then((parsed) => {
                throw new Error(parsed && parsed.error ? parsed.error : 'HTTP ' + String(res.status));
              });
          });

        if (useKeepalive) return fire();

        const previous = queue.current === null ? Promise.resolve() : queue.current;
        // 上一笔失败也要继续发这一笔（失败处理在调用处的 catch 里）。
        const run = previous.then(fire, fire);
        queue.current = run.then(
          () => null,
          () => null,
        );
        return run;
      }, []);

      /** 立刻把待保存内容写下去（如果确实有改动）。 */
      const flush = React.useCallback(() => {
        if (!dirty.current) return;
        const value = pending.current;
        dirty.current = false;
        if (alive.current) setPhase('saving');
        send(value, false)
          .then(() => {
            if (!alive.current) return;
            setPhase('ready');
            setSavedAt(Date.now());
            setDetail('');
          })
          .catch((error) => {
            // 写失败就把脏标记放回去，下次输入 / 失焦 / 切面板还会再试。
            dirty.current = true;
            if (!alive.current) return;
            setPhase('error');
            setDetail(String((error && error.message) || error));
          });
      }, [send]);

      // 载入：进入面板时读一次；失败时给「重试」按钮重跑这里（靠 attempt 触发）。
      React.useEffect(() => {
        alive.current = true;
        let cancelled = false;
        setPhase('loading');
        fetch(API, { headers: { accept: 'application/json' } })
          .then((res) =>
            res
              .json()
              .catch(() => null)
              .then((parsed) => {
                if (!res.ok) throw new Error(parsed && parsed.error ? parsed.error : 'HTTP ' + String(res.status));
                if (parsed === null) throw new Error('宿主返回的内容无法解析');
                return parsed;
              }),
          )
          .then((parsed) => {
            if (cancelled) return;
            const content = typeof parsed.content === 'string' ? parsed.content : '';
            setText(content);
            pending.current = content;
            setFile(typeof parsed.path === 'string' ? parsed.path : '');
            // 用文件自己的 mtime 当「上次保存时间」：刚打开时也能看到它是什么时候存的，
            // 而不是空等第一次保存才出现时间。
            if (typeof parsed.mtimeMs === 'number' && parsed.mtimeMs > 0) setSavedAt(parsed.mtimeMs);
            setPhase('ready');
            setDetail('');
          })
          .catch((error) => {
            if (cancelled) return;
            setPhase('error');
            setDetail(String((error && error.message) || error));
          });

        return () => {
          cancelled = true;
          alive.current = false;
          if (timer.current !== null) {
            clearTimeout(timer.current);
            timer.current = null;
          }
          // 切到别的面板 / 关掉页面时，把还没保存的内容尽力带出去。
          if (dirty.current) {
            const value = pending.current;
            dirty.current = false;
            send(value, true).catch(() => {});
          }
        };
      }, [send, attempt]);

      // 有未保存内容时拦截关闭标签页。
      React.useEffect(() => {
        const onBeforeUnload = (event) => {
          if (!dirty.current) return;
          event.preventDefault();
          event.returnValue = '';
        };
        window.addEventListener('beforeunload', onBeforeUnload);
        return () => window.removeEventListener('beforeunload', onBeforeUnload);
      }, []);

      // 面板宽度：窄了就把目录收起来，别让正文挤成一列字。
      React.useEffect(() => {
        const node = rootRef.current;
        if (node === null || typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver((entries) => {
          const entry = entries[0];
          const width = entry && entry.contentRect ? entry.contentRect.width : 0;
          setRoomy(width >= OUTLINE_MIN_WIDTH);
        });
        observer.observe(node);
        return () => observer.disconnect();
      }, []);

      /*
       * 选区落地：每次渲染后检查有没有「待选区」。
       *
       * 为什么不在 click 里直接 setSelectionRange：那一刻 textarea 还是旧值，
       * 新一节的标题尚未渲染出来，选中会落到错误的位置。等渲染完再选才准。
       */
      React.useEffect(() => {
        const target = selectRef.current;
        if (target === null) return;
        selectRef.current = null;
        const el = areaRef.current;
        if (el === null) return;
        el.focus();
        try {
          el.setSelectionRange(target.start, target.end);
        } catch {
          // 取不到选区不影响输入，忽略。
        }
      });

      const onChange = (event) => {
        const typed = event.target.value;
        // 单节模式：把这一节的改动拼回整篇，再统一走「有改动」的路径。
        const next = range === null ? typed : text.slice(0, range.start) + typed + text.slice(range.end);
        setText(next);
        pending.current = next;
        dirty.current = true;
        setPhase('dirty');
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          timer.current = null;
          flush();
        }, SAVE_DELAY);
      };

      const onKeyDown = (event) => {
        const mod = event.ctrlKey || event.metaKey;
        if (mod && (event.key === 's' || event.key === 'S')) {
          event.preventDefault();
          if (timer.current !== null) {
            clearTimeout(timer.current);
            timer.current = null;
          }
          flush();
        }
      };

      /**
       * 新建一节：插在当前选中的那一节后面（同级），切到单节模式、把占位标题选中，
       * 并立刻落盘。
       *
       * 「选中」取目录里高亮的那一行：单节模式看 current（没点过就是默认节，也正是
       * 面板上显示的那一节），整篇模式看滚动点亮的那一条（没点亮就是 -1，退回文末追加）。
       * 这样按钮永远跟着你眼前的内容走。
       */
      const createSection = () => {
        const created = insertSection(text, sectioned ? current : activeIndex);
        setText(created.text);
        pending.current = created.text;
        dirty.current = true;
        chooseMode('section');
        setActiveIndex(created.index);
        selectRef.current = { start: created.selectStart, end: created.selectEnd };
        // 新节立刻写盘：即使随后马上切走或关页面，这一节也已经存在。
        flush();
      };

      /** 滚到某个标题：先按字符占比估位置，再把光标放过去让浏览器兜底。 */
      const jumpTo = (offset) => {
        const el = areaRef.current;
        if (el === null) return;
        el.focus();
        const ratio = offset / Math.max(1, el.value.length);
        el.scrollTop = Math.max(0, ratio * el.scrollHeight - el.clientHeight / 3);
        try {
          el.setSelectionRange(offset, offset);
        } catch {
          // 某些浏览器在 textarea 不可见时会抛，忽略即可。
        }
      };

      /**
       * 选中某一节（目录行的点击 / 键盘都走这里）。
       *
       * 单节模式下换节要把滚动条归零，否则会停在上一条的中间；整篇模式下则是
       * 把光标/视口挪到那个标题上。
       *
       * @param index - 目录序号。
       * @param offset - 该标题在全文里的字符偏移（整篇模式下用来定位）。
       */
      const focusSection = (index, offset) => {
        setActiveIndex(index);
        if (sectioned) {
          if (areaRef.current !== null) areaRef.current.scrollTop = 0;
        } else {
          jumpTo(offset);
        }
      };

      /** 滚动时点亮「当前段落」那条目录。单节模式下不动 —— 选中项由点击决定。 */
      const onScroll = () => {
        const el = areaRef.current;
        if (el === null || outline.length === 0 || sectioned) return;
        const ratio = (el.scrollTop + el.clientHeight / 3) / Math.max(1, el.scrollHeight);
        const offset = ratio * Math.max(1, el.value.length);
        let index = -1;
        for (let i = 0; i < outline.length; i += 1) if (outline[i].offset <= offset) index = i;
        setActiveIndex((previous) => (previous === index ? previous : index));
      };

      const loaded = phase !== 'loading' && !(phase === 'error' && text === '' && file === '');
      const chars = text.length;
      const showOutline = outline.length > 0 && (outlineOpen === null ? roomy : outlineOpen);

      let statusText;
      if (phase === 'loading') statusText = '载入中…';
      else if (phase === 'saving') statusText = '保存中…';
      else if (phase === 'dirty') statusText = '未保存…';
      else if (phase === 'error') statusText = (text === '' && file === '' ? '读取失败：' : '保存失败：') + detail;
      else if (savedAt !== null) statusText = '已保存 ' + clockOf(savedAt);
      else statusText = '已保存';

      const areaStyle = focused
        ? Object.assign({}, S.area, {
            borderColor: 'var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4c8dff))',
          })
        : S.area;

      const head = h(
        'div',
        { key: 'head', style: S.head },
        h('span', { key: 'title', style: S.title }, '备忘录'),
        h(
          'span',
          {
            key: 'status',
            style: phase === 'error' ? Object.assign({}, S.status, { color: 'var(--dsw-alias-state-error-primary, #d9534f)' }) : S.status,
            title: phase === 'error' ? detail : undefined,
          },
          statusText + (loaded ? ' · ' + chars.toLocaleString() + ' 字' : ''),
        ),
        // 目录栏可见时「+ 新建」在左边栏顶部（跟着便签列表走）；被收起 / 面板太窄 /
        // 还没有任何标题时退回标题行 —— 否则就没地方新建了。
        // 两种情况它都在左边；右边只放那两个开关，靠下面的 spacer 撑开。
        showOutline
          ? null
          : h(
              'button',
              {
                key: 'new',
                type: 'button',
                title: '在当前选中的那一节后面新建一节（仍然是同一个 memo.md）',
                onClick: createSection,
                style: Object.assign({}, S.outlineToggle, { marginLeft: '10px', fontWeight: 500 }),
              },
              '+ 新建',
            ),
        h('span', { key: 'spacer', style: { flex: 1, minWidth: '12px' } }),
        // 这两个开关在窄面板里也不再藏起来：默认进来就是单节，藏了「看整篇」
        // 就退不回去；目录被宽度自动收起时，也得留一个手动打开的入口。
        outline.length > 0
          ? h(
              'button',
              {
                key: 'toggle',
                type: 'button',
                title: showOutline ? '收起左侧目录' : '展开左侧目录',
                onClick: () => {
                  // 按「现在实际看得到什么」取反：自动收起时点一下就变手动展开。
                  const next = !showOutline;
                  setOutlineOpen(next);
                  savePrefs({ outline: next });
                },
                style: S.headButton,
              },
              showOutline ? '收起目录' : '目录',
            )
          : null,
        outline.length > 0
          ? h(
              'button',
              {
                key: 'mode',
                type: 'button',
                title: mode === 'section' ? '回到整篇（所有节一起显示）' : '只显示目录里选中的那一节',
                onClick: () => {
                  const next = mode === 'section' ? 'whole' : 'section';
                  chooseMode(next);
                  if (next === 'section') {
                    // 单节模式靠目录换节：目录收着就等于把人锁在一节里，顺手打开。
                    setOutlineOpen(true);
                    savePrefs({ outline: true });
                    if (areaRef.current !== null) areaRef.current.scrollTop = 0;
                  }
                },
                style: S.headButton,
              },
              mode === 'section' ? '看整篇' : '只看单节',
            )
          : null,
      );

      const aside = showOutline
        ? h(
            'div',
            { key: 'aside', style: S.aside },
            h(
              'div',
              { key: 'at', style: S.asideTitle },
              h('span', { key: 'label' }, '目录'),
              h(
                'button',
                {
                  key: 'new',
                  type: 'button',
                  title: '在当前选中的那一节后面新建一节（仍然是同一个 memo.md）',
                  onClick: createSection,
                  style: S.newSmall,
                },
                '+ 新建',
              ),
            ),
            outline.map((item, index) => {
              const active = index === (sectioned ? current : activeIndex);
              return h(
                'div',
                {
                  key: 'o' + String(index),
                  // 目录行是"按钮"，得能用键盘走：role + tabIndex + Enter/Space。
                  role: 'button',
                  tabIndex: 0,
                  'aria-current': active ? 'true' : undefined,
                  style: active ? Object.assign({}, S.item, S.itemActive) : S.item,
                  title: item.text,
                  onClick: () => focusSection(index, item.offset),
                  onKeyDown: (event) => {
                    if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
                    event.preventDefault();
                    focusSection(index, item.offset);
                  },
                },
                '　'.repeat(Math.max(0, item.level - 1)) + item.text,
              );
            }),
          )
        : null;

      const body = h(
        'div',
        { key: 'column', style: S.column },
        loaded
          ? h('textarea', {
              ref: areaRef,
              value: view,
              onChange,
              onKeyDown,
              onScroll,
              onFocus: () => setFocused(true),
              onBlur: () => {
                setFocused(false);
                flush();
              },
              placeholder: '随手记点什么…',
              spellCheck: false,
              'aria-label': '备忘录',
              style: areaStyle,
            })
          : h(
              'div',
              { style: S.placeholder, key: 'placeholder' },
              phase === 'error'
                ? h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px' } },
                    h('span', null, '读取失败：' + detail),
                    h(
                      'button',
                      {
                        type: 'button',
                        onClick: () => setAttempt((n) => n + 1),
                        style: S.retryButton,
                      },
                      '重试',
                    ),
                  )
                : '载入中…',
            ),
      );

      const foot = h(
        'div',
        { key: 'foot', style: S.foot },
        h('span', { key: 'path', style: S.path, title: file }, file || ''),
        h('span', { key: 'hint', style: S.hint }, 'Ctrl / ⌘ + S 保存 · 停止输入后自动保存'),
      );

      return h('div', { ref: rootRef, style: S.root }, [head, h('div', { key: 'content', style: S.content }, [aside, body]), foot]);
    }

    /**
     * 注册侧栏按钮与主面板。
     * @param ctx - 客户端插件上下文。
     */
    function apply(ctx) {
      // 用 slots.inject 而不是直接 register：槽位由别的插件声明，本插件可能先加载；
      // 未来某个席位被删掉时，这里也只是不显示，不会让启动失败。
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 20,
            label: () => '备忘录',
          },
          MemoGlyph,
        ),
      );

      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: PANEL_ID,
          },
          MemoPanel,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    // 纯函数单独暴露给自测用（不参与运行时契约）。
    exports.__test = { parseOutline, sectionRange, insertSection, defaultSectionIndex, sectionLevel, clampSectionIndex };
    return module.exports;
  },
});
