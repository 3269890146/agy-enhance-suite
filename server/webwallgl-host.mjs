/**
 * WebWallGL 渲染页面托管 + /scene-files 与 /web-live 围栏静态资源服务
 * - /scene-live/engine/webwallgl.global.min.js 直出本地依赖包
 * - /scene-live/index.html + renderer.js 通过 postMessage 与父窗口通信（兼容跨源/跨端口）
 * - /scene-files/:id/* 为 WebWallGL httpSource() 提供双层安全围栏与 Range 流式读取
 * - /web-live/:id/* 为网页壁纸自动注入 WE API shim 与 project.json 默认属性 seed
 */
import {
  createReadStream, existsSync, lstatSync, readFileSync, realpathSync, statSync,
} from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';

const MIME_MAP = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.pkg': 'application/octet-stream',
  '.tex': 'application/octet-stream',
  '.mdl': 'application/octet-stream',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

export function mimeOf(filePath) {
  return MIME_MAP[extname(filePath).toLowerCase()] || 'application/octet-stream';
}

export function serveFileWithRange(absPath, req, res, opts = {}) {
  let st;
  try {
    st = statSync(absPath);
    if (!st.isFile()) {
      res.writeHead(404, { 'Cache-Control': 'no-store' });
      res.end('not found');
      return;
    }
  } catch {
    res.writeHead(404, { 'Cache-Control': 'no-store' });
    res.end('not found');
    return;
  }

  const size = st.size;
  const contentType = opts.contentType || mimeOf(absPath);
  const cacheControl = opts.cacheControl || 'public, max-age=3600';
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, {
      'ETag': etag,
      'Cache-Control': cacheControl,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Private-Network': 'true',
    });
    res.end();
    return;
  }

  const baseHeaders = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'ETag': etag,
    'Cache-Control': cacheControl,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Private-Network': 'true',
  };

  const headOnly = (req.method || 'GET').toUpperCase() === 'HEAD';
  const rangeHdr = req.headers.range;
  if (typeof rangeHdr === 'string' && size > 0) {
    const m = /^bytes=(\d*)-(\d*)$/i.exec(rangeHdr.trim());
    if (m && (m[1] !== '' || m[2] !== '')) {
      let start;
      let end;
      if (m[1] !== '' && m[2] !== '') {
        start = parseInt(m[1], 10);
        end = Math.min(parseInt(m[2], 10), size - 1);
      } else if (m[1] !== '') {
        start = parseInt(m[1], 10);
        end = size - 1;
      } else {
        start = Math.max(0, size - parseInt(m[2], 10));
        end = size - 1;
      }
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= size) {
        res.writeHead(416, { ...baseHeaders, 'Content-Range': `bytes */${size}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        ...baseHeaders,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': String(end - start + 1),
      });
      if (headOnly) {
        res.end();
        return;
      }
      const stream = createReadStream(absPath, { start, end });
      stream.on('error', () => {
        if (!res.writableEnded) res.destroy();
      });
      res.on('close', () => stream.destroy());
      stream.pipe(res);
      return;
    }
  }

  res.writeHead(200, {
    ...baseHeaders,
    'Content-Length': String(size),
  });
  if (headOnly) {
    res.end();
    return;
  }
  const stream = createReadStream(absPath);
  stream.on('error', () => {
    if (!res.writableEnded) res.destroy();
  });
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

/** 双层路径围栏：拦截 .. 穿越及符号链接/目录联接逃逸 */
export function resolveFencedPath(rootDir, rawSubpath) {
  const subpath = String(rawSubpath || '').replace(/^\/+/, '').split('?')[0];
  if (!subpath) return null;
  const root = resolve(rootDir);
  const target = resolve(root, subpath);
  if (target !== root && !target.startsWith(root + sep)) return null;

  let realRoot;
  try {
    realRoot = realpathSync.native(root);
  } catch {
    return null;
  }

  let linked = false;
  let realTarget = '';
  try {
    linked = lstatSync(target).isSymbolicLink();
    realTarget = realpathSync.native(target);
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) {
      return { exists: false, target };
    }
    return null;
  }
  if (linked) return null;
  if (realTarget && realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) return null;
  return { exists: true, target: realTarget || target };
}

function cookTemplateLiteral(raw) {
  const simple = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };
  return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r\n|[\s\S])/g, (_, e) => {
    if (e[0] === 'u' && e.length > 1) return String.fromCodePoint(parseInt(e[1] === '{' ? e.slice(2, -1) : e.slice(1), 16));
    if (e[0] === 'x' && e.length === 3) return String.fromCharCode(parseInt(e.slice(1), 16));
    if (e === '\n' || e === '\r\n' || e === '\r') return '';
    return e in simple ? simple[e] : e;
  });
}

let cachedWebShim = null;
function getWebShimSource(webwallglDir) {
  if (cachedWebShim !== null && cachedWebShim !== '') return cachedWebShim;
  try {
    const bundle = readFileSync(join(webwallglDir, 'webwallgl.mjs'), 'utf8');
    const m = /const shimSource = \x60((?:\\[\s\S]|[^\x60\\])*)\x60;/.exec(bundle);
    cachedWebShim = m && !/(^|[^\\])\$\{/.test(m[1]) ? cookTemplateLiteral(m[1]) : '';
  } catch {
    cachedWebShim = '';
  }
  return cachedWebShim;
}

function buildPropsSeedScript(dir) {
  try {
    const pj = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
    const props = pj?.general?.properties;
    if (!props || typeof props !== 'object') return '';
    const wire = {};
    for (const [k, def] of Object.entries(props)) {
      if (!def || typeof def !== 'object' || !('value' in def)) continue;
      if (def.value !== null && def.value !== undefined) {
        wire[k] = { value: def.value };
      }
    }
    if (Object.keys(wire).length === 0) return '';
    return `if (typeof window.__weSeedProps === 'function') window.__weSeedProps(${JSON.stringify(wire)});`;
  } catch {
    return '';
  }
}

const WE_FOCUS_GUARD = `
(() => {
  try {
    const noop = () => {};
    window.alert = noop; window.confirm = () => false; window.prompt = () => null;
    window.open = () => null;
    if (HTMLElement.prototype.focus) {
      const origFocus = HTMLElement.prototype.focus;
      HTMLElement.prototype.focus = function(opts) {
        try { if (document.hasFocus && !document.hasFocus()) return; } catch {}
        return origFocus.call(this, opts);
      };
    }
  } catch {}
})();`;

function injectIntoWebHtml(html, webwallglDir, projectDir) {
  const shim = getWebShimSource(webwallglDir);
  const seed = buildPropsSeedScript(projectDir);
  const scriptBlock = `<script data-ag-we-shim="1">${WE_FOCUS_GUARD}\n${shim}\n${seed}</script>`;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => `${m}\n${scriptBlock}`);
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/<html[^>]*>/i, (m) => `${m}\n<head>${scriptBlock}</head>`);
  }
  return `${scriptBlock}\n${html}`;
}

const SCENE_LIVE_HTML = `<!doctype html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>Antigravity WebWallGL Renderer</title>
  <style>
    html, body {
      margin: 0; padding: 0; width: 100%; height: 100%;
      overflow: hidden; background: transparent;
      user-select: none; -webkit-user-select: none;
    }
    #wp { position: fixed; inset: 0; overflow: hidden; }
  </style>
  <script src="./engine/webwallgl.global.min.js"></script>
  <script type="module" src="./renderer.js"></script>
</head>
<body>
  <div id="wp"></div>
</body>
</html>`;

const SCENE_LIVE_RENDERER_JS = `
if (!globalThis.WebWallGL) {
  window.parent.postMessage({ type: 'ag-we-live-error', id: '', error: 'WebWallGL 引擎未加载' }, '*');
  throw new Error('WebWallGL not loaded');
}
const { createScene, httpSource } = globalThis.WebWallGL;
const params = new URLSearchParams(location.search);
const wpId = params.get('id') || '';
const mediaBase = params.get('mediaBase') || '';
const fit = ['cover', 'contain', 'stretch'].includes(params.get('fit')) ? params.get('fit') : 'cover';
const fps = Number(params.get('fps')) || 60;
const initialVolume = params.get('muted') === 'false' ? Math.max(0, Math.min(1, Number(params.get('volume') ?? 0.4))) : 0;

const host = document.getElementById('wp');
let settled = false;
let destroyed = false;

function notifyParent(type, extra = {}) {
  try {
    window.parent.postMessage({ type, id: wpId, ...extra }, '*');
  } catch {}
}

const inst = createScene(host, {
  fit,
  fps,
  volume: initialVolume,
  onDiagnostic: (msg, level) => {
    if (level === 'error' && !settled) {
      notifyParent('ag-we-live-error', { error: String(msg || 'WebWallGL diagnostic error') });
    }
  }
});

inst.on('error', (err) => {
  if (!settled) notifyParent('ag-we-live-error', { error: String(err?.message || err || 'WebWallGL runtime error') });
});

async function boot() {
  if (!mediaBase || !wpId) {
    notifyParent('ag-we-live-error', { error: '缺少壁纸参数' });
    return;
  }
  const source = httpSource(mediaBase.replace(/\\/+$/, '') + '/' + encodeURIComponent(wpId));
  try {
    await inst.load(source);
    if (destroyed) return;
    inst.setVolume(initialVolume);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (destroyed) return;
        settled = true;
        notifyParent('ag-we-live-ready');
      });
    });
  } catch (err) {
    if (!destroyed) {
      notifyParent('ag-we-live-error', { error: String(err?.message || err || 'scene load failed') });
    }
  }
}

window.addEventListener('message', (ev) => {
  const d = ev.data;
  if (!d || d.type !== 'ag-we-cmd') return;
  try {
    switch (d.cmd) {
      case 'pause': inst.pause(); break;
      case 'resume': inst.resume(); break;
      case 'setVolume': inst.setVolume(Math.max(0, Math.min(1, Number(d.value) || 0))); break;
      case 'setFit': inst.setFit(d.value || 'cover'); break;
      case 'pushPointer': inst.pushPointer(d.u, d.v, d.buttons || 0, d.mods || 0); break;
      case 'pointerLeave': inst.pointerLeave(); break;
    }
  } catch {}
});

window.addEventListener('pagehide', () => {
  destroyed = true;
  try { inst.destroy(); } catch {}
});

boot();
`;

export function createWebWallGlHandler({ webwallglDir, getWallpaperById }) {
  const engineBundlePath = join(webwallglDir, 'webwallgl.global.min.js');

  return function handleAssetRoutes(req, res, pathname) {
    const method = (req.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { 'Cache-Control': 'no-store' });
      res.end('method not allowed');
      return true;
    }

    if (pathname === '/scene-live/index.html' || pathname === '/scene-live/') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Private-Network': 'true',
      });
      res.end(method === 'HEAD' ? undefined : SCENE_LIVE_HTML);
      return true;
    }

    if (pathname === '/scene-live/renderer.js') {
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Private-Network': 'true',
      });
      res.end(method === 'HEAD' ? undefined : SCENE_LIVE_RENDERER_JS);
      return true;
    }

    if (pathname === '/scene-live/engine/webwallgl.global.min.js') {
      serveFileWithRange(engineBundlePath, req, res, {
        contentType: 'application/javascript; charset=utf-8',
        cacheControl: 'public, max-age=86400',
      });
      return true;
    }

    if (pathname.startsWith('/scene-files/') || pathname.startsWith('/web-live/')) {
      const isWebLive = pathname.startsWith('/web-live/');
      const prefix = isWebLive ? '/web-live/' : '/scene-files/';
      let rest;
      try {
        rest = decodeURIComponent(pathname.slice(prefix.length));
      } catch {
        res.writeHead(400, { 'Cache-Control': 'no-store' });
        res.end('bad request');
        return true;
      }
      const slashIdx = rest.indexOf('/');
      const id = slashIdx >= 0 ? rest.slice(0, slashIdx) : rest;
      const subpath = slashIdx >= 0 ? rest.slice(slashIdx + 1) : '';
      const wp = getWallpaperById(id);
      if (!wp || !wp.dir) {
        res.writeHead(404, { 'Cache-Control': 'no-store' });
        res.end('wallpaper not found');
        return true;
      }
      const rel = subpath || (wp.fileRel || 'index.html');
      const fenced = resolveFencedPath(wp.dir, rel);
      if (!fenced) {
        res.writeHead(403, { 'Cache-Control': 'no-store' });
        res.end('forbidden');
        return true;
      }
      if (!fenced.exists || !existsSync(fenced.target)) {
        res.writeHead(404, { 'Cache-Control': 'no-store' });
        res.end('file not found');
        return true;
      }

      if (isWebLive && method === 'GET' && /\.html?$/i.test(fenced.target)) {
        try {
          const rawHtml = readFileSync(fenced.target, 'utf8');
          const injected = injectIntoWebHtml(rawHtml, webwallglDir, wp.dir);
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Private-Network': 'true',
          });
          res.end(injected);
          return true;
        } catch {
          res.writeHead(500, { 'Cache-Control': 'no-store' });
          res.end('read html failed');
          return true;
        }
      }

      serveFileWithRange(fenced.target, req, res);
      return true;
    }

    return false;
  };
}
