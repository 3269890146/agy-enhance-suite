/**
 * 文件职责：Antigravity 产出文件右键菜单模块（在外部文件管理器中打开所在文件夹 / 用系统默认程序打开 / 复制路径）
 * 项目角色：由 `wallpaper-bridge.js` 受控加载与卸载（遵循 `ctx.onCleanup` 生命周期，热重载零残留）。
 * 核心机制：
 *   1. 监听捕获阶段 `contextmenu` 事件；按住 `Shift` 键右键时直接放行浏览器原生菜单；
 *   2. 智能识别聊天回复与文件列表里的 `[data-uri]`、`a[href^="file:"]`、`a[href^="vscode-"]`、`[data-path]`、
 *      `[class*="group/file-title"]`、`a.inline-pill` 及含绝对路径的 `<code>` / 选中文本；
 *   3. 清理 `#L10-L20` 行号锚点并解码 URL 编码后，渲染自适应昼夜毛玻璃的独立悬浮右键菜单；
 *   4. 点击菜单项后通过 `POST http://127.0.0.1:48791/api/reveal` 调本地守护服务拉起系统文件管理器。
 */
(() => {
  'use strict';

  const STYLE_ID = 'ag-we-fcm-style';
  const MENU_ID = 'ag-we-fcm-menu';
  const TOAST_ID = 'ag-we-fcm-toast';

  function decodeSafely(text) {
    try {
      return decodeURIComponent(text);
    } catch {
      return text;
    }
  }

  /**
   * 清洗并校验候选路径文本，返回合法的本地绝对路径（如 `E:/...`、`\\server\...`、`~/...`、`/Users/...`），不合法返回空串。
   */
  function normalizeCandidatePath(raw) {
    if (!raw || typeof raw !== 'string') return '';
    let s = raw.trim().replace(/^["'`]+|["'`]+$/g, '');
    if (!s || s.length > 1024) return '';

    const lower = s.toLowerCase();
    // 明确拦截网页协议或脚本协议，不接管普通超链接
    if (/^(https?|mailto|tel|javascript|data|blob|plugin|about):/.test(lower)) {
      return '';
    }

    // 处理 file:// 或 vscode-file:// 协议
    if (/^(file|vscode-file):\/\//i.test(s)) {
      s = s.replace(/^(file|vscode-file):\/\/(?:vscode-app)?/i, '');
      const hashIdx = s.indexOf('#');
      if (hashIdx !== -1) s = s.slice(0, hashIdx);
      const qIdx = s.indexOf('?');
      if (qIdx !== -1) s = s.slice(0, qIdx);
      s = decodeSafely(s);
      // Windows 形式：/E:/foo 或 /e:/foo -> E:/foo
      if (/^\/[A-Za-z]:/.test(s)) {
        s = s.slice(1);
      }
      // file://host/share/file -> //host/share/file（Windows UNC）
      if (s.startsWith('//') === false && /^[a-zA-Z0-9._-]+\//.test(s) && !s.startsWith('/')) {
        s = '//' + s;
      }
    } else {
      const hashIdx = s.indexOf('#');
      if (hashIdx !== -1 && /^#L\d+/i.test(s.slice(hashIdx))) {
        s = s.slice(0, hashIdx);
      }
      s = decodeSafely(s);
    }

    // 剥离末尾行号列号后缀（例如 :123 或 :123:45），注意保留 Windows 盘符冒号 E:\...
    s = s.replace(/^(.*[^:]):\d+(?::\d+)?$/, '$1').trim();
    if (!s) return '';

    const looksWindowsAbs = /^[A-Za-z]:[\\/]/.test(s) || /^\\\\[^\\]+\\[^\\]+/.test(s) || /^\/\/[^/]+\/[^/]+/.test(s);
    const looksPosixAbs = /^\/[^/\s]/.test(s) && !/^\/(c|conversation|api)\b/i.test(s);
    const looksHomeRel = /^~[\\/]/.test(s);
    if (!looksWindowsAbs && !looksPosixAbs && !looksHomeRel) {
      return '';
    }
    return s;
  }

  function extractFromElement(el) {
    if (!el || typeof el.getAttribute !== 'function') return '';
    const attrs = [
      'data-uri',
      'href',
      'data-path',
      'data-file-path',
      'data-absolute-path',
      'data-full-path',
      'title',
    ];
    for (const attr of attrs) {
      const val = el.getAttribute(attr);
      const norm = normalizeCandidatePath(val);
      if (norm) return norm;
    }
    return '';
  }

  /**
   * 从鼠标右键命中的目标节点提取本地文件/目录路径。
   */
  function extractLocalPathFromTarget(target, doc) {
    const startEl = target && target.nodeType === 1 ? target : target?.parentElement;
    if (!startEl) return '';

    // 忽略可编辑输入框，避免干扰正常文本编辑右键
    if (startEl.closest('textarea, input, [contenteditable="true"], .monaco-editor, .xterm')) {
      return '';
    }

    // 1. 优先沿祖先查找明确带有 URI / 路径属性的文件链接元素
    const attrHost = startEl.closest(
      '[data-uri], a[href^="file:"], a[href^="vscode-"], [data-path], [data-file-path], [data-absolute-path], [data-full-path], [class*="group/file-title"], a.inline-pill'
    );
    if (attrHost) {
      const fromAttr = extractFromElement(attrHost);
      if (fromAttr) return fromAttr;
      // 如果内部子元素带有路径属性也兼容探测一次
      const childWithAttr = attrHost.querySelector?.('[data-uri], [data-path], [href^="file:"], [href^="vscode-"]');
      if (childWithAttr) {
        const fromChild = extractFromElement(childWithAttr);
        if (fromChild) return fromChild;
      }
      const textHit = normalizeCandidatePath(attrHost.textContent || '');
      if (textHit) return textHit;
    }

    // 2. 检查当前选区是否刚好选中了一条绝对路径
    const selText = doc?.getSelection?.()?.toString?.() || '';
    if (selText && selText.length <= 400 && !selText.includes('\n')) {
      const fromSel = normalizeCandidatePath(selText);
      if (fromSel) return fromSel;
    }

    // 3. 兜底：行内代码 <code> 或 .inline-pill 内直接写出了绝对路径
    const codeHost = startEl.closest('code, .inline-pill, [data-testid*="file"], [data-testid*="artifact"]');
    if (codeHost) {
      const txt = (codeHost.textContent || '').trim();
      if (txt.length <= 400 && !txt.includes('\n')) {
        const fromCode = normalizeCandidatePath(txt);
        if (fromCode) return fromCode;
      }
    }

    return '';
  }

  function splitPathDisplay(fullPath) {
    const norm = fullPath.replace(/\\/g, '/').replace(/\/+$/, '');
    const idx = norm.lastIndexOf('/');
    if (idx <= 0) {
      return { fileName: fullPath, dirName: fullPath };
    }
    const fileName = norm.slice(idx + 1) || fullPath;
    const dirName = norm.slice(0, idx) || '/';
    return { fileName, dirName };
  }

  function install(options = {}) {
    const doc = options.document || (typeof document !== 'undefined' ? document : null);
    const win = options.window || (doc && doc.defaultView) || (typeof window !== 'undefined' ? window : null);
    const daemonBase = String(options.daemonBase || 'http://127.0.0.1:48791').replace(/\/+$/, '');
    if (!doc || !doc.body || !win) {
      return { stop: () => {} };
    }

    // 防止重复挂载：先停掉旧实例
    try {
      win.__agyFileContextMenuInstance?.stop?.();
    } catch {}

    function ensureStyle() {
      let style = doc.getElementById(STYLE_ID);
      if (!style) {
        style = doc.createElement('style');
        style.id = STYLE_ID;
        style.setAttribute('data-ag-we-ui', '1');
        style.textContent = `
#${MENU_ID} {
  position: fixed;
  z-index: 2147483000;
  min-width: 248px;
  max-width: 340px;
  padding: 6px;
  border-radius: 12px;
  border: 1px solid var(--ag-we-glass-edge, rgba(128, 128, 128, 0.24));
  background: color-mix(in oklab, var(--ag-we-base-card, var(--popover, #1F1E1D)) 88%, transparent);
  backdrop-filter: blur(18px) saturate(140%);
  -webkit-backdrop-filter: blur(18px) saturate(140%);
  box-shadow: 0 14px 36px rgba(0, 0, 0, 0.28), 0 2px 8px rgba(0, 0, 0, 0.12);
  color: var(--foreground, #ECEAE5);
  font-family: var(--font-sans, system-ui, -apple-system, sans-serif);
  font-size: 12.5px;
  line-height: 1.4;
  user-select: none;
  animation: agWeFcmPop 120ms cubic-bezier(0.16, 1, 0.3, 1);
}
@keyframes agWeFcmPop {
  from { opacity: 0; transform: scale(0.96) translateY(-2px); }
  to { opacity: 1; transform: scale(1) translateY(0); }
}
#${MENU_ID} .ag-we-fcm-hdr {
  padding: 6px 8px 7px;
  margin-bottom: 4px;
  border-bottom: 1px solid color-mix(in oklab, var(--border, rgba(128,128,128,0.22)) 75%, transparent);
}
#${MENU_ID} .ag-we-fcm-name {
  font-weight: 600;
  font-size: 12.5px;
  color: var(--foreground, inherit);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
#${MENU_ID} .ag-we-fcm-dir {
  margin-top: 2px;
  font-size: 11px;
  opacity: 0.68;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono, ui-monospace, monospace);
}
#${MENU_ID} .ag-we-fcm-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 9px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--foreground, inherit);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color 110ms ease, color 110ms ease;
}
#${MENU_ID} .ag-we-fcm-item:hover {
  background: color-mix(in oklab, var(--primary, #D97757) 18%, transparent);
}
#${MENU_ID} .ag-we-fcm-item svg {
  width: 15px;
  height: 15px;
  flex-shrink: 0;
  opacity: 0.88;
}
#${MENU_ID} .ag-we-fcm-foot {
  margin-top: 4px;
  padding: 4px 8px 2px;
  border-top: 1px solid color-mix(in oklab, var(--border, rgba(128,128,128,0.22)) 60%, transparent);
  font-size: 10.5px;
  opacity: 0.56;
}
#${TOAST_ID} {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 2147483001;
  max-width: 360px;
  padding: 8px 13px;
  border-radius: 10px;
  border: 1px solid var(--ag-we-glass-edge, rgba(128, 128, 128, 0.25));
  background: color-mix(in oklab, var(--ag-we-base-card, #1F1E1D) 90%, transparent);
  backdrop-filter: blur(14px);
  color: var(--foreground, #ECEAE5);
  font-family: var(--font-sans, system-ui, sans-serif);
  font-size: 12px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.24);
  pointer-events: none;
}
#${TOAST_ID}[data-err="1"] {
  border-color: rgba(239, 68, 68, 0.55);
}
        `.trim();
        (doc.head || doc.documentElement).appendChild(style);
      }
    }

    let toastTimer = 0;
    function showToast(msg, isErr = false) {
      ensureStyle();
      let toast = doc.getElementById(TOAST_ID);
      if (!toast) {
        toast = doc.createElement('div');
        toast.id = TOAST_ID;
        toast.setAttribute('data-ag-we-ui', '1');
        toast.setAttribute('data-ag-no-i18n', '1');
        toast.setAttribute('translate', 'no');
        doc.body.appendChild(toast);
      }
      toast.textContent = msg;
      toast.setAttribute('data-err', isErr ? '1' : '0');
      clearTimeout(toastTimer);
      toastTimer = win.setTimeout(() => {
        doc.getElementById(TOAST_ID)?.remove();
      }, 2400);
    }

    function closeMenu() {
      doc.getElementById(MENU_ID)?.remove();
    }

    async function invokeReveal(localPath, action) {
      try {
        const res = await fetch(`${daemonBase}/api/reveal`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: localPath, action }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data?.ok) {
          showToast(data?.error || `打开失败 (HTTP ${res.status})`, true);
          return;
        }
        if (data.fallbackParent) {
          showToast('目标已移动，已为你打开所在父文件夹');
        }
      } catch {
        showToast('未连接到本地守护服务 (127.0.0.1:48791)', true);
      }
    }

    async function copyPathText(localPath) {
      try {
        if (win.navigator?.clipboard?.writeText) {
          await win.navigator.clipboard.writeText(localPath);
          showToast('已复制完整路径');
          return;
        }
      } catch {}
      try {
        const ta = doc.createElement('textarea');
        ta.value = localPath;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        doc.body.appendChild(ta);
        ta.select();
        doc.execCommand('copy');
        ta.remove();
        showToast('已复制完整路径');
      } catch {
        showToast('复制失败，请手动复制', true);
      }
    }

    function makeIconSvg(d) {
      const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 16 16');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '1.45');
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('stroke-linejoin', 'round');
      const pathEl = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
      pathEl.setAttribute('d', d);
      svg.appendChild(pathEl);
      return svg;
    }

    function openMenuAt(x, y, localPath) {
      closeMenu();
      ensureStyle();

      const { fileName, dirName } = splitPathDisplay(localPath);
      const menu = doc.createElement('div');
      menu.id = MENU_ID;
      menu.setAttribute('data-ag-we-ui', '1');
      menu.setAttribute('data-ag-no-i18n', '1');
      menu.setAttribute('data-ag-i18n-skip', '1');
      menu.setAttribute('translate', 'no');

      const hdr = doc.createElement('div');
      hdr.className = 'ag-we-fcm-hdr';
      const nameEl = doc.createElement('div');
      nameEl.className = 'ag-we-fcm-name';
      nameEl.textContent = fileName;
      nameEl.title = localPath;
      const dirEl = doc.createElement('div');
      dirEl.className = 'ag-we-fcm-dir';
      dirEl.textContent = dirName;
      dirEl.title = dirName;
      hdr.appendChild(nameEl);
      hdr.appendChild(dirEl);
      menu.appendChild(hdr);

      const items = [
        {
          label: '在文件夹中显示',
          icon: 'M2 4.2A1.2 1.2 0 0 1 3.2 3h3l1.3 1.5h5.3A1.2 1.2 0 0 1 14 5.7v6.1a1.2 1.2 0 0 1-1.2 1.2H3.2A1.2 1.2 0 0 1 2 11.8z',
          onClick: () => void invokeReveal(localPath, 'reveal'),
        },
        {
          label: '用系统默认程序打开',
          icon: 'M9 2.5h4.5V7M13.5 2.5L7 9M6.5 4H3.8A1.3 1.3 0 0 0 2.5 5.3v7A1.3 1.3 0 0 0 3.8 13.5h7a1.3 1.3 0 0 0 1.3-1.3V9.5',
          onClick: () => void invokeReveal(localPath, 'open'),
        },
        {
          label: '复制完整路径',
          icon: 'M5.5 5.5h7v8h-7zM3.5 10.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v.5',
          onClick: () => void copyPathText(localPath),
        },
      ];

      for (const spec of items) {
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'ag-we-fcm-item';
        btn.appendChild(makeIconSvg(spec.icon));
        const span = doc.createElement('span');
        span.textContent = spec.label;
        btn.appendChild(span);
        btn.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          closeMenu();
          spec.onClick();
        });
        menu.appendChild(btn);
      }

      const foot = doc.createElement('div');
      foot.className = 'ag-we-fcm-foot';
      foot.textContent = '按住 Shift + 右键使用原生菜单';
      menu.appendChild(foot);

      menu.style.left = `${x}px`;
      menu.style.top = `${y}px`;
      doc.body.appendChild(menu);

      // 防止靠近窗口右/下边界时被裁切
      const rect = menu.getBoundingClientRect();
      const vw = win.innerWidth || doc.documentElement.clientWidth || 1280;
      const vh = win.innerHeight || doc.documentElement.clientHeight || 800;
      const left = Math.max(8, Math.min(x, vw - rect.width - 8));
      const top = Math.max(8, Math.min(y, vh - rect.height - 8));
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
    }

    const onContextMenu = (e) => {
      if (e.shiftKey) {
        closeMenu();
        return;
      }
      if (e.target instanceof Element && e.target.closest(`#${MENU_ID}`)) {
        e.preventDefault();
        return;
      }
      const localPath = extractLocalPathFromTarget(e.target, doc);
      if (!localPath) {
        closeMenu();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      openMenuAt(e.clientX, e.clientY, localPath);
    };

    const onMouseDown = (e) => {
      if (e.target instanceof Element && e.target.closest(`#${MENU_ID}`)) return;
      closeMenu();
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') closeMenu();
    };
    const onBlurOrScroll = () => closeMenu();

    doc.addEventListener('contextmenu', onContextMenu, true);
    doc.addEventListener('mousedown', onMouseDown, true);
    doc.addEventListener('keydown', onKeyDown, true);
    doc.addEventListener('scroll', onBlurOrScroll, true);
    win.addEventListener('blur', onBlurOrScroll);

    const inst = {
      stop: () => {
        clearTimeout(toastTimer);
        doc.removeEventListener('contextmenu', onContextMenu, true);
        doc.removeEventListener('mousedown', onMouseDown, true);
        doc.removeEventListener('keydown', onKeyDown, true);
        doc.removeEventListener('scroll', onBlurOrScroll, true);
        win.removeEventListener('blur', onBlurOrScroll);
        closeMenu();
        doc.getElementById(TOAST_ID)?.remove();
        doc.getElementById(STYLE_ID)?.remove();
        if (win.__agyFileContextMenuInstance === inst) {
          delete win.__agyFileContextMenuInstance;
        }
      },
    };
    win.__agyFileContextMenuInstance = inst;
    return inst;
  }

  window.AgyFileContextMenu = {
    install,
    extractLocalPathFromTarget,
    normalizeCandidatePath,
  };
})();
