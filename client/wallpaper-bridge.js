/**
 * user/custom.js — 船板补丁 × Wallpaper Engine 书卷液态玻璃前端控制器
 * 挂载于船板沙箱钩子，严格通过 ctx.onCleanup 注册全量清理，支持 2.5s 热重载与 --safe-mode 安全绕过。
 */
(() => {
  if (window.location && String(window.location.protocol || '').startsWith('plugin:')) return;

  const DAEMON_BASE = 'http://127.0.0.1:48791';
  const STAGE_ID = 'ag-we-stage';
  const QUICK_BTN_ID = 'ag-we-quick-btn';
  const NAV_SECTION_FALLBACK_ID = 'ag-we-nav-section';
  const NAV_BTN_ID = 'ag-we-nav-btn';
  const PANEL_ID = 'ag-we-settings-panel';
  const LIVE_WATCHDOG_MS = 25000;

  let engineBlobUrl = null;
  let engineBlobPromise = null;

  const GLASS_PRESETS = {
    'book-glass': { label: '书卷液态玻璃', mainOpacity: 58, sidebarOpacity: 66, cardOpacity: 74, blurPx: 18, saturatePct: 135, scrimOpacity: 24 },
    'crystal-clear': { label: '澄澈高透', mainOpacity: 38, sidebarOpacity: 48, cardOpacity: 62, blurPx: 14, saturatePct: 145, scrimOpacity: 14 },
    'frosted-ink': { label: '浓墨磨砂', mainOpacity: 74, sidebarOpacity: 82, cardOpacity: 86, blurPx: 24, saturatePct: 125, scrimOpacity: 34 },
    'chat-only': { label: '仅对话区透出', mainOpacity: 54, sidebarOpacity: 96, cardOpacity: 86, blurPx: 16, saturatePct: 130, scrimOpacity: 20 },
  };

  let disposed = false;
  let state = {
    connected: false,
    revision: 0,
    settings: null,
    current: null,
    wallpapers: [],
    renderMode: 'idle', // idle | scene-live | web-live | video | image | fallback
    renderNote: '正在连接本地壁纸服务…',
    tabActive: false,
    filterType: 'all',
    searchQuery: '',
    lastRenderedKey: '',
  };

  let watchdogTimer = null;
  let carouselTimer = null;
  let syncPollTimer = null;
  let patchDebounceTimer = null;
  let pointerRaf = 0;
  let pendingPointer = null;
  let modalSyncRaf = 0;
  let pendingOpenWeTab = false;
  let pendingOpenTimer = null;
  let effortSliderInst = null;

  const cleanups = [];
  const registerCleanup = (fn) => cleanups.push(fn);

  // ── 辅助工具 ────────────────────────────────────────────────────────────────
  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function hasBrowserHole() {
    const b = document.body;
    if (!b) return false;
    return (
      b.getAttribute('data-has-browser-hole') === 'true' ||
      b.getAttribute('data-has-drawer-browser-hole') === 'true' ||
      b.getAttribute('data-has-three-layer-browser-hole') === 'true'
    );
  }

  function isAppSleeping() {
    const s = state.settings;
    if (!s || !s.enabled) return true;
    if (s.paused) return true;
    if (document.hidden) return true;
    if (hasBrowserHole()) return true;
    if (s.pauseOnBlur && !document.hasFocus()) return true;
    return false;
  }

  async function apiFetch(path, opts = {}) {
    const res = await fetch(`${DAEMON_BASE}${path}`, opts);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // ── 液态玻璃 CSS 变量与宿主标记同步 ─────────────────────────────────────────
  function applyRootVisualVars() {
    const root = document.documentElement;
    const s = state.settings;
    const active = Boolean(state.connected && s && s.enabled && state.current);
    if (active) {
      root.setAttribute('data-ag-we-active', '1');
      root.setAttribute('data-ag-we-glass', s.glassEnabled ? '1' : '0');
      root.style.setProperty('--ag-we-main-opacity', `${s.mainOpacity ?? 58}%`);
      root.style.setProperty('--ag-we-sidebar-opacity', `${s.sidebarOpacity ?? 66}%`);
      root.style.setProperty('--ag-we-card-opacity', `${s.cardOpacity ?? 74}%`);
      root.style.setProperty('--ag-we-blur', `${s.blurPx ?? 18}px`);
      root.style.setProperty('--ag-we-saturate', `${s.saturatePct ?? 135}%`);
      root.style.setProperty('--ag-we-scrim-opacity', `${s.scrimOpacity ?? 24}%`);
    } else {
      root.removeAttribute('data-ag-we-active');
      root.removeAttribute('data-ag-we-glass');
    }
    syncQuickButton();
  }

  // ── 壁纸舞台层 (#ag-we-stage) ───────────────────────────────────────────────
  async function ensureEngineBlobUrl() {
    if (engineBlobUrl) return engineBlobUrl;
    if (!engineBlobPromise) {
      engineBlobPromise = fetch(`${DAEMON_BASE}/scene-live/engine/webwallgl.global.min.js`)
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.text();
        })
        .then((code) => {
          const blob = new Blob([code], { type: 'application/javascript' });
          engineBlobUrl = URL.createObjectURL(blob);
          return engineBlobUrl;
        })
        .catch((err) => {
          engineBlobPromise = null;
          throw err;
        });
    }
    return engineBlobPromise;
  }
  registerCleanup(() => {
    if (engineBlobUrl) {
      try { URL.revokeObjectURL(engineBlobUrl); } catch {}
      engineBlobUrl = null;
      engineBlobPromise = null;
    }
  });

  function ensureStage() {
    let stage = document.getElementById(STAGE_ID);
    if (!stage && document.body) {
      stage = document.createElement('div');
      stage.id = STAGE_ID;
      stage.setAttribute('data-ag-we-ui', '1');
      stage.innerHTML =
        `<div class="ag-we-poster"></div>` +
        `<video class="ag-we-video" playsinline loop preload="auto"></video>` +
        `<iframe class="ag-we-iframe" allow="autoplay"></iframe>` +
        `<div class="ag-we-scrim"></div>`;
      document.body.prepend(stage);
    }
    return stage;
  }

  function clearWatchdog() {
    if (watchdogTimer) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
  }

  function postToStageIframe(msg) {
    const stage = document.getElementById(STAGE_ID);
    const iframe = stage?.querySelector('.ag-we-iframe');
    if (iframe && iframe.contentWindow && (iframe.hasAttribute('srcdoc') || (iframe.src && iframe.src !== 'about:blank'))) {
      try {
        iframe.contentWindow.postMessage(msg, '*');
      } catch {}
    }
  }

  function resetIframe(iframe) {
    if (!iframe) return;
    if (iframe.contentWindow && (iframe.hasAttribute('srcdoc') || (iframe.src && iframe.src !== 'about:blank'))) {
      try { iframe.contentWindow.postMessage({ type: 'ag-we-cmd', cmd: 'destroy' }, '*'); } catch {}
    }
    iframe.onload = null;
    iframe.onerror = null;
    iframe.removeAttribute('srcdoc');
    iframe.removeAttribute('sandbox');
    iframe.src = 'about:blank';
    iframe.setAttribute('data-ready', '0');
  }

  function buildSceneSrcdoc(blobUrl, wp, s) {
    const cfg = {
      id: wp.id,
      mediaBase: `${DAEMON_BASE}/scene-files`,
      fit: ['cover', 'contain', 'stretch'].includes(s.fit) ? s.fit : 'cover',
      fps: Number(s.sceneFps || 60),
      volume: s.muted ? 0 : Math.max(0, Math.min(1, Number(s.volume ?? 0.35))),
    };
    return `<!doctype html>
<html>
<head>
  <meta charset="UTF-8" />
  <style>
    html, body, #wp { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; user-select: none; }
  </style>
  <script src="${blobUrl}"><\/script>
</head>
<body>
  <div id="wp"></div>
  <script>
  (() => {
    const CFG = ${JSON.stringify(cfg)};
    const post = (type, extra) => {
      try { window.parent.postMessage({ type, id: CFG.id, ...(extra || {}) }, '*'); } catch {}
    };
    if (!globalThis.WebWallGL) {
      post('ag-we-live-error', { error: 'WebWallGL 引擎未就绪' });
      return;
    }
    const { createScene, httpSource } = globalThis.WebWallGL;
    const host = document.getElementById('wp');
    let settled = false;
    let destroyed = false;
    let inst = null;

    function markReady() {
      if (settled || destroyed) return;
      settled = true;
      post('ag-we-live-ready');
    }

    try {
      inst = createScene(host, {
        fit: CFG.fit,
        fps: CFG.fps,
        volume: CFG.volume,
        onDiagnostic: (msg, level) => {
          const text = String(msg || '');
          if (text.startsWith('renderer started')) {
            requestAnimationFrame(markReady);
            setTimeout(markReady, 200);
          } else if (level === 'error' && !settled) {
            post('ag-we-live-error', { error: text.slice(0, 120) });
          }
        }
      });
      inst.on('error', (err) => {
        if (!settled && !destroyed) post('ag-we-live-error', { error: String(err?.message || err || 'WebWallGL runtime error') });
      });
      const src = httpSource(CFG.mediaBase + '/' + encodeURIComponent(CFG.id));
      inst.load(src).then(() => {
        if (destroyed) return;
        try { inst.setVolume(CFG.volume); } catch {}
        requestAnimationFrame(markReady);
        setTimeout(markReady, 250);
      }).catch((err) => {
        if (!settled && !destroyed) post('ag-we-live-error', { error: String(err?.message || err || 'scene load failed') });
      });
    } catch (err) {
      post('ag-we-live-error', { error: String(err?.message || err || 'init failed') });
    }

    window.addEventListener('message', (ev) => {
      const d = ev.data;
      if (!d || d.type !== 'ag-we-cmd' || !inst || destroyed) return;
      try {
        switch (d.cmd) {
          case 'pause': inst.pause(); break;
          case 'resume': inst.resume(); break;
          case 'setVolume': inst.setVolume(Math.max(0, Math.min(1, Number(d.value) || 0))); break;
          case 'setFit': inst.setFit(d.value || 'cover'); break;
          case 'pushPointer': inst.pushPointer(d.u, d.v, d.buttons || 0, d.mods || 0); break;
          case 'pointerLeave': inst.pointerLeave(); break;
          case 'destroy':
            destroyed = true;
            inst.destroy();
            break;
        }
      } catch {}
    });

    window.addEventListener('pagehide', () => {
      if (!destroyed && inst) {
        destroyed = true;
        try { inst.destroy(); } catch {}
      }
    });
  })();
  <\/script>
</body>
</html>`;
  }

  function syncPlaybackPowerState() {
    const stage = document.getElementById(STAGE_ID);
    if (!stage) return;
    const video = stage.querySelector('.ag-we-video');
    const sleeping = isAppSleeping();
    const s = state.settings;
    const vol = s && !s.muted ? Math.max(0, Math.min(1, Number(s.volume ?? 0.35))) : 0;

    if (video && video.getAttribute('src')) {
      video.muted = !s || Boolean(s.muted);
      video.volume = vol;
      if (sleeping) {
        if (!video.paused) video.pause();
      } else if (video.getAttribute('data-ready') === '1' && video.paused) {
        video.play().catch(() => {});
      }
    }
    postToStageIframe({ type: 'ag-we-cmd', cmd: 'setVolume', value: vol });
    postToStageIframe({ type: 'ag-we-cmd', cmd: sleeping ? 'pause' : 'resume' });
    syncQuickButton();
  }

  function renderStageWallpaper(force = false) {
    applyRootVisualVars();
    const s = state.settings;
    const wp = state.current;
    const stage = ensureStage();
    if (!stage) return;

    const poster = stage.querySelector('.ag-we-poster');
    const video = stage.querySelector('.ag-we-video');
    const iframe = stage.querySelector('.ag-we-iframe');

    if (!state.connected || !s || !s.enabled || !wp) {
      clearWatchdog();
      state.lastRenderedKey = '';
      state.renderMode = 'idle';
      poster.style.backgroundImage = '';
      poster.setAttribute('data-hidden', '1');
      video.removeAttribute('src');
      video.load();
      video.setAttribute('data-ready', '0');
      resetIframe(iframe);
      stage.hidden = true;
      return;
    }

    stage.hidden = false;
    const renderKey = `${wp.id}|${wp.type}|${s.sceneLive ? 1 : 0}|${s.fit || 'cover'}`;
    if (!force && renderKey === state.lastRenderedKey) {
      syncPlaybackPowerState();
      return;
    }
    state.lastRenderedKey = renderKey;
    clearWatchdog();

    // 先清旧载体并挂载高清封面图垫底（防止切换闪黑）
    video.pause();
    video.removeAttribute('src');
    video.load();
    video.setAttribute('data-ready', '0');
    resetIframe(iframe);

    if (wp.previewUrl) {
      poster.style.backgroundImage = `url("${wp.previewUrl}")`;
      poster.setAttribute('data-hidden', '0');
    } else {
      poster.style.backgroundImage = '';
      poster.setAttribute('data-hidden', '1');
    }

    const activateVideoFallback = (reason) => {
      if (disposed || state.current?.id !== wp.id) return;
      resetIframe(iframe);
      if (wp.videoUrl) {
        state.renderMode = 'fallback';
        state.renderNote = `${reason}，已自动切换内嵌 MP4 播放`;
        video.muted = Boolean(s.muted);
        video.volume = s.muted ? 0 : (s.volume ?? 0.35);
        video.oncanplay = () => {
          if (disposed || state.current?.id !== wp.id) return;
          video.setAttribute('data-ready', '1');
          poster.setAttribute('data-hidden', '1');
          syncPlaybackPowerState();
          refreshSettingsPanelStatus();
        };
        video.onerror = () => {
          if (disposed || state.current?.id !== wp.id) return;
          video.setAttribute('data-ready', '0');
          poster.setAttribute('data-hidden', '0');
          state.renderMode = 'image';
          state.renderNote = '无可用视频流，已保持工程高清预览图';
          refreshSettingsPanelStatus();
        };
        video.src = wp.videoUrl;
        video.load();
      } else {
        state.renderMode = 'image';
        state.renderNote = `${reason}，已降级为高清预览图`;
      }
      refreshSettingsPanelStatus();
    };

    if (wp.type === 'video' && wp.videoUrl) {
      state.renderMode = 'video';
      state.renderNote = '原生视频壁纸硬解播放中';
      video.muted = Boolean(s.muted);
      video.volume = s.muted ? 0 : (s.volume ?? 0.35);
      video.oncanplay = () => {
        if (disposed || state.current?.id !== wp.id) return;
        video.setAttribute('data-ready', '1');
        poster.setAttribute('data-hidden', '1');
        syncPlaybackPowerState();
        refreshSettingsPanelStatus();
      };
      video.onerror = () => {
        state.renderMode = 'image';
        state.renderNote = '视频解码失败，已回退预览封面';
        poster.setAttribute('data-hidden', '0');
        refreshSettingsPanelStatus();
      };
      video.src = wp.videoUrl;
      video.load();
    } else if (wp.type === 'scene' && s.sceneLive && wp.sceneLiveUrl) {
      state.renderMode = 'scene-live';
      state.renderNote = 'WebWallGL 实时场景渲染装配中…';
      watchdogTimer = setTimeout(() => {
        if (state.renderMode === 'scene-live' && iframe.getAttribute('data-ready') !== '1') {
          activateVideoFallback('场景加载超时');
        }
      }, LIVE_WATCHDOG_MS);
      void ensureEngineBlobUrl()
        .then((blobUrl) => {
          if (disposed || state.current?.id !== wp.id || state.renderMode !== 'scene-live') return;
          iframe.removeAttribute('sandbox');
          iframe.srcdoc = buildSceneSrcdoc(blobUrl, wp, s);
        })
        .catch(() => {
          clearWatchdog();
          activateVideoFallback('引擎脚本拉取失败');
        });
    } else if (wp.type === 'scene') {
      activateVideoFallback('已关闭场景实时渲染');
    } else if (wp.type === 'web' && wp.webLiveUrl) {
      state.renderMode = 'web-live';
      state.renderNote = '沙箱网页壁纸加载中…';
      void fetch(wp.webLiveUrl)
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.text();
        })
        .then((html) => {
          if (disposed || state.current?.id !== wp.id || state.renderMode !== 'web-live') return;
          const baseTag = `<base href="${esc(wp.webLiveUrl)}" />`;
          const docHtml = /<head[^>]*>/i.test(html)
            ? html.replace(/<head[^>]*>/i, (m) => `${m}\n${baseTag}`)
            : `${baseTag}\n${html}`;
          iframe.setAttribute('sandbox', 'allow-scripts');
          iframe.onload = () => {
            if (disposed || state.current?.id !== wp.id) return;
            state.renderNote = '沙箱网页壁纸 + WE API shim 运行中';
            iframe.setAttribute('data-ready', '1');
            poster.setAttribute('data-hidden', '1');
            syncPlaybackPowerState();
            refreshSettingsPanelStatus();
          };
          iframe.srcdoc = docHtml;
        })
        .catch(() => {
          activateVideoFallback('网页壁纸加载受限');
        });
    } else {
      state.renderMode = 'image';
      state.renderNote = '高清静态壁纸展示中';
    }
    refreshSettingsPanelStatus();
  }

  // ── 全局通信与省电/交互监听 ─────────────────────────────────────────────────
  function onIframeMessage(ev) {
    const d = ev.data;
    if (!d || typeof d !== 'object') return;
    const wp = state.current;
    if (!wp || (d.id && d.id !== wp.id)) return;
    const stage = document.getElementById(STAGE_ID);
    const poster = stage?.querySelector('.ag-we-poster');
    const iframe = stage?.querySelector('.ag-we-iframe');
    if (!stage || !iframe) return;

    if (d.type === 'ag-we-live-ready') {
      clearWatchdog();
      state.renderMode = 'scene-live';
      state.renderNote = 'WebWallGL 实时 WebGL 渲染中';
      iframe.setAttribute('data-ready', '1');
      poster?.setAttribute('data-hidden', '1');
      syncPlaybackPowerState();
      refreshSettingsPanelStatus();
    } else if (d.type === 'ag-we-live-error') {
      clearWatchdog();
      if (wp.type === 'scene') {
        const video = stage.querySelector('.ag-we-video');
        resetIframe(iframe);
        if (wp.videoUrl && video) {
          state.renderMode = 'fallback';
          state.renderNote = `WebWallGL 降级(${String(d.error || '兼容受限').slice(0, 28)})，已切内嵌 MP4`;
          video.muted = Boolean(state.settings?.muted);
          video.oncanplay = () => {
            video.setAttribute('data-ready', '1');
            poster?.setAttribute('data-hidden', '1');
            syncPlaybackPowerState();
            refreshSettingsPanelStatus();
          };
          video.src = wp.videoUrl;
          video.load();
        } else {
          state.renderMode = 'image';
          state.renderNote = `WebWallGL 兼容受限，已保留静态预览图`;
          poster?.setAttribute('data-hidden', '0');
          refreshSettingsPanelStatus();
        }
      }
    }
  }
  window.addEventListener('message', onIframeMessage);
  registerCleanup(() => window.removeEventListener('message', onIframeMessage));

  // 鼠标位置转发给 WebWallGL（零拦截宿主界面）
  function onPointerMove(ev) {
    if (isAppSleeping() || state.renderMode !== 'scene-live') return;
    const w = window.innerWidth || 1;
    const h = window.innerHeight || 1;
    pendingPointer = {
      u: Math.max(0, Math.min(1, ev.clientX / w)),
      v: Math.max(0, Math.min(1, ev.clientY / h)),
      buttons: ev.buttons || 0,
    };
    if (!pointerRaf) {
      pointerRaf = requestAnimationFrame(() => {
        pointerRaf = 0;
        if (pendingPointer) {
          postToStageIframe({ type: 'ag-we-cmd', cmd: 'pushPointer', ...pendingPointer, mods: 0 });
        }
      });
    }
  }
  window.addEventListener('pointermove', onPointerMove, { passive: true });
  registerCleanup(() => {
    window.removeEventListener('pointermove', onPointerMove);
    if (pointerRaf) cancelAnimationFrame(pointerRaf);
  });

  const onVisibilityOrFocus = () => syncPlaybackPowerState();
  document.addEventListener('visibilitychange', onVisibilityOrFocus);
  window.addEventListener('focus', onVisibilityOrFocus);
  window.addEventListener('blur', onVisibilityOrFocus);
  registerCleanup(() => {
    document.removeEventListener('visibilitychange', onVisibilityOrFocus);
    window.removeEventListener('focus', onVisibilityOrFocus);
    window.removeEventListener('blur', onVisibilityOrFocus);
  });

  // ── 后端状态同步与轮播 ──────────────────────────────────────────────────────
  function resetCarouselTimer() {
    if (carouselTimer) {
      clearInterval(carouselTimer);
      carouselTimer = null;
    }
    const s = state.settings;
    if (!s || !s.enabled || !s.carouselEnabled) return;
    const mins = Math.max(1, Number(s.carouselMinutes || 15));
    carouselTimer = setInterval(() => {
      if (!disposed && state.settings?.enabled && state.settings?.carouselEnabled && !document.hidden) {
        void switchNextWallpaper();
      }
    }, mins * 60000);
  }
  registerCleanup(() => { if (carouselTimer) clearInterval(carouselTimer); });

  function syncEffortSlider() {
    const enabled = !disposed && (!state.settings || state.settings.effortSliderEnabled !== false);
    if (enabled) {
      if (!effortSliderInst && typeof window.AntigravityCodexEffortSlider?.installCodexEffortSlider === 'function') {
        try {
          effortSliderInst = window.AntigravityCodexEffortSlider.installCodexEffortSlider({ document, window });
        } catch {}
      }
    } else {
      try { effortSliderInst?.stop?.(); } catch {}
      effortSliderInst = null;
      try { window.__agCodexEffortSliderInstance?.stop?.(); } catch {}
    }
  }

  async function pullState(forceRender = false) {
    try {
      const data = await apiFetch('/api/state');
      if (disposed || !data?.ok) return;
      state.connected = true;
      const revChanged = data.settings.revision !== state.revision;
      state.revision = data.settings.revision;
      state.settings = data.settings;
      state.current = data.current;
      if (forceRender || revChanged) {
        renderStageWallpaper(forceRender);
        resetCarouselTimer();
        syncEffortSlider();
        if (state.tabActive) renderSettingsPanel();
      }
    } catch {
      state.connected = false;
      state.renderNote = '本地壁纸守护服务未运行（端口 48791）';
      applyRootVisualVars();
      if (state.tabActive) refreshSettingsPanelStatus();
    }
  }

  async function pullWallpapers(forceRefresh = false) {
    try {
      const data = await apiFetch(`/api/wallpapers${forceRefresh ? '?refresh=1' : ''}`);
      if (disposed || !data?.ok) return;
      state.wallpapers = Array.isArray(data.items) ? data.items : [];
      if (state.tabActive) renderWallpaperGrid();
    } catch {}
  }

  async function pushSettingsPatch(patch, immediate = true) {
    if (!state.settings) return;
    Object.assign(state.settings, patch);
    applyRootVisualVars();
    if ('effortSliderEnabled' in patch) syncEffortSlider();
    if ('currentId' in patch || 'enabled' in patch || 'sceneLive' in patch || 'fit' in patch) {
      const found = state.wallpapers.find((w) => w.id === state.settings.currentId);
      if (found) state.current = found;
      renderStageWallpaper(true);
    } else {
      syncPlaybackPowerState();
    }

    const send = async () => {
      try {
        const res = await apiFetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        if (!disposed && res?.ok) {
          state.revision = res.settings.revision;
          state.settings = res.settings;
          state.current = res.current;
          resetCarouselTimer();
        }
      } catch {}
    };

    if (immediate) {
      await send();
    } else {
      clearTimeout(patchDebounceTimer);
      patchDebounceTimer = setTimeout(send, 120);
    }
  }
  registerCleanup(() => clearTimeout(patchDebounceTimer));

  async function switchNextWallpaper() {
    try {
      const res = await apiFetch('/api/next', { method: 'POST', body: '{}' });
      if (!disposed && res?.ok) {
        state.revision = res.settings.revision;
        state.settings = res.settings;
        state.current = res.current;
        renderStageWallpaper(true);
        if (state.tabActive) renderSettingsPanel();
      }
    } catch {}
  }

  // ── 入口一：右上角悬浮极简按钮 ──────────────────────────────────────────────
  function syncQuickButton() {
    if (!document.body) return;
    let btn = document.getElementById(QUICK_BTN_ID);
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.id = QUICK_BTN_ID;
      btn.setAttribute('data-ag-we-ui', '1');
      btn.title = '左键打开「动态壁纸」控制台 · 右键切换下一张壁纸';
      btn.innerHTML = `<span class="ag-we-q-dot"></span><span>壁纸</span>`;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openWallpaperSettingsTab();
      });
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void switchNextWallpaper();
      });
      document.body.appendChild(btn);
    }
    const s = state.settings;
    const shouldHide = hasBrowserHole() || (s && s.showQuickBtn === false);
    btn.hidden = Boolean(shouldHide);
    btn.setAttribute('data-paused', !s || !s.enabled || s.paused ? '1' : '0');
  }
  registerCleanup(() => document.getElementById(QUICK_BTN_ID)?.remove());

  // ── 入口二：系统设置「本地扩展 → 动态壁纸」Tab ─────────────────────────────
  function findActiveSettingsModal() {
    const containers = document.querySelectorAll('.settings-modal-container');
    for (const c of containers) {
      const bd = c.closest('.settings-modal-backdrop');
      if (bd && (bd.getAttribute('aria-hidden') === 'true' || bd.classList.contains('animate-modalFadeOut'))) continue;
      if (c.classList.contains('animate-modalScaleOut')) continue;
      const r = c.getBoundingClientRect();
      if (r.width > 200 && r.height > 200) return c;
    }
    return null;
  }

  function findNavMount(modal) {
    const sidebar = modal.querySelector('[data-testid="settings-sidebar"]');
    if (!sidebar) return null;
    const anchor = sidebar.querySelector('[data-testid="settings-nav-item-Models"], [data-testid="settings-nav-item-General"], [data-testid="settings-nav-item-Appearance"]');
    const wrap = anchor?.closest('.group\\/nav-item') || anchor;
    if (wrap && wrap.parentElement) return { sidebar, container: wrap.parentElement };
    const scrollBody = sidebar.querySelector('.overflow-y-auto');
    return scrollBody ? { sidebar, container: scrollBody } : null;
  }

  function findContentMount(modal, sidebar) {
    const scrolls = [...modal.querySelectorAll('div.overflow-auto')];
    const nativeScroll = scrolls.find((el) => !sidebar?.contains(el) && !el.closest('[data-ag-token-ui], [data-ag-we-ui]'));
    return nativeScroll && nativeScroll.parentElement ? { nativeScroll, hostParent: nativeScroll.parentElement } : null;
  }

  function setWeTabActive(modal, active) {
    if (!modal) return;
    state.tabActive = Boolean(active);
    if (state.tabActive) {
      modal.setAttribute('data-ag-we-tab-active', '1');
      modal.removeAttribute('data-ag-token-tab-active');
      const tokenBtn = document.getElementById('ag-token-nav-btn');
      if (tokenBtn) tokenBtn.setAttribute('data-active', '0');
      const tokenPanel = document.getElementById('ag-token-analytics-panel');
      if (tokenPanel) tokenPanel.hidden = true;
    } else {
      modal.removeAttribute('data-ag-we-tab-active');
    }
    const navBtn = document.getElementById(NAV_BTN_ID);
    if (navBtn) navBtn.setAttribute('data-active', state.tabActive ? '1' : '0');
    const panel = document.getElementById(PANEL_ID);
    if (panel) {
      panel.hidden = !state.tabActive;
      if (state.tabActive) {
        renderSettingsPanel();
        if (state.wallpapers.length === 0) void pullWallpapers(false);
      }
    }
  }

  function openWallpaperSettingsTab() {
    const modal = findActiveSettingsModal();
    if (modal) {
      syncSettingsModal();
      setWeTabActive(modal, true);
      return;
    }
    pendingOpenWeTab = true;
    clearTimeout(pendingOpenTimer);
    pendingOpenTimer = setTimeout(() => { pendingOpenWeTab = false; }, 3500);
    document.querySelector('[data-testid="settings-button"]')?.click();
  }

  function refreshSettingsPanelStatus() {
    const el = document.getElementById('ag-we-status-line');
    if (el) {
      const curTitle = state.current?.title || '未选定壁纸';
      el.textContent = `当前：${curTitle} · ${state.renderNote}`;
    }
  }

  function renderWallpaperGrid() {
    const grid = document.getElementById('ag-we-grid');
    if (!grid) return;
    const kw = state.searchQuery.trim().toLowerCase();
    const list = state.wallpapers.filter((w) => {
      if (state.filterType === 'upload' && w.source !== 'upload') return false;
      if (state.filterType !== 'all' && state.filterType !== 'upload' && w.type !== state.filterType) return false;
      if (kw) {
        const hay = `${w.title} ${w.type} ${(w.tags || []).join(' ')} ${w.rawId}`.toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });

    if (list.length === 0) {
      grid.innerHTML = `<div style="grid-column:1/-1;padding:24px;text-align:center;color:var(--ag-ta-muted,var(--muted-foreground));">没有匹配的壁纸，可尝试切换筛选分类或上传本地图片/视频。</div>`;
      return;
    }

    const typeMap = { scene: '场景', video: '视频', web: '网页', image: '图片' };
    grid.innerHTML = list.map((w) => {
      const isAct = state.current?.id === w.id;
      const thumb = w.previewUrl
        ? `<img class="ag-we-thumb" loading="lazy" src="${esc(w.previewUrl)}" alt="" />`
        : `<div class="ag-we-thumb" style="display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--muted-foreground);">视频壁纸</div>`;
      const delBtn = w.source === 'upload'
        ? `<button type="button" class="ag-we-del" data-del-id="${esc(w.id)}" title="删除本地导入">×</button>`
        : '';
      return (
        `<div class="ag-we-card" data-wp-id="${esc(w.id)}" data-active="${isAct ? '1' : '0'}">` +
        `  ${thumb}` +
        `  <span class="ag-we-badge">${esc(typeMap[w.type] || w.type)}</span>` +
        `  ${delBtn}` +
        `  <div class="ag-we-card-meta">` +
        `    <div class="ag-we-card-title" title="${esc(w.title)}">${esc(w.title)}</div>` +
        `    <div class="ag-we-card-sub">${w.source === 'upload' ? '本地导入' : (w.source === 'workshop' ? 'Steam 工坊' : 'WE 内置')}</div>` +
        `  </div>` +
        `</div>`
      );
    }).join('');

    grid.querySelectorAll('.ag-we-card').forEach((card) => {
      card.addEventListener('click', (e) => {
        const del = e.target instanceof Element ? e.target.closest('.ag-we-del') : null;
        if (del) {
          e.stopPropagation();
          const delId = del.getAttribute('data-del-id');
          if (delId) {
            void apiFetch(`/api/upload/${encodeURIComponent(delId)}`, { method: 'DELETE' })
              .then(() => Promise.all([pullState(true), pullWallpapers(true)]));
          }
          return;
        }
        const id = card.getAttribute('data-wp-id');
        if (id) {
          void pushSettingsPatch({ currentId: id, enabled: true, paused: false }, true).then(() => renderWallpaperGrid());
        }
      });
    });
  }

  function renderSettingsPanel() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const s = state.settings;
    if (!s) {
      panel.innerHTML =
        `<div class="ag-we-wrap"><div class="ag-we-box">` +
        `<div class="ag-we-box-title">本地壁纸守护服务未响应</div>` +
        `<div style="color:var(--ag-ta-muted);">请确认后台计划任务 AntigravityWallpaperDaemon 已启动（端口 48791），或在插件目录运行 <code>node install.mjs start</code>。</div>` +
        `<div><button type="button" class="ag-we-btn" id="ag-we-retry-conn">重新连接</button></div>` +
        `</div></div>`;
      panel.querySelector('#ag-we-retry-conn')?.addEventListener('click', () => {
        void Promise.all([pullState(true), pullWallpapers(true)]);
      });
      return;
    }

    const presetBtns = Object.entries(GLASS_PRESETS).map(([k, info]) =>
      `<button type="button" class="ag-we-btn" data-glass-preset="${k}" data-on="${s.glassPreset === k ? '1' : '0'}">${esc(info.label)}</button>`
    ).join('');

    panel.innerHTML =
      `<div class="ag-we-wrap">` +
      `  <div class="ag-we-hdr">` +
      `    <div>` +
      `      <h2 class="ag-we-h1">动态壁纸 · 书卷液态玻璃</h2>` +
      `      <div class="ag-we-sub" id="ag-we-status-line">当前：${esc(state.current?.title || '未选定')} · ${esc(state.renderNote)}</div>` +
      `    </div>` +
      `    <div class="ag-we-btn-row">` +
      `      <button type="button" class="ag-we-btn" id="ag-we-toggle-enable" data-on="${s.enabled ? '1' : '0'}">${s.enabled ? '已启用壁纸' : '已停用壁纸'}</button>` +
      `      <button type="button" class="ag-we-btn" id="ag-we-toggle-play" data-on="${!s.paused ? '1' : '0'}">${s.paused ? '恢复播放' : '暂停'}</button>` +
      `      <button type="button" class="ag-we-btn" id="ag-we-next-btn">下一张</button>` +
      `      <label class="ag-we-btn" style="cursor:pointer;">导入本地<input type="file" id="ag-we-upload-inp" accept=".jpg,.jpeg,.png,.webp,.gif,.mp4,.webm" style="display:none;" /></label>` +
      `    </div>` +
      `  </div>` +
      `  <div class="ag-we-box">` +
      `    <div class="ag-we-box-title">` +
      `      <span>书卷液态毛玻璃参数（自动同步船板昼夜预设）</span>` +
      `      <div class="ag-we-btn-row">${presetBtns}</div>` +
      `    </div>` +
      `    <div class="ag-we-sliders">` +
      `      <div class="ag-we-slider-item"><div class="ag-we-slider-lbl"><span>主对话区不透明度</span><strong id="ag-we-v-main">${s.mainOpacity}%</strong></div><input type="range" id="ag-we-r-main" min="20" max="96" value="${s.mainOpacity}" /></div>` +
      `      <div class="ag-we-slider-item"><div class="ag-we-slider-lbl"><span>侧边栏玻璃浓度</span><strong id="ag-we-v-side">${s.sidebarOpacity}%</strong></div><input type="range" id="ag-we-r-side" min="20" max="98" value="${s.sidebarOpacity}" /></div>` +
      `      <div class="ag-we-slider-item"><div class="ag-we-slider-lbl"><span>液态玻璃模糊半径</span><strong id="ag-we-v-blur">${s.blurPx}px</strong></div><input type="range" id="ag-we-r-blur" min="0" max="36" value="${s.blurPx}" /></div>` +
      `      <div class="ag-we-slider-item"><div class="ag-we-slider-lbl"><span>护眼柔光遮罩</span><strong id="ag-we-v-scrim">${s.scrimOpacity}%</strong></div><input type="range" id="ag-we-r-scrim" min="0" max="75" value="${s.scrimOpacity}" /></div>` +
      `    </div>` +
      `    <div class="ag-we-toggles">` +
      `      <label class="ag-we-chk"><input type="checkbox" id="ag-we-c-glass" ${s.glassEnabled ? 'checked' : ''} />开启液态玻璃</label>` +
      `      <label class="ag-we-chk"><input type="checkbox" id="ag-we-c-live" ${s.sceneLive ? 'checked' : ''} />WebWallGL 场景实时渲染</label>` +
      `      <label class="ag-we-chk"><input type="checkbox" id="ag-we-c-mute" ${s.muted ? 'checked' : ''} />壁纸静音</label>` +
      `      <label class="ag-we-chk"><input type="checkbox" id="ag-we-c-blurpause" ${s.pauseOnBlur ? 'checked' : ''} />窗口失焦自动省电暂停</label>` +
      `      <label class="ag-we-chk"><input type="checkbox" id="ag-we-c-quickbtn" ${s.showQuickBtn ? 'checked' : ''} />显示右上角悬浮快捷钮</label>` +
      `      <label class="ag-we-chk"><input type="checkbox" id="ag-we-c-effort" ${s.effortSliderEnabled !== false ? 'checked' : ''} />模型菜单推理等级滑块</label>` +
      `      <label class="ag-we-chk"><input type="checkbox" id="ag-we-c-carousel" ${s.carouselEnabled ? 'checked' : ''} />每 <input type="number" id="ag-we-n-mins" min="1" max="1440" value="${s.carouselMinutes || 15}" style="width:46px;padding:1px 4px;border:1px solid var(--border);border-radius:4px;background:transparent;color:inherit;text-align:center;" /> 分钟自动轮播</label>` +
      `    </div>` +
      `  </div>` +
      `  <div class="ag-we-box">` +
      `    <div class="ag-we-box-title"><span>本机 Wallpaper Engine 壁纸库 (${state.wallpapers.length} 套)</span><button type="button" class="ag-we-btn" id="ag-we-refresh-lib">重新扫描</button></div>` +
      `    <div class="ag-we-toolbar">` +
      `      <input type="text" class="ag-we-search" id="ag-we-search-inp" placeholder="搜索壁纸标题、标签或工坊 ID…" value="${esc(state.searchQuery)}" />` +
      `      <button type="button" class="ag-we-btn" data-ftype="all" data-on="${state.filterType === 'all' ? '1' : '0'}">全部</button>` +
      `      <button type="button" class="ag-we-btn" data-ftype="scene" data-on="${state.filterType === 'scene' ? '1' : '0'}">场景 (Scene)</button>` +
      `      <button type="button" class="ag-we-btn" data-ftype="video" data-on="${state.filterType === 'video' ? '1' : '0'}">视频 (Video)</button>` +
      `      <button type="button" class="ag-we-btn" data-ftype="web" data-on="${state.filterType === 'web' ? '1' : '0'}">网页 (Web)</button>` +
      `      <button type="button" class="ag-we-btn" data-ftype="upload" data-on="${state.filterType === 'upload' ? '1' : '0'}">本地导入</button>` +
      `    </div>` +
      `    <div class="ag-we-grid" id="ag-we-grid"></div>` +
      `  </div>` +
      `</div>`;

    panel.querySelector('#ag-we-toggle-enable')?.addEventListener('click', () => {
      void pushSettingsPatch({ enabled: !state.settings.enabled }, true).then(() => renderSettingsPanel());
    });
    panel.querySelector('#ag-we-toggle-play')?.addEventListener('click', () => {
      void pushSettingsPatch({ paused: !state.settings.paused }, true).then(() => renderSettingsPanel());
    });
    panel.querySelector('#ag-we-next-btn')?.addEventListener('click', () => void switchNextWallpaper());

    panel.querySelectorAll('[data-glass-preset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-glass-preset');
        const p = GLASS_PRESETS[key];
        if (!p) return;
        void pushSettingsPatch({
          glassPreset: key,
          glassEnabled: true,
          mainOpacity: p.mainOpacity,
          sidebarOpacity: p.sidebarOpacity,
          cardOpacity: p.cardOpacity,
          blurPx: p.blurPx,
          saturatePct: p.saturatePct,
          scrimOpacity: p.scrimOpacity,
        }, true).then(() => renderSettingsPanel());
      });
    });

    const bindSlider = (inputId, valId, key, unit) => {
      const inp = panel.querySelector(`#${inputId}`);
      const valEl = panel.querySelector(`#${valId}`);
      inp?.addEventListener('input', () => {
        const v = Number(inp.value);
        if (valEl) valEl.textContent = `${v}${unit}`;
        void pushSettingsPatch({ [key]: v, glassPreset: 'custom' }, false);
      });
    };
    bindSlider('ag-we-r-main', 'ag-we-v-main', 'mainOpacity', '%');
    bindSlider('ag-we-r-side', 'ag-we-v-side', 'sidebarOpacity', '%');
    bindSlider('ag-we-r-blur', 'ag-we-v-blur', 'blurPx', 'px');
    bindSlider('ag-we-r-scrim', 'ag-we-v-scrim', 'scrimOpacity', '%');

    const bindChk = (id, key) => {
      const el = panel.querySelector(`#${id}`);
      el?.addEventListener('change', () => void pushSettingsPatch({ [key]: el.checked }, true));
    };
    bindChk('ag-we-c-glass', 'glassEnabled');
    bindChk('ag-we-c-live', 'sceneLive');
    bindChk('ag-we-c-mute', 'muted');
    bindChk('ag-we-c-blurpause', 'pauseOnBlur');
    bindChk('ag-we-c-quickbtn', 'showQuickBtn');
    bindChk('ag-we-c-effort', 'effortSliderEnabled');
    bindChk('ag-we-c-carousel', 'carouselEnabled');

    panel.querySelector('#ag-we-n-mins')?.addEventListener('change', (e) => {
      const v = Math.max(1, Number(e.target.value) || 15);
      void pushSettingsPatch({ carouselMinutes: v }, true);
    });

    panel.querySelector('#ag-we-upload-inp')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const buf = await file.arrayBuffer();
        await fetch(`${DAEMON_BASE}/api/upload?filename=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: buf,
        });
        await Promise.all([pullState(true), pullWallpapers(true)]);
        renderSettingsPanel();
      } catch {}
    });

    panel.querySelector('#ag-we-refresh-lib')?.addEventListener('click', () => void pullWallpapers(true));
    panel.querySelector('#ag-we-search-inp')?.addEventListener('input', (e) => {
      state.searchQuery = e.target.value || '';
      renderWallpaperGrid();
    });
    panel.querySelectorAll('[data-ftype]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.filterType = btn.getAttribute('data-ftype') || 'all';
        panel.querySelectorAll('[data-ftype]').forEach((b) => b.setAttribute('data-on', b === btn ? '1' : '0'));
        renderWallpaperGrid();
      });
    });

    renderWallpaperGrid();
  }

  function syncSettingsModal() {
    if (disposed || !document.body) return;
    const modal = findActiveSettingsModal();
    if (!modal) {
      if (state.tabActive) state.tabActive = false;
      return;
    }

    const navTarget = findNavMount(modal);
    const contentTarget = findContentMount(modal, navTarget?.sidebar);
    if (!navTarget || !contentTarget) return;

    const { sidebar, container: navContainer } = navTarget;
    const { nativeScroll, hostParent } = contentTarget;
    if (nativeScroll.getAttribute('data-ag-native-settings-scroll') !== '1') {
      nativeScroll.setAttribute('data-ag-native-settings-scroll', '1');
    }

    let navBtn = document.getElementById(NAV_BTN_ID);
    if (!navBtn) {
      navBtn = document.createElement('button');
      navBtn.type = 'button';
      navBtn.id = NAV_BTN_ID;
      navBtn.setAttribute('data-ag-we-ui', '1');
      navBtn.setAttribute('data-active', state.tabActive ? '1' : '0');
      navBtn.innerHTML =
        `<svg class="ag-we-nav-icon" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">` +
        `  <rect x="3" y="4" width="18" height="14" rx="2.5"/>` +
        `  <path d="m7 14 3.5-3.5 3 3 2.5-2.5L19 14"/><circle cx="8.5" cy="8.5" r="1.2"/>` +
        `</svg><span>动态壁纸</span>`;
      navBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        setWeTabActive(modal, true);
      });
    }

    // 优先挂入船板「本地扩展」分组内；若船板关闭了 Token 统计，则自建分组
    const chuanbanSection = document.getElementById('ag-token-nav-section');
    if (chuanbanSection) {
      let wrap = document.getElementById('ag-we-nav-wrap');
      if (!wrap) {
        wrap = document.createElement('div');
        wrap.id = 'ag-we-nav-wrap';
        wrap.className = 'relative mx-2';
        wrap.setAttribute('data-ag-we-ui', '1');
      }
      if (navBtn.parentElement !== wrap) wrap.appendChild(navBtn);
      if (wrap.parentElement !== chuanbanSection) chuanbanSection.appendChild(wrap);
      document.getElementById(NAV_SECTION_FALLBACK_ID)?.remove();
    } else {
      let fb = document.getElementById(NAV_SECTION_FALLBACK_ID);
      if (!fb) {
        fb = document.createElement('div');
        fb.id = NAV_SECTION_FALLBACK_ID;
        fb.setAttribute('data-ag-we-ui', '1');
        fb.innerHTML = `<div class="ag-we-nav-divider"></div><div class="ag-we-nav-heading">本地扩展</div><div class="relative mx-2" data-ag-we-slot="1"></div>`;
        fb.querySelector('[data-ag-we-slot="1"]')?.appendChild(navBtn);
      }
      if (fb.parentElement !== navContainer) navContainer.appendChild(fb);
    }

    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = document.createElement('div');
      panel.id = PANEL_ID;
      panel.setAttribute('data-ag-we-ui', '1');
      panel.hidden = !state.tabActive;
    }
    if (panel.parentElement !== hostParent) {
      hostParent.appendChild(panel);
    }

    if (!modal.__ag_we_click_bound) {
      modal.__ag_we_click_bound = true;
      modal.addEventListener('click', (e) => {
        const t = e.target;
        if (!(t instanceof Element) || t.closest('[data-ag-we-ui]')) return;
        const clickedOtherNav = t.closest('#ag-token-nav-btn, [data-testid^="settings-nav-item-"]')
          || (sidebar && sidebar.contains(t) && t.closest('.group\\/nav-item, button'));
        if (clickedOtherNav && state.tabActive) {
          setWeTabActive(modal, false);
        }
      }, true);
    }

    if (pendingOpenWeTab) {
      pendingOpenWeTab = false;
      clearTimeout(pendingOpenTimer);
      setWeTabActive(modal, true);
    }
  }

  function scheduleModalSync() {
    if (disposed || modalSyncRaf) return;
    modalSyncRaf = requestAnimationFrame(() => {
      modalSyncRaf = 0;
      syncSettingsModal();
    });
  }

  const domObs = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.target === document.body && m.type === 'attributes') {
        syncPlaybackPowerState();
        syncQuickButton();
        continue;
      }
      if (m.target instanceof Element && m.target.closest('[data-ag-we-ui], #ag-we-stage')) continue;
      if (m.type === 'childList') {
        scheduleModalSync();
        break;
      }
    }
  });
  if (document.body) {
    domObs.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-has-browser-hole', 'data-has-drawer-browser-hole', 'data-has-three-layer-browser-hole'],
    });
  }
  registerCleanup(() => {
    domObs.disconnect();
    if (modalSyncRaf) cancelAnimationFrame(modalSyncRaf);
    clearTimeout(pendingOpenTimer);
  });

  // ── 清理与启动 ──────────────────────────────────────────────────────────────
  registerCleanup(() => {
    disposed = true;
    try { effortSliderInst?.stop?.(); } catch {}
    effortSliderInst = null;
    try { window.__agCodexEffortSliderInstance?.stop?.(); } catch {}
    clearWatchdog();
    document.documentElement.removeAttribute('data-ag-we-active');
    document.documentElement.removeAttribute('data-ag-we-glass');
    document.getElementById(STAGE_ID)?.remove();
    document.getElementById(PANEL_ID)?.remove();
    document.getElementById(NAV_SECTION_FALLBACK_ID)?.remove();
    document.querySelectorAll('[data-ag-we-ui]').forEach((el) => el.remove());
    document.querySelectorAll('.settings-modal-container[data-ag-we-tab-active]').forEach((el) => el.removeAttribute('data-ag-we-tab-active'));
  });

  if (typeof ctx?.onCleanup === 'function') {
    ctx.onCleanup(() => {
      for (const fn of cleanups) {
        try { fn(); } catch {}
      }
    });
  }

  syncQuickButton();
  syncEffortSlider();
  syncSettingsModal();
  void pullState(true).then(() => pullWallpapers(false));
  syncPollTimer = setInterval(() => {
    if (!disposed && !document.hidden) void pullState(false);
  }, 4000);
  registerCleanup(() => clearInterval(syncPollTimer));
})();
