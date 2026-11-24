/**
 * Steam Wallpaper Engine 壁纸库 + 本地自定义导入目录扫描器
 * 兼容：Steam 创意工坊 (431960)、WE 内置/个人项目、本地上传目录 (data/uploads/)。
 * 严格容错：对未挂载盘符（如失效的 F:\ 库路径）或损坏的 project.json 绝不抛出中断。
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join, normalize, resolve } from 'node:path';

const WE_APPID = '431960';
const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;
const VIDEO_EXT_RE = /\.(mp4|webm|mkv|avi|mov)$/i;
const WEB_EXT_RE = /\.(html?|js)$/i;

function safeExists(p) {
  try {
    return Boolean(p) && existsSync(p);
  } catch {
    return false;
  }
}

function safeIsFile(p) {
  try {
    return safeExists(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

function safeIsDir(p) {
  try {
    return safeExists(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function querySteamRegistryPath() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  const regExe = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
  return new Promise((resolvePromise) => {
    try {
      execFile(
        regExe,
        ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'],
        { encoding: 'utf8', windowsHide: true, timeout: 4000 },
        (err, stdout) => {
          if (err || !stdout) {
            resolvePromise(null);
            return;
          }
          const m = /SteamPath\s+REG_SZ\s+(.+)/i.exec(stdout);
          resolvePromise(m ? normalize(m[1].trim()) : null);
        }
      );
    } catch {
      resolvePromise(null);
    }
  });
}

function wslTranslatePath(p) {
  if (process.platform !== 'linux' || typeof p !== 'string') return p;
  const m = /^([a-zA-Z]):[\\/](.*)$/.exec(p);
  if (!m) return p;
  return join('/mnt', m[1].toLowerCase(), m[2].replace(/\\/g, '/'));
}

function parseVdfLibraryPaths(vdfPath) {
  if (!safeIsFile(vdfPath)) return [];
  try {
    const raw = readFileSync(vdfPath, 'utf8');
    const paths = [];
    for (const m of raw.matchAll(/"path"\s+"([^"]+)"/g)) {
      const p = normalize(wslTranslatePath(m[1].replace(/\\\\/g, '\\')));
      if (p && safeIsDir(p) && !paths.includes(p)) paths.push(p);
    }
    return paths;
  } catch {
    return [];
  }
}

function getPlatformCandidateRoots() {
  const list = [];
  const envRaw = process.env.AGY_WE_STEAM_ROOT || process.env.DSH_WE_STEAM_ROOT || '';
  for (const part of envRaw.split(/[,;]/)) {
    const t = part.trim();
    if (t) list.push(wslTranslatePath(t));
  }

  if (process.platform === 'win32') {
    for (let code = 67; code <= 90; code++) {
      const drive = `${String.fromCharCode(code)}:\\`;
      if (!safeIsDir(drive)) continue;
      list.push(
        join(drive, 'Program Files (x86)', 'Steam'),
        join(drive, 'Program Files', 'Steam'),
        join(drive, 'Steam'),
        join(drive, 'SteamLibrary')
      );
    }
  } else if (process.platform === 'darwin') {
    list.push(join(homedir(), 'Library', 'Application Support', 'Steam'));
  } else {
    list.push(
      join(homedir(), '.steam', 'steam'),
      join(homedir(), '.local', 'share', 'Steam')
    );
    try {
      for (const mnt of readdirSync('/mnt')) {
        if (/^[a-zA-Z]$/.test(mnt)) {
          list.push(
            join('/mnt', mnt, 'Program Files (x86)', 'Steam'),
            join('/mnt', mnt, 'Steam'),
            join('/mnt', mnt, 'SteamLibrary')
          );
        }
      }
    } catch { /* ignore */ }
  }
  return list;
}

async function discoverRoots() {
  const roots = new Set();
  const regPath = await querySteamRegistryPath();
  if (regPath && safeIsDir(regPath)) roots.add(regPath);
  for (const r of getPlatformCandidateRoots()) {
    if (safeIsDir(r)) roots.add(normalize(r));
  }
  const candidates = [...roots];
  for (const r of candidates) {
    const vdf = join(r, 'steamapps', 'libraryfolders.vdf');
    for (const lib of parseVdfLibraryPaths(vdf)) {
      roots.add(lib);
    }
  }

  let weInstallDir = null;
  const workshopDirs = [];
  for (const lib of roots) {
    const appDir = join(lib, 'steamapps', 'common', 'wallpaper_engine');
    if (!weInstallDir && safeIsDir(appDir)) {
      weInstallDir = appDir;
    }
    const wsDir = join(lib, 'steamapps', 'workshop', 'content', WE_APPID);
    if (safeIsDir(wsDir) && !workshopDirs.includes(wsDir)) {
      workshopDirs.push(wsDir);
    }
  }
  return { weInstallDir, workshopDirs };
}

function readHiddenSet(rootDir) {
  const visPath = join(rootDir, 'visibility.json');
  if (!safeIsFile(visPath)) return new Set();
  try {
    const obj = JSON.parse(readFileSync(visPath, 'utf8'));
    const hidden = new Set();
    const walk = (node) => {
      if (!node || typeof node !== 'object' || Array.isArray(node)) return;
      for (const [k, v] of Object.entries(node)) {
        if (v === false) {
          hidden.add(String(k));
          hidden.add(String(k).split(/[\\/]/).pop());
        } else if (v && typeof v === 'object') {
          walk(v);
        }
      }
    };
    walk(obj);
    return hidden;
  } catch {
    return new Set();
  }
}

function inferType(file) {
  if (!file) return 'scene';
  if (VIDEO_EXT_RE.test(file)) return 'video';
  if (WEB_EXT_RE.test(file)) return 'web';
  if (IMAGE_EXT_RE.test(file)) return 'image';
  return 'scene';
}

function findSceneMainFile(dir, declared) {
  for (const cand of [declared, 'scene.pkg', 'scene.json']) {
    if (cand && safeIsFile(resolve(dir, cand))) return cand;
  }
  try {
    const pkgs = readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.pkg'));
    if (pkgs.length > 0) return pkgs[0];
  } catch { /* ignore */ }
  return null;
}

function findFallbackPreview(dir, declaredPreview) {
  if (declaredPreview) {
    const p = resolve(dir, declaredPreview);
    if (safeIsFile(p)) return p;
  }
  for (const name of ['preview.jpg', 'preview.png', 'preview.gif', 'preview.webp']) {
    const p = join(dir, name);
    if (safeIsFile(p)) return p;
  }
  return null;
}

function parseProjectItem(dir, sourceTag, idPrefix) {
  const pjPath = join(dir, 'project.json');
  if (!safeIsFile(pjPath)) return null;
  let o;
  try {
    o = JSON.parse(readFileSync(pjPath, 'utf8'));
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;

  const declared = typeof o.type === 'string' ? o.type.toLowerCase() : '';
  if (declared === 'application') return null;

  let file = typeof o.file === 'string' && o.file.trim() ? o.file.trim() : null;
  let type = declared ? (['scene', 'video', 'web', 'image'].includes(declared) ? declared : 'scene') : inferType(file);

  // 处理图片 / 幻灯片项目
  if (!file && o.preset && typeof o.preset === 'object') {
    const img = typeof o.preset.image === 'string' ? o.preset.image.trim() : '';
    const customDir = typeof o.preset.customdirectory === 'string' ? o.preset.customdirectory.trim() : '';
    if (img && safeIsFile(resolve(dir, img))) {
      file = img;
      type = 'image';
    } else if (customDir && safeIsDir(resolve(dir, customDir))) {
      try {
        const firstImg = readdirSync(resolve(dir, customDir)).find((n) => IMAGE_EXT_RE.test(n));
        if (firstImg) {
          file = `${customDir.replace(/\\/g, '/')}/${firstImg}`;
          type = 'image';
        }
      } catch { /* ignore */ }
    }
  }

  let mainAbs = null;
  let pkgAbs = null;
  if (type === 'scene') {
    const mainRel = findSceneMainFile(dir, file);
    if (mainRel) mainAbs = resolve(dir, mainRel);
    const pkgCand = join(dir, 'scene.pkg');
    if (safeIsFile(pkgCand)) {
      pkgAbs = pkgCand;
    } else if (mainAbs && mainAbs.toLowerCase().endsWith('.pkg')) {
      pkgAbs = mainAbs;
    }
  } else if (file) {
    const candidate = resolve(dir, file);
    if (safeIsFile(candidate)) mainAbs = candidate;
  }

  // 查找目录中直接附带的 mp4（供视频或场景备选）
  let sidecarMp4 = null;
  if (type === 'video' && mainAbs) {
    sidecarMp4 = mainAbs;
  } else {
    try {
      const mp4 = readdirSync(dir).find((n) => /\.(mp4|webm)$/i.test(n));
      if (mp4) sidecarMp4 = join(dir, mp4);
    } catch { /* ignore */ }
  }

  const previewAbs = findFallbackPreview(dir, typeof o.preview === 'string' ? o.preview : null)
    || (type === 'image' ? mainAbs : null);

  if (!mainAbs && !previewAbs && !sidecarMp4) return null;

  const folderId = basename(dir);
  return {
    id: `${idPrefix}_${folderId}`,
    rawId: folderId,
    source: sourceTag,
    title: typeof o.title === 'string' && o.title.trim() ? o.title.trim() : folderId,
    type,
    dir,
    fileRel: file ? file.replace(/\\/g, '/') : null,
    mainAbs,
    pkgAbs,
    videoAbs: sidecarMp4,
    previewAbs,
    tags: Array.isArray(o.tags) ? o.tags.slice(0, 6) : [],
    contentrating: typeof o.contentrating === 'string' ? o.contentrating : 'Everyone',
  };
}

function scanUploads(uploadsDir) {
  mkdirSync(uploadsDir, { recursive: true });
  const list = [];
  let names = [];
  try {
    names = readdirSync(uploadsDir);
  } catch {
    return list;
  }
  for (const name of names) {
    if (name.endsWith('.json')) continue;
    const abs = join(uploadsDir, name);
    if (!safeIsFile(abs)) continue;
    const ext = extname(name).toLowerCase();
    const isVideo = VIDEO_EXT_RE.test(ext);
    const isImg = IMAGE_EXT_RE.test(ext);
    if (!isVideo && !isImg) continue;
    let title = name.replace(/\.[^.]+$/, '');
    const metaPath = `${abs}.meta.json`;
    if (safeIsFile(metaPath)) {
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
        if (meta?.title) title = meta.title;
      } catch { /* ignore */ }
    }
    const id = `upload_${Buffer.from(name, 'utf8').toString('hex').slice(0, 16)}`;
    list.push({
      id,
      rawId: name,
      source: 'upload',
      title,
      type: isVideo ? 'video' : 'image',
      dir: uploadsDir,
      fileRel: name,
      mainAbs: abs,
      pkgAbs: null,
      videoAbs: isVideo ? abs : null,
      previewAbs: isImg ? abs : null,
      tags: ['自定义导入'],
      contentrating: 'Everyone',
    });
  }
  return list;
}

export async function scanAllWallpapers(uploadsDir) {
  const { weInstallDir, workshopDirs } = await discoverRoots();
  const items = [];
  const seen = new Set();

  // 1. 自定义上传优先展示
  for (const up of scanUploads(uploadsDir)) {
    if (!seen.has(up.id)) {
      seen.add(up.id);
      items.push(up);
    }
  }

  // 2. Steam 创意工坊壁纸 (431960)
  for (const wsDir of workshopDirs) {
    const hidden = readHiddenSet(wsDir);
    let dirs = [];
    try {
      dirs = readdirSync(wsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      continue;
    }
    for (const d of dirs) {
      if (hidden.has(d.name)) continue;
      const item = parseProjectItem(join(wsDir, d.name), 'workshop', 'ws');
      if (item && !seen.has(item.id)) {
        seen.add(item.id);
        items.push(item);
      }
    }
  }

  // 3. Wallpaper Engine 内置与本地工程
  if (weInstallDir) {
    for (const sub of ['myprojects', 'defaultprojects']) {
      const root = join(weInstallDir, 'projects', sub);
      if (!safeIsDir(root)) continue;
      const hidden = readHiddenSet(root);
      let dirs = [];
      try {
        dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
      } catch {
        continue;
      }
      for (const d of dirs) {
        if (hidden.has(d.name)) continue;
        const item = parseProjectItem(join(root, d.name), sub === 'myprojects' ? 'local' : 'default', sub);
        if (item && !seen.has(item.id)) {
          seen.add(item.id);
          items.push(item);
        }
      }
    }
  }

  return {
    weInstallDir,
    workshopDirs,
    items,
  };
}
