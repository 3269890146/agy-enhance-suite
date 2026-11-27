/**
 * 猫娘额度桌宠（Antigravity-Gemini-Quota-Pet）幂等增强补丁器
 *
 * 职责：
 *   在用户按需克隆官方上游仓库 `Antigravity-Gemini-Quota-Pet` 后，自动安全地打入两项增强补丁
 *   （不分发任何上游受限立绘资源）：
 *     1. Windows 60fps Win32 原生窗口跟随引擎（win-follow.ps1 + main.js）：
 *        绑定 Antigravity 主窗口 Owner 关系，拖动实时跟手、随主窗口最小化/还原、切走自动让位，
 *        且重置到桌面右下角或拖走时立刻安全解绑 GWLP_HWNDPARENT；
 *     2. 官方真实额度直信优化（quota-engine.js）：
 *        配合 `agy-quota-pet-bridge` Sidecar 写入的 `~/.gemini/antigravity-pet-quota.json`，
 *        强制覆盖旧手动校准并优先直信 10 分钟内新鲜的官方真实 5h/周百分比与重置时间，告别本地盲估。
 *
 * 用法：
 *   - 作为模块调用：`patchQuotaPet(targetDir)`
 *   - 命令行直接运行：`node addons/quota-pet/patch-quota-pet.mjs --dir <桌宠目录>`
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WIN_FOLLOW_SRC = join(__dirname, 'win-follow.ps1');

/**
 * 使用 node --check 校验修改后的 JS 文件语法，失败时自动恢复备份。
 */
function verifyJsOrRollback(filePath, backupContent) {
  const res = spawnSync(process.execPath, ['--check', filePath], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (res.status !== 0) {
    writeFileSync(filePath, backupContent, 'utf8');
    throw new Error(`补丁语法校验失败并已自动回滚 (${filePath}): ${res.stderr || res.stdout}`);
  }
}

/**
 * 为 `<targetDir>/src/main.js` 打入 Windows 60fps 原生跟随与安全解绑补丁（幂等）。
 */
function patchMainJs(targetDir) {
  const mainJsPath = join(targetDir, 'src', 'main.js');
  if (!existsSync(mainJsPath)) {
    return { status: 'missing' };
  }

  const original = readFileSync(mainJsPath, 'utf8');
  if (original.includes('detachWindowOwner') && original.includes('win-follow.ps1')) {
    return { status: 'already-patched' };
  }

  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  let content = original.replace(/\r\n/g, '\n');

  // 1. 补充 spawn 导入
  if (content.includes("const { execFile } = require('child_process');")) {
    content = content.replace(
      "const { execFile } = require('child_process');",
      "const { execFile, spawn } = require('child_process');"
    );
  }

  // 2. 补充 followProc 状态变量
  if (!content.includes('let followProc = null;')) {
    content = content.replace(
      'let followTimer = null;',
      'let followTimer = null;\nlet followProc = null;'
    );
  }

  // 3. 默认开启跟随 Antigravity 窗口、关闭全局强制置顶
  content = content.replace(
    /alwaysOnTop:\s*true,\s*\n\s*followAntigravity:\s*false,/,
    'alwaysOnTop: false,\n  followAntigravity: true,'
  );

  // 4. 在窗口展示、页面加载完成与关闭时接入跟手周期管理
  content = content.replace(
    "  petWindow.once('ready-to-show', applyWindowShape);",
    `  petWindow.once('ready-to-show', () => {\n    applyWindowShape();\n    updateWindowFollowLoop();\n  });`
  );
  content = content.replace(
    '  if (settings.alwaysOnTop) {',
    '  if (settings.alwaysOnTop && !settings.followAntigravity) {'
  );
  content = content.replace(
    "  petWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));",
    `  petWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));\n  petWindow.webContents.once('did-finish-load', () => {\n    updateWindowFollowLoop();\n  });`
  );
  content = content.replace(
    "  petWindow.on('closed', () => {\n    petWindow = null;\n  });",
    `  petWindow.on('closed', () => {\n    stopWindowFollow();\n    petWindow = null;\n  });`
  );

  // 5. 替换原本 2.5s 轮询版 updateWindowFollowLoop() 为常驻 Win32 事件钩子驱动 + DetachOnly 解绑
  const followStartIdx = content.indexOf('function updateWindowFollowLoop()');
  const buildMenuIdx = content.indexOf('function buildContextMenuTemplate()');
  if (followStartIdx < 0 || buildMenuIdx < 0 || buildMenuIdx <= followStartIdx) {
    throw new Error('未能定位 main.js 中的 updateWindowFollowLoop 区间，上游结构可能已变更');
  }

  // 保留前面单行注释之外的前置部分，安全替换整个函数体
  const beforeHeaderIdx = content.lastIndexOf('\n// Optional Window-Follow', followStartIdx);
  const sliceEndIdx = beforeHeaderIdx > 0 ? beforeHeaderIdx + 1 : followStartIdx;

  const replacementFollowBlock = [
    'function detachWindowOwner() {',
    "  if (process.platform !== 'win32' || !petWindow || petWindow.isDestroyed()) return;",
    "  const helperScript = path.join(__dirname, 'win-follow.ps1');",
    '  if (!fs.existsSync(helperScript)) return;',
    '  try {',
    '    const hwndBuf = petWindow.getNativeWindowHandle();',
    '    const petHwnd = hwndBuf.length >= 8',
    '      ? hwndBuf.readBigUInt64LE(0).toString()',
    '      : String(hwndBuf.readUInt32LE(0));',
    '    execFile(',
    "      'powershell.exe',",
    "      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', helperScript, '-PetHwnd', petHwnd, '-DetachOnly'],",
    '      { windowsHide: true, timeout: 4000 },',
    '      () => {}',
    '    );',
    '  } catch (_) {}',
    '}',
    '',
    'function stopWindowFollow(detachOwner = false) {',
    '  if (followTimer) {',
    '    clearInterval(followTimer);',
    '    followTimer = null;',
    '  }',
    '  if (followProc) {',
    '    try {',
    '      followProc.kill();',
    '    } catch (_) {}',
    '    followProc = null;',
    '  }',
    '  if (detachOwner) {',
    '    detachWindowOwner();',
    '  }',
    '}',
    '',
    '// Windows 常驻 Win32 原生跟随引擎：绑定 Antigravity 主窗口 Owner，60fps 跟手并自动随最小化/切走隐藏',
    'function updateWindowFollowLoop() {',
    '  if (!petWindow || petWindow.isDestroyed()) {',
    '    stopWindowFollow(false);',
    '    return;',
    '  }',
    '',
    "  if (!settings.followAntigravity || process.platform !== 'win32') {",
    '    stopWindowFollow(true);',
    "    petWindow.setAlwaysOnTop(Boolean(settings.alwaysOnTop), settings.alwaysOnTop ? 'screen-saver' : 'normal');",
    '    if (!petWindow.isVisible()) petWindow.showInactive();',
    '    return;',
    '  }',
    '',
    '  stopWindowFollow(false);',
    '',
    '  // 跟随时由 Win32 Owner 关系保证猫娘只贴在 Antigravity 窗口之上，取消全局强制置顶以免遮挡其他软件',
    '  petWindow.setAlwaysOnTop(false);',
    '  settings.flipped = false;',
    '',
    '  const hwndBuf = petWindow.getNativeWindowHandle();',
    '  const petHwnd = hwndBuf.length >= 8',
    '    ? hwndBuf.readBigUInt64LE(0).toString()',
    '    : String(hwndBuf.readUInt32LE(0));',
    '',
    "  const helperScript = path.join(__dirname, 'win-follow.ps1');",
    '  if (!fs.existsSync(helperScript)) return;',
    '',
    '  followProc = spawn(',
    "    'powershell.exe',",
    "    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', helperScript, '-PetHwnd', petHwnd],",
    '    {',
    '      windowsHide: true,',
    "      stdio: 'ignore',",
    '    }',
    '  );',
    '  const spawnedProc = followProc;',
    "  spawnedProc.on('exit', () => {",
    '    if (followProc === spawnedProc) {',
    '      followProc = null;',
    '    }',
    '  });',
    '}',
    '',
    '',
  ].join('\n');

  content = content.slice(0, sliceEndIdx) + replacementFollowBlock + content.slice(buildMenuIdx);

  // 6. 退出时同步清理跟随子进程
  content = content.replace(
    '  if (followTimer) clearInterval(followTimer);',
    '  stopWindowFollow();'
  );

  writeFileSync(mainJsPath, content.replace(/\n/g, eol), 'utf8');
  verifyJsOrRollback(mainJsPath, original);
  return { status: 'patched' };
}

/**
 * 为 `<targetDir>/src/quota-engine.js` 打入官方真实额度直信补丁（幂等）。
 */
function patchQuotaEngine(targetDir) {
  const enginePath = join(targetDir, 'src', 'quota-engine.js');
  if (!existsSync(enginePath)) {
    return { status: 'missing' };
  }

  const original = readFileSync(enginePath, 'utf8');
  if (
    original.includes("prevCal.source !== 'cli-bridge'") &&
    original.includes('bridgeFresh')
  ) {
    return { status: 'already-patched' };
  }

  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  let content = original.replace(/\r\n/g, '\n');

  // 1. 允许官方桥接文件覆盖旧的非 cli-bridge（如手动）校准
  if (!content.includes("prevCal.source !== 'cli-bridge'")) {
    content = content.replace(
      /if\s*\(!prevCal\s*\|\|\s*updatedAt\s*>\s*prevCal\.calibratedAt\)/g,
      "if (!prevCal || prevCal.source !== 'cli-bridge' || updatedAt > prevCal.calibratedAt)"
    );
  }

  // 2. 10 分钟内新鲜的官方桥接数据直接返回真实百分比，不再叠加本地公式估算扣减
  if (!content.includes('bridgeFresh')) {
    const oldDeltaBlock =
      '      } else {\n' +
      '        const usageSinceCal = this.sumUnitsBetween(anchor.calibratedAt, now);\n' +
      '        const deltaPct = (usageSinceCal.units / budgetUnits) * 100;';
    const newDeltaBlock =
      '      } else {\n' +
      '        // 桥接数据在 10 分钟内保持新鲜时，直接信任官方真实百分比，不再叠加本地公式估算，避免数字来回跳变\n' +
      '        const bridgeFresh =\n' +
      "          anchor.source === 'cli-bridge' &&\n" +
      '          now - anchor.calibratedAt < 10 * 60 * 1000;\n' +
      '        const usageSinceCal = this.sumUnitsBetween(anchor.calibratedAt, now);\n' +
      '        const deltaPct = bridgeFresh ? 0 : (usageSinceCal.units / budgetUnits) * 100;';

    if (!content.includes(oldDeltaBlock)) {
      throw new Error('未能定位 quota-engine.js 中的 computeWindowQuota 估算增量逻辑，上游结构可能已变更');
    }
    content = content.replace(oldDeltaBlock, newDeltaBlock);
  }

  writeFileSync(enginePath, content.replace(/\n/g, eol), 'utf8');
  verifyJsOrRollback(enginePath, original);
  return { status: 'patched' };
}

/**
 * 对指定猫娘桌宠目录执行全套无损增强补丁。
 */
export function patchQuotaPet(targetDir) {
  const absDir = resolve(targetDir);
  if (!existsSync(absDir)) {
    throw new Error(`猫娘桌宠目录不存在: ${absDir}`);
  }

  const winFollowDst = join(absDir, 'src', 'win-follow.ps1');
  let winFollowStatus = 'skipped';
  if (existsSync(WIN_FOLLOW_SRC) && existsSync(join(absDir, 'src'))) {
    copyFileSync(WIN_FOLLOW_SRC, winFollowDst);
    winFollowStatus = 'synced';
  }

  const mainJs = patchMainJs(absDir);
  const quotaEngine = patchQuotaEngine(absDir);

  return {
    targetDir: absDir,
    winFollow: winFollowStatus,
    mainJs: mainJs.status,
    quotaEngine: quotaEngine.status,
  };
}

const isCli =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isCli) {
  const dirFlagIdx = process.argv.indexOf('--dir');
  const dir =
    dirFlagIdx >= 0 && process.argv[dirFlagIdx + 1]
      ? process.argv[dirFlagIdx + 1]
      : process.cwd();
  const result = patchQuotaPet(dir);
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}
