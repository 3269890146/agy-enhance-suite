/**
 * Antigravity 动态壁纸与书卷液态玻璃后台媒体守护服务
 * - 默认监听 http://127.0.0.1:48791，纯本地回环，不对外网暴露、不消耗模型 Token
 * - 提供壁纸库扫描、设置持久化、本地导入、Range 视频流、Scene 内嵌 MP4 二级降级与 WebWallGL 托管
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import {
  existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanAllWallpapers } from './scanner.mjs';
import { extractEmbeddedMp4ToCache } from './pkg-reader.mjs';
import { createWebWallGlHandler, serveFileWithRange } from './webwallgl-host.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = resolve(__dirname, '..');
const DATA_DIR = join(ROOT_DIR, 'data');
const UPLOADS_DIR = join(DATA_DIR, 'uploads');
const CACHE_MP4_DIR = join(DATA_DIR, 'cache', 'scene-mp4');
const SETTINGS_PATH = join(DATA_DIR, 'settings.json');
const PID_PATH = join(DATA_DIR, 'daemon.pid');
const LOG_PATH = join(DATA_DIR, 'daemon.log');
const WEBWALLGL_DIR = join(ROOT_DIR, 'node_modules', 'webwallgl');

const PORT = Number(process.env.AGY_WE_PORT || 48791);
const HOST = '127.0.0.1';
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(UPLOADS_DIR, { recursive: true });
mkdirSync(CACHE_MP4_DIR, { recursive: true });

function appendLog(line) {
  try {
    const ts = new Date().toISOString();
    writeFileSync(LOG_PATH, `[${ts}] ${line}\n`, { flag: 'a', encoding: 'utf8' });
  } catch { /* ignore */ }
}

const DEFAULT_SETTINGS = {
  revision: 1,
  enabled: true,
  glassEnabled: true,
  currentId: null,
  paused: false,
  muted: true,
  volume: 0.35,
  pauseOnBlur: true,
  showQuickBtn: true,
  effortSliderEnabled: true,
  fileContextMenuEnabled: true,
  sceneLive: true,
  fit: 'cover',
  sceneFps: 60,
  carouselEnabled: false,
  carouselMinutes: 15,
  carouselShuffle: true,
  glassPreset: 'book-glass',
  mainOpacity: 58,
  sidebarOpacity: 66,
  cardOpacity: 74,
  blurPx: 18,
  saturatePct: 135,
  scrimOpacity: 24,
};

function loadSettings() {
  if (!existsSync(SETTINGS_PATH)) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(next) {
  const tmp = `${SETTINGS_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  renameSync(tmp, SETTINGS_PATH);
}

let settings = loadSettings();
let inventory = { weInstallDir: null, workshopDirs: [], items: [] };
let inventoryById = new Map();
let lastScanAt = 0;

async function refreshInventory(force = false) {
  if (!force && inventory.items.length > 0 && Date.now() - lastScanAt < 30000) {
    return inventory;
  }
  inventory = await scanAllWallpapers(UPLOADS_DIR);
  inventoryById = new Map(inventory.items.map((it) => [it.id, it]));
  lastScanAt = Date.now();

  // 首次安装或原壁纸失效时，自动选定第 1 张可用壁纸，确保开箱即生效
  if ((!settings.currentId || !inventoryById.has(settings.currentId)) && inventory.items.length > 0) {
    const preferred = inventory.items.find((it) => it.type === 'scene' && it.previewAbs)
      || inventory.items.find((it) => it.type === 'video' && it.videoAbs)
      || inventory.items[0];
    if (preferred) {
      settings.currentId = preferred.id;
      settings.revision = (settings.revision || 1) + 1;
      saveSettings(settings);
    }
  }
  return inventory;
}

function serializeWallpaper(it) {
  const base = `http://${HOST}:${PORT}`;
  const idEnc = encodeURIComponent(it.id);
  return {
    id: it.id,
    rawId: it.rawId,
    source: it.source,
    title: it.title,
    type: it.type,
    tags: it.tags,
    contentrating: it.contentrating,
    hasPreview: Boolean(it.previewAbs),
    hasVideo: Boolean(it.videoAbs || it.pkgAbs),
    previewUrl: it.previewAbs ? `${base}/media/preview/${idEnc}` : null,
    videoUrl: it.videoAbs || it.pkgAbs ? `${base}/media/video/${idEnc}` : null,
    sceneLiveUrl: it.type === 'scene' && it.mainAbs
      ? `${base}/scene-live/index.html?id=${idEnc}&mediaBase=${encodeURIComponent(`${base}/scene-files`)}`
      : null,
    webLiveUrl: it.type === 'web' && it.fileRel
      ? `${base}/web-live/${idEnc}/${it.fileRel.split('/').map(encodeURIComponent).join('/')}`
      : null,
  };
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Filename, X-Title');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
}

function sendJson(res, status, obj) {
  setCorsHeaders(res);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}

function readRequestBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        rejectPromise(new Error('payload too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks)));
    req.on('error', rejectPromise);
  });
}

function clampNum(v, min, max, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function applySettingsPatch(patch) {
  if (!patch || typeof patch !== 'object') return;
  if ('enabled' in patch) settings.enabled = Boolean(patch.enabled);
  if ('glassEnabled' in patch) settings.glassEnabled = Boolean(patch.glassEnabled);
  if ('currentId' in patch) settings.currentId = patch.currentId ? String(patch.currentId) : null;
  if ('paused' in patch) settings.paused = Boolean(patch.paused);
  if ('muted' in patch) settings.muted = Boolean(patch.muted);
  if ('volume' in patch) settings.volume = clampNum(patch.volume, 0, 1, settings.volume);
  if ('pauseOnBlur' in patch) settings.pauseOnBlur = Boolean(patch.pauseOnBlur);
  if ('showQuickBtn' in patch) settings.showQuickBtn = Boolean(patch.showQuickBtn);
  if ('effortSliderEnabled' in patch) settings.effortSliderEnabled = Boolean(patch.effortSliderEnabled);
  if ('fileContextMenuEnabled' in patch) settings.fileContextMenuEnabled = Boolean(patch.fileContextMenuEnabled);
  if ('sceneLive' in patch) settings.sceneLive = Boolean(patch.sceneLive);
  if ('fit' in patch && ['cover', 'contain', 'stretch'].includes(patch.fit)) settings.fit = patch.fit;
  if ('sceneFps' in patch) settings.sceneFps = clampNum(patch.sceneFps, 15, 144, settings.sceneFps);
  if ('carouselEnabled' in patch) settings.carouselEnabled = Boolean(patch.carouselEnabled);
  if ('carouselMinutes' in patch) settings.carouselMinutes = clampNum(patch.carouselMinutes, 1, 1440, settings.carouselMinutes);
  if ('carouselShuffle' in patch) settings.carouselShuffle = Boolean(patch.carouselShuffle);
  if ('glassPreset' in patch && typeof patch.glassPreset === 'string') settings.glassPreset = patch.glassPreset;
  if ('mainOpacity' in patch) settings.mainOpacity = clampNum(patch.mainOpacity, 20, 96, settings.mainOpacity);
  if ('sidebarOpacity' in patch) settings.sidebarOpacity = clampNum(patch.sidebarOpacity, 20, 98, settings.sidebarOpacity);
  if ('cardOpacity' in patch) settings.cardOpacity = clampNum(patch.cardOpacity, 25, 98, settings.cardOpacity);
  if ('blurPx' in patch) settings.blurPx = clampNum(patch.blurPx, 0, 40, settings.blurPx);
  if ('saturatePct' in patch) settings.saturatePct = clampNum(patch.saturatePct, 80, 220, settings.saturatePct);
  if ('scrimOpacity' in patch) settings.scrimOpacity = clampNum(patch.scrimOpacity, 0, 75, settings.scrimOpacity);
  settings.revision = (settings.revision || 1) + 1;
  saveSettings(settings);
}

const handleWebWallGl = createWebWallGlHandler({
  webwallglDir: WEBWALLGL_DIR,
  getWallpaperById: (id) => inventoryById.get(id) || null,
});

/**
 * 解析并安全校验来自前端的本地路径 / file:// URI（仅允许绝对路径，严禁 HTTP 等外部协议）。
 */
function resolveLocalRevealTarget(rawInput, action = 'reveal') {
  if (!rawInput || typeof rawInput !== 'string') {
    return { ok: false, status: 400, error: '缺少目标路径' };
  }
  let s = rawInput.trim().replace(/^["'`]+|["'`]+$/g, '');
  if (!s || s.length > 1024) {
    return { ok: false, status: 400, error: '路径格式无效' };
  }

  const lower = s.toLowerCase();
  if (/^(https?|mailto|tel|javascript|data|blob|plugin|about):/.test(lower)) {
    return { ok: false, status: 400, error: '仅支持打开本地文件或文件夹路径' };
  }

  const safeDecode = (val) => {
    try { return decodeURIComponent(val); } catch { return val; }
  };

  if (/^(file|vscode-file):\/\//i.test(s)) {
    s = s.replace(/^(file|vscode-file):\/\/(?:vscode-app)?/i, '');
    const hashIdx = s.indexOf('#');
    if (hashIdx !== -1) s = s.slice(0, hashIdx);
    const qIdx = s.indexOf('?');
    if (qIdx !== -1) s = s.slice(0, qIdx);
    s = safeDecode(s);
    if (/^\/[A-Za-z]:/.test(s)) s = s.slice(1);
    if (!s.startsWith('//') && /^[a-zA-Z0-9._-]+\//.test(s) && !s.startsWith('/')) {
      s = '//' + s;
    }
  } else {
    const hashIdx = s.indexOf('#');
    if (hashIdx !== -1 && /^#L\d+/i.test(s.slice(hashIdx))) {
      s = s.slice(0, hashIdx);
    }
    s = safeDecode(s);
  }

  // 去除末尾 :行号 或 :行号:列号
  s = s.replace(/^(.*[^:]):\d+(?::\d+)?$/, '$1').trim();
  if (/^~[\\/]/.test(s)) {
    s = join(homedir(), s.slice(2));
  }
  if (!s || !isAbsolute(s)) {
    return { ok: false, status: 400, error: '仅允许本地绝对路径' };
  }

  const cleanPath = normalize(s);
  if (existsSync(cleanPath)) {
    try {
      const st = statSync(cleanPath);
      return { ok: true, path: cleanPath, isDir: st.isDirectory(), fallbackParent: false };
    } catch {
      return { ok: false, status: 500, error: '读取路径状态失败' };
    }
  }

  // 若目标文件已移动/删除但请求的是打开所在文件夹，自动降级打开存在的父目录
  if (action === 'reveal') {
    const parent = dirname(cleanPath);
    if (parent && parent !== cleanPath && existsSync(parent)) {
      return { ok: true, path: parent, isDir: true, fallbackParent: true };
    }
  }
  return { ok: false, status: 404, error: '目标文件或文件夹不存在' };
}

/**
 * 通过系统原生文件管理器拉起目标（严格采用参数数组传递，零 Shell 拼接）。
 */
function launchExternalReveal(targetPath, isDir, action) {
  if (process.platform === 'win32') {
    const winPath = String(targetPath).replace(/\//g, '\\').replace(/["\r\n]/g, '');
    // 使用 windowsVerbatimArguments 保证 explorer.exe 收到 /select,"..." 而非整段被引号包裹导致回退打开「文档」
    const args = action === 'reveal' && !isDir ? [`/select,"${winPath}"`] : [`"${winPath}"`];
    const child = spawn('explorer.exe', args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      windowsVerbatimArguments: true,
    });
    child.unref();
    return;
  }
  if (process.platform === 'darwin') {
    const args = action === 'reveal' && !isDir ? ['-R', targetPath] : [targetPath];
    const child = spawn('open', args, { detached: true, stdio: 'ignore' });
    child.unref();
    return;
  }
  const dirOrTarget = action === 'reveal' && !isDir ? dirname(targetPath) : targetPath;
  const child = spawn('xdg-open', [dirOrTarget], { detached: true, stdio: 'ignore' });
  child.unref();
}

const server = createServer(async (req, res) => {
  try {
    setCorsHeaders(res);
    const method = (req.method || 'GET').toUpperCase();
    if (method === 'OPTIONS') {
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      res.end();
      return;
    }

    const urlObj = new URL(req.url || '/', `http://${HOST}:${PORT}`);
    const pathname = urlObj.pathname;

    if (pathname === '/api/health') {
      await refreshInventory(false);
      sendJson(res, 200, {
        ok: true,
        version: '1.0.0',
        pid: process.pid,
        port: PORT,
        wallpaperCount: inventory.items.length,
        currentId: settings.currentId,
        weInstallDir: inventory.weInstallDir,
      });
      return;
    }

    if (pathname === '/api/state' && method === 'GET') {
      await refreshInventory(false);
      const cur = settings.currentId ? inventoryById.get(settings.currentId) : null;
      sendJson(res, 200, {
        ok: true,
        settings,
        current: cur ? serializeWallpaper(cur) : null,
        totalCount: inventory.items.length,
      });
      return;
    }

    if (pathname === '/api/settings' && method === 'POST') {
      const buf = await readRequestBody(req);
      const patch = JSON.parse(buf.toString('utf8') || '{}');
      applySettingsPatch(patch);
      await refreshInventory(false);
      const cur = settings.currentId ? inventoryById.get(settings.currentId) : null;
      sendJson(res, 200, {
        ok: true,
        settings,
        current: cur ? serializeWallpaper(cur) : null,
      });
      return;
    }

    if (pathname === '/api/reveal' && method === 'POST') {
      const buf = await readRequestBody(req);
      const body = JSON.parse(buf.toString('utf8') || '{}');
      const action = body.action === 'open' ? 'open' : 'reveal';
      const resolved = resolveLocalRevealTarget(body.path, action);
      if (!resolved.ok) {
        sendJson(res, resolved.status || 400, { ok: false, error: resolved.error });
        return;
      }
      if (!body.dryRun) {
        launchExternalReveal(resolved.path, resolved.isDir, action);
      }
      sendJson(res, 200, {
        ok: true,
        action,
        path: resolved.path,
        isDir: resolved.isDir,
        fallbackParent: resolved.fallbackParent,
      });
      return;
    }

    if (pathname === '/api/next' && method === 'POST') {
      await refreshInventory(false);
      let body = {};
      try {
        const buf = await readRequestBody(req);
        if (buf.length > 0) body = JSON.parse(buf.toString('utf8'));
      } catch { /* ignore */ }
      if (inventory.items.length > 0) {
        const curIdx = inventory.items.findIndex((it) => it.id === settings.currentId);
        const shuffle = typeof body.shuffle === 'boolean' ? body.shuffle : settings.carouselShuffle;
        let nextIdx = 0;
        if (shuffle && inventory.items.length > 1) {
          do {
            nextIdx = Math.floor(Math.random() * inventory.items.length);
          } while (nextIdx === curIdx);
        } else {
          nextIdx = (curIdx + 1) % inventory.items.length;
        }
        applySettingsPatch({ currentId: inventory.items[nextIdx].id });
      }
      const cur = settings.currentId ? inventoryById.get(settings.currentId) : null;
      sendJson(res, 200, {
        ok: true,
        settings,
        current: cur ? serializeWallpaper(cur) : null,
      });
      return;
    }

    if (pathname === '/api/wallpapers' && method === 'GET') {
      const force = urlObj.searchParams.get('refresh') === '1';
      await refreshInventory(force);
      sendJson(res, 200, {
        ok: true,
        total: inventory.items.length,
        items: inventory.items.map(serializeWallpaper),
      });
      return;
    }

    if (pathname === '/api/upload' && method === 'POST') {
      const rawName = decodeURIComponent(String(req.headers['x-filename'] || urlObj.searchParams.get('filename') || 'wallpaper.png'));
      const rawTitle = decodeURIComponent(String(req.headers['x-title'] || urlObj.searchParams.get('title') || ''));
      const ext = extname(rawName).toLowerCase();
      if (!/\.(jpe?g|png|webp|gif|bmp|avif|mp4|webm|mov)$/i.test(ext)) {
        sendJson(res, 400, { ok: false, error: '仅支持 jpg/png/webp/gif/mp4/webm 格式' });
        return;
      }
      const buf = await readRequestBody(req, MAX_UPLOAD_BYTES);
      if (buf.length === 0) {
        sendJson(res, 400, { ok: false, error: '上传文件为空' });
        return;
      }
      const safeStem = basename(rawName, ext).replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 48) || 'custom';
      const fileName = `${Date.now()}_${safeStem}${ext}`;
      const destPath = join(UPLOADS_DIR, fileName);
      writeFileSync(destPath, buf);
      writeFileSync(`${destPath}.meta.json`, JSON.stringify({ title: rawTitle || basename(rawName, ext), createdAt: Date.now() }), 'utf8');
      await refreshInventory(true);
      const created = inventory.items.find((it) => it.rawId === fileName);
      if (created) applySettingsPatch({ currentId: created.id });
      sendJson(res, 200, {
        ok: true,
        item: created ? serializeWallpaper(created) : null,
        settings,
      });
      return;
    }

    if (pathname.startsWith('/api/upload/') && method === 'DELETE') {
      const id = decodeURIComponent(pathname.slice('/api/upload/'.length));
      await refreshInventory(false);
      const target = inventoryById.get(id);
      if (!target || target.source !== 'upload') {
        sendJson(res, 404, { ok: false, error: '未找到该自定义壁纸' });
        return;
      }
      try { if (existsSync(target.mainAbs)) unlinkSync(target.mainAbs); } catch {}
      try { if (existsSync(`${target.mainAbs}.meta.json`)) unlinkSync(`${target.mainAbs}.meta.json`); } catch {}
      await refreshInventory(true);
      sendJson(res, 200, { ok: true, settings });
      return;
    }

    if (pathname.startsWith('/media/preview/')) {
      const id = decodeURIComponent(pathname.slice('/media/preview/'.length));
      await refreshInventory(false);
      const wp = inventoryById.get(id);
      if (!wp || !wp.previewAbs) {
        sendJson(res, 404, { ok: false, error: 'preview not found' });
        return;
      }
      serveFileWithRange(wp.previewAbs, req, res, { cacheControl: 'public, max-age=86400' });
      return;
    }

    if (pathname.startsWith('/media/video/')) {
      const id = decodeURIComponent(pathname.slice('/media/video/'.length));
      await refreshInventory(false);
      const wp = inventoryById.get(id);
      if (!wp) {
        sendJson(res, 404, { ok: false, error: 'wallpaper not found' });
        return;
      }
      let videoPath = wp.videoAbs;
      if (!videoPath && wp.pkgAbs) {
        const cacheMp4 = join(CACHE_MP4_DIR, `${wp.id.replace(/[^a-zA-Z0-9_-]/g, '_')}.mp4`);
        videoPath = await extractEmbeddedMp4ToCache(wp.pkgAbs, cacheMp4);
      }
      if (!videoPath || !existsSync(videoPath)) {
        sendJson(res, 404, { ok: false, error: 'no embedded video available' });
        return;
      }
      serveFileWithRange(videoPath, req, res, { cacheControl: 'public, max-age=3600' });
      return;
    }

    if (handleWebWallGl(req, res, pathname)) {
      return;
    }

    sendJson(res, 404, { ok: false, error: 'not found' });
  } catch (err) {
    appendLog(`Request error: ${err?.stack || err}`);
    if (!res.headersSent) {
      sendJson(res, 500, { ok: false, error: String(err?.message || err) });
    }
  }
});

async function isAlreadyHealthy() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1200);
    const res = await fetch(`http://${HOST}:${PORT}/api/health`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return false;
    const j = await res.json();
    return Boolean(j?.ok);
  } catch {
    return false;
  }
}

async function start() {
  if (await isAlreadyHealthy()) {
    process.exit(0);
  }
  await refreshInventory(true);
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      process.exit(0);
    }
    appendLog(`Server error: ${err?.stack || err}`);
  });
  server.listen(PORT, HOST, () => {
    try {
      writeFileSync(PID_PATH, `${process.pid}\n${PORT}\n`, 'utf8');
    } catch {}
    const msg = `Wallpaper Daemon listening on http://${HOST}:${PORT} (wallpapers: ${inventory.items.length}, current: ${settings.currentId || 'none'})`;
    appendLog(msg);
    console.log(msg);
  });
}

function shutdown() {
  try {
    if (existsSync(PID_PATH)) unlinkSync(PID_PATH);
  } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (e) => appendLog(`uncaughtException: ${e?.stack || e}`));
process.on('unhandledRejection', (e) => appendLog(`unhandledRejection: ${e?.stack || e}`));

start().catch((err) => {
  appendLog(`Startup failed: ${err?.stack || err}`);
  console.error(err);
  process.exit(1);
});
