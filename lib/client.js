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
     * @returns { start, end }；序号越界时返回 null（调用处退回整篇）。
     */
    function sectionRange(text, index) {
      const items = parseOutline(text);
      if (!Number.isInteger(index) || index < 0 || index >= items.length) return null;
      const start = items[index].offset;
      let end = text.length;
      for (let i = index + 1; i < items.length; i += 1) {
        if (items[i].level <= items[index].level) {
          end = items[i].offset;
          break;
        }
      }
      return { start, end };
    }

    /** 新建一节时先填的占位标题，创建后会被自动选中，直接打字就替换掉。 */
    const NEW_TITLE = '新的一节';

    /**
     * 在文末追加一节，返回新正文与新节的序号。
     *
     * 单文件模型下「新建」只能是新建**节**：文件还是一个 memo.md，
     * 新增内容就是文末一段 `## …`。
     *
     * @param text - 当前正文。
     * @returns { text, index, selectStart, selectEnd }：新正文、新节在目录里的序号、
     *   以及标题在**本节切片内**的起止（供自动选中，省掉一次手打）。
     */
    function appendSection(text) {
      const base = typeof text === 'string' ? text.replace(/\s+$/, '') : '';
      const body = (base === '' ? '' : base + '\n\n') + '## ' + NEW_TITLE + '\n\n';
      return {
        text: body,
        index: parseOutline(body).length - 1,
        selectStart: 3,
        selectEnd: 3 + NEW_TITLE.length,
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
      const [outlineOpen, setOutlineOpen] = React.useState(true);
      const [roomy, setRoomy] = React.useState(true);
      /** 'whole' = 整篇可编辑；'section' = 只显示目录里选中的那一节。 */
      const [mode, setMode] = React.useState('whole');

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
      /** 单节模式下没有显式选中过就认第一节，免得一切换就是一片空白。 */
      const current = activeIndex >= 0 ? activeIndex : 0;
      const range = sectioned ? sectionRange(text, current) : null;
      const view = range === null ? text : text.slice(range.start, range.end);

      /** 发一次写请求。 */
      const send = React.useCallback((value, keepalive) => {
        const body = JSON.stringify({ content: value });
        const useKeepalive = keepalive === true && body.length < KEEPALIVE_LIMIT;
        return fetch(API, {
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

      /** 新建一节：文末追加、切到单节模式、把占位标题选中，并立刻落盘。 */
      const createSection = () => {
        const created = appendSection(text);
        setText(created.text);
        pending.current = created.text;
        dirty.current = true;
        setMode('section');
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
      const showOutline = roomy && outlineOpen && outline.length > 0;

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
                title: '在文末新建一节（仍然是同一个 memo.md）',
                onClick: createSection,
                style: Object.assign({}, S.outlineToggle, { marginLeft: '10px', fontWeight: 500 }),
              },
              '+ 新建',
            ),
        h('span', { key: 'spacer', style: { flex: 1, minWidth: '12px' } }),
        outline.length > 0 && roomy
          ? h(
              'button',
              {
                key: 'toggle',
                type: 'button',
                onClick: () => setOutlineOpen((open) => !open),
                style: Object.assign({}, S.outlineToggle, { marginLeft: '6px' }),
              },
              outlineOpen ? '收起目录' : '目录',
            )
          : null,
        outline.length > 0 && roomy
          ? h(
              'button',
              {
                key: 'mode',
                type: 'button',
                title: mode === 'section' ? '回到整篇（所有节一起显示）' : '只显示目录里选中的那一节',
                onClick: () => {
                  const next = mode === 'section' ? 'whole' : 'section';
                  setMode(next);
                  if (next === 'section' && areaRef.current !== null) areaRef.current.scrollTop = 0;
                },
                style: Object.assign({}, S.outlineToggle, { marginLeft: '6px' }),
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
                  title: '在文末新建一节（仍然是同一个 memo.md）',
                  onClick: createSection,
                  style: S.newSmall,
                },
                '+ 新建',
              ),
            ),
            outline.map((item, index) =>
              h(
                'div',
                {
                  key: 'o' + String(index),
                  style: index === (sectioned ? current : activeIndex) ? Object.assign({}, S.item, S.itemActive) : S.item,
                  title: item.text,
                  onClick: () => {
                    setActiveIndex(index);
                    if (sectioned) {
                      // 单节模式：换一节就把滚动条归零，否则会停在上一条的中间。
                      if (areaRef.current !== null) areaRef.current.scrollTop = 0;
                    } else {
                      jumpTo(item.offset);
                    }
                  },
                },
                '　'.repeat(Math.max(0, item.level - 1)) + item.text,
              ),
            ),
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
                        style: {
                          padding: '4px 12px',
                          borderRadius: '6px',
                          border: '1px solid var(--dsw-alias-border-l3, rgba(127,127,127,.35))',
                          background: 'transparent',
                          color: 'inherit',
                          font: 'inherit',
                          cursor: 'pointer',
                        },
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
    exports.__test = { parseOutline, sectionRange, appendSection };
    return module.exports;
  },
});
