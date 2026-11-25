/**
 * 船板 × Wallpaper Engine 液态玻璃主题全自动安装与生命周期 CLI
 * 支持子命令：install | sync-ui | start | stop | status | doctor | uninstall
 * 支持参数：--update-chuanban | --skip-chuanban | --preset <name> | --dark-preset <name> | --full
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = __dirname;
const DATA_DIR = join(ROOT_DIR, 'data');
const BACKUP_DIR = join(DATA_DIR, 'backups');
const DAEMON_ENTRY = join(ROOT_DIR, 'server', 'daemon.mjs');
const VBS_FILE = join(ROOT_DIR, 'server', 'start-daemon.vbs');
const PID_FILE = join(DATA_DIR, 'daemon.pid');
const CLIENT_CSS = join(ROOT_DIR, 'client', 'wallpaper-bridge.css');
const CLIENT_JS = join(ROOT_DIR, 'client', 'wallpaper-bridge.js');
const CLIENT_EFFORT_SLIDER_JS = join(ROOT_DIR, 'client', 'effort-slider.js');

const CHUANBAN_REPO_URL = 'https://github.com/Anarcadia/chuanban-antigravity-theme-patch.git';
const CHUANBAN_DIR = join(homedir(), '.gemini', 'antigravity', 'theme-patch');
const CHUANBAN_MANIFEST = join(CHUANBAN_DIR, 'core', 'manifest.json');
const CHUANBAN_INSTALLER = join(CHUANBAN_DIR, 'install.mjs');
const CHUANBAN_USER_DIR = join(CHUANBAN_DIR, 'user');
const CHUANBAN_CSS = join(CHUANBAN_USER_DIR, 'custom.css');
const CHUANBAN_JS = join(CHUANBAN_USER_DIR, 'custom.js');
const CHUANBAN_CFG = join(CHUANBAN_USER_DIR, 'config.json');

const PLUGIN_NAME = 'agy-wallpaper-engine';
const PLUGIN_DEST_DIR = join(homedir(), '.gemini', 'config', 'plugins', PLUGIN_NAME);

const TASK_NAME = 'AntigravityWallpaperDaemon';
const MAC_PLIST_LABEL = 'com.antigravity.wallpaper';
const LINUX_SERVICE_NAME = 'antigravity-wallpaper.service';

const PORT = Number(process.env.AGY_WE_PORT || 48791);
const BASE_URL = `http://127.0.0.1:${PORT}`;

const args = process.argv.slice(2);
const hasFlag = (flag) => args.includes(flag);
function getFlagValue(flag, fallback = null) {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length && !args[idx + 1].startsWith('--')) {
    return args[idx + 1];
  }
  return fallback;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isPidAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readDaemonPid() {
  if (!existsSync(PID_FILE)) return null;
  try {
    const first = readFileSync(PID_FILE, 'utf8').split(/\r?\n/)[0].trim();
    const pid = Number(first);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function fetchHealth() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`${BASE_URL}/api/health`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function ensureNpmDependencies() {
  const engineBundle = join(ROOT_DIR, 'node_modules', 'webwallgl', 'webwallgl.global.min.js');
  if (existsSync(engineBundle)) return 'cached';
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const res = spawnSync(npmCmd, ['install', '--no-audit', '--no-fund'], {
    cwd: ROOT_DIR,
    stdio: 'inherit',
    windowsHide: true,
    shell: process.platform === 'win32',
  });
  if (res.status !== 0 || !existsSync(engineBundle)) {
    throw new Error('安装 webwallgl 依赖失败，请检查网络连接与 Node/npm 环境。');
  }
  return 'installed';
}

function ensureChuanbanInstalled() {
  if (hasFlag('--skip-chuanban')) {
    if (!existsSync(CHUANBAN_DIR)) {
      throw new Error(`指定了 --skip-chuanban，但未检测到船板补丁目录: ${CHUANBAN_DIR}`);
    }
    return 'skipped';
  }
  const needInstall = !existsSync(CHUANBAN_MANIFEST) || hasFlag('--update-chuanban');
  if (!needInstall) return 'already-installed';

  const stageDir = join(tmpdir(), `chuanban-stage-${Date.now()}`);
  try {
    const cloneRes = spawnSync('git', ['clone', '--depth', '1', CHUANBAN_REPO_URL, stageDir], {
      stdio: 'inherit',
      windowsHide: true,
    });
    if (cloneRes.status !== 0) {
      throw new Error(`自动克隆船板补丁失败，请检查 Git 与网络连接 (${CHUANBAN_REPO_URL})`);
    }
    const installArgs = [join(stageDir, 'install.mjs'), 'install'];
    const preset = getFlagValue('--preset');
    const darkPreset = getFlagValue('--dark-preset');
    if (preset) installArgs.push('--preset', preset);
    if (darkPreset) installArgs.push('--dark-preset', darkPreset);

    const runRes = spawnSync(process.execPath, installArgs, {
      cwd: stageDir,
      stdio: 'inherit',
      windowsHide: true,
    });
    if (runRes.status !== 0) {
      throw new Error('自动部署船板主题补丁失败，请检查其运行输出。');
    }
    return hasFlag('--update-chuanban') ? 'updated' : 'installed';
  } finally {
    try {
      if (existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
}

function backupChuanbanUser() {
  if (!existsSync(CHUANBAN_USER_DIR)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = join(BACKUP_DIR, stamp);
  mkdirSync(dest, { recursive: true });
  for (const name of ['custom.css', 'custom.js', 'config.json']) {
    const src = join(CHUANBAN_USER_DIR, name);
    if (existsSync(src)) copyFileSync(src, join(dest, name));
  }
  return dest;
}

function syncUiToChuanban() {
  if (!existsSync(CHUANBAN_DIR)) {
    throw new Error(`未检测到船板主题补丁安装目录: ${CHUANBAN_DIR}`);
  }
  mkdirSync(CHUANBAN_USER_DIR, { recursive: true });

  let cfg = {};
  if (existsSync(CHUANBAN_CFG)) {
    try {
      cfg = JSON.parse(readFileSync(CHUANBAN_CFG, 'utf8'));
    } catch {
      cfg = {};
    }
  }
  cfg.modules = { ...(cfg.modules || {}), customCss: true, customJs: true };
  writeFileSync(CHUANBAN_CFG, JSON.stringify(cfg, null, 2), 'utf8');

  writeFileSync(CHUANBAN_CSS, readFileSync(CLIENT_CSS, 'utf8'), 'utf8');
  const bridgeJs = readFileSync(CLIENT_JS, 'utf8');
  if (existsSync(CLIENT_EFFORT_SLIDER_JS)) {
    const effortJs = readFileSync(CLIENT_EFFORT_SLIDER_JS, 'utf8');
    // 禁用插件自身自动启动，交由 wallpaper-bridge.js 通过受控开关与 ctx.onCleanup 统一管理生命周期
    const combinedJs =
      `if (!(window.location && String(window.location.protocol || '').startsWith('plugin:'))) { window.__agCodexEffortSliderDisableAutoBoot = true;\n` +
      `${effortJs}\n}\n` +
      `${bridgeJs}`;
    writeFileSync(CHUANBAN_JS, combinedJs, 'utf8');
  } else {
    writeFileSync(CHUANBAN_JS, bridgeJs, 'utf8');
  }
}

function installNativePluginFiles() {
  const srcManifest = join(ROOT_DIR, 'plugin.json');
  const srcLogo = join(ROOT_DIR, 'assets', 'logo.svg');
  const srcReadme = join(ROOT_DIR, 'README.md');
  const srcSkill = join(ROOT_DIR, 'skills', PLUGIN_NAME, 'SKILL.md');
  if (!existsSync(srcManifest) || !existsSync(srcSkill)) return false;

  mkdirSync(join(PLUGIN_DEST_DIR, 'assets'), { recursive: true });
  mkdirSync(join(PLUGIN_DEST_DIR, 'skills', PLUGIN_NAME), { recursive: true });

  copyFileSync(srcManifest, join(PLUGIN_DEST_DIR, 'plugin.json'));
  if (existsSync(srcLogo)) copyFileSync(srcLogo, join(PLUGIN_DEST_DIR, 'assets', 'logo.svg'));
  if (existsSync(srcReadme)) copyFileSync(srcReadme, join(PLUGIN_DEST_DIR, 'README.md'));
  copyFileSync(srcSkill, join(PLUGIN_DEST_DIR, 'skills', PLUGIN_NAME, 'SKILL.md'));
  writeFileSync(join(PLUGIN_DEST_DIR, '.install-root'), ROOT_DIR, 'utf8');
  return true;
}

function writeVbsLauncher() {
  const nodeExe = process.execPath;
  const cmd = `""${nodeExe}"" ""${DAEMON_ENTRY}""`;
  const vbs = `\uFEFFSet WshShell = CreateObject("WScript.Shell")\r\nWshShell.Run "${cmd}", 0, False\r\n`;
  writeFileSync(VBS_FILE, vbs, 'utf16le');
}

function xmlEsc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function registerAutostartService() {
  if (process.platform === 'win32') {
    writeVbsLauncher();

    let userAuthor = (process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\` : '') + (process.env.USERNAME || userInfo().username);
    let userSid = '';
    try {
      const whoRes = spawnSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
      if (whoRes.status === 0) {
        const m = String(whoRes.stdout || '').trim().match(/^"([^"]+)","(S-1-[^"]+)"/);
        if (m) {
          userAuthor = m[1];
          userSid = m[2];
        }
      }
    } catch {}

    const principalId = userSid || userAuthor;
    const sddl = `D:(A;;FA;;;BA)(A;;FA;;;SY)(A;;FA;;;IU)${userSid ? `(A;;FA;;;${userSid})` : ''}S:(ML;;NW;;;ME)`;
    const taskXml = [
      '\uFEFF<?xml version="1.0" encoding="UTF-16"?>',
      '<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
      '  <RegistrationInfo>',
      `    <Author>${xmlEsc(userAuthor)}</Author>`,
      `    <URI>\\${TASK_NAME}</URI>`,
      `    <SecurityDescriptor>${xmlEsc(sddl)}</SecurityDescriptor>`,
      '  </RegistrationInfo>',
      '  <Principals>',
      '    <Principal id="Author">',
      `      <UserId>${xmlEsc(principalId)}</UserId>`,
      '      <LogonType>InteractiveToken</LogonType>',
      '      <RunLevel>LeastPrivilege</RunLevel>',
      '    </Principal>',
      '  </Principals>',
      '  <Settings>',
      '    <MultipleInstancesPolicy>Parallel</MultipleInstancesPolicy>',
      '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
      '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
      '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
      '    <Enabled>true</Enabled>',
      '    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>',
      '  </Settings>',
      '  <Triggers>',
      '    <LogonTrigger>',
      '      <Enabled>true</Enabled>',
      `      <UserId>${xmlEsc(principalId)}</UserId>`,
      '      <Repetition>',
      '        <Interval>PT5M</Interval>',
      '        <StopAtDurationEnd>false</StopAtDurationEnd>',
      '      </Repetition>',
      '    </LogonTrigger>',
      '  </Triggers>',
      '  <Actions Context="Author">',
      '    <Exec>',
      '      <Command>wscript.exe</Command>',
      `      <Arguments>//B //NoLogo &quot;${xmlEsc(VBS_FILE)}&quot;</Arguments>`,
      '    </Exec>',
      '  </Actions>',
      '</Task>',
      '',
    ].join('\r\n');

    const tmpXml = join(tmpdir(), `ag-we-task-${process.pid}.xml`);
    try {
      writeFileSync(tmpXml, taskXml, 'utf16le');
      const createRes = spawnSync('schtasks', ['/Create', '/TN', TASK_NAME, '/XML', tmpXml, '/F'], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 6000,
      });
      if (createRes.status === 0) return 'schtasks';
    } catch {
    } finally {
      try { if (existsSync(tmpXml)) unlinkSync(tmpXml); } catch {}
    }

    try {
      execFileSync('reg', [
        'add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
        '/v', TASK_NAME, '/t', 'REG_SZ', '/d', `wscript.exe //B //NoLogo "${VBS_FILE}"`, '/f',
      ], { windowsHide: true, stdio: 'pipe' });
      return 'hkcu-run';
    } catch {
      return null;
    }
  }

  if (process.platform === 'darwin') {
    const launchDir = join(homedir(), 'Library', 'LaunchAgents');
    mkdirSync(launchDir, { recursive: true });
    const plistPath = join(launchDir, `${MAC_PLIST_LABEL}.plist`);
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${MAC_PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEsc(process.execPath)}</string>
    <string>${xmlEsc(DAEMON_ENTRY)}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/ag-wallpaper.log</string>
  <key>StandardErrorPath</key><string>/tmp/ag-wallpaper.err</string>
</dict>
</plist>
`;
    writeFileSync(plistPath, plist, 'utf8');
    spawnSync('launchctl', ['unload', plistPath], { stdio: 'ignore' });
    spawnSync('launchctl', ['load', plistPath], { stdio: 'ignore' });
    return 'launchd';
  }

  // Linux systemd --user
  const unitDir = join(homedir(), '.config', 'systemd', 'user');
  mkdirSync(unitDir, { recursive: true });
  const unitPath = join(unitDir, LINUX_SERVICE_NAME);
  const unit = `[Unit]
Description=Antigravity Wallpaper Engine Daemon
After=default.target

[Service]
ExecStart="${process.execPath}" "${DAEMON_ENTRY}"
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`;
  writeFileSync(unitPath, unit, 'utf8');
  spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
  spawnSync('systemctl', ['--user', 'enable', '--now', LINUX_SERVICE_NAME], { stdio: 'ignore' });
  return 'systemd';
}

function removeAutostartService() {
  if (process.platform === 'win32') {
    try {
      execFileSync('schtasks', ['/Delete', '/TN', TASK_NAME, '/F'], { windowsHide: true, stdio: 'pipe' });
    } catch {}
    try {
      execFileSync('reg', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', TASK_NAME, '/f'], {
        windowsHide: true,
        stdio: 'pipe',
      });
    } catch {}
    return;
  }
  if (process.platform === 'darwin') {
    const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${MAC_PLIST_LABEL}.plist`);
    if (existsSync(plistPath)) {
      spawnSync('launchctl', ['unload', plistPath], { stdio: 'ignore' });
      try { unlinkSync(plistPath); } catch {}
    }
    return;
  }
  spawnSync('systemctl', ['--user', 'disable', '--now', LINUX_SERVICE_NAME], { stdio: 'ignore' });
  const unitPath = join(homedir(), '.config', 'systemd', 'user', LINUX_SERVICE_NAME);
  try { if (existsSync(unitPath)) unlinkSync(unitPath); } catch {}
}

async function stopDaemon() {
  const health = await fetchHealth();
  const pid = health?.pid || readDaemonPid();
  if (pid && isPidAlive(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch { /* ignore */ }
    for (let i = 0; i < 15; i++) {
      await sleep(150);
      if (!isPidAlive(pid)) break;
    }
    if (isPidAlive(pid) && process.platform === 'win32') {
      try {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'pipe' });
      } catch { /* ignore */ }
    }
  }
  try {
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  } catch { /* ignore */ }
}

async function startDaemon() {
  const existing = await fetchHealth();
  if (existing?.ok) return existing;

  let startedViaTask = false;
  if (process.platform === 'win32') {
    try {
      const runRes = spawnSync('schtasks', ['/Run', '/TN', TASK_NAME], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 5000,
      });
      if (runRes.status === 0) startedViaTask = true;
    } catch {}
  }

  if (!startedViaTask) {
    const child = spawn(process.execPath, [DAEMON_ENTRY], {
      cwd: ROOT_DIR,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  }

  for (let i = 0; i < 30; i++) {
    await sleep(250);
    const h = await fetchHealth();
    if (h?.ok) return h;
  }
  throw new Error('壁纸守护进程启动超时，请查看 data/daemon.log');
}

async function main() {
  const cmd = (args.find((a) => !a.startsWith('--')) || 'status').toLowerCase();
  mkdirSync(DATA_DIR, { recursive: true });

  if (cmd === 'install') {
    const npmStatus = ensureNpmDependencies();
    const chuanbanStatus = ensureChuanbanInstalled();
    const backupPath = backupChuanbanUser();
    syncUiToChuanban();
    const pluginInstalled = installNativePluginFiles();
    const autostartMethod = registerAutostartService();
    await stopDaemon();
    const health = await startDaemon();
    console.log(JSON.stringify({
      ok: true,
      action: 'install',
      npmStatus,
      chuanbanStatus,
      backupPath,
      chuanbanSynced: true,
      pluginInstalled,
      pluginDir: PLUGIN_DEST_DIR,
      autostartMethod,
      scheduledTask: autostartMethod === 'schtasks' ? TASK_NAME : autostartMethod,
      health,
    }, null, 2));
    return;
  }

  if (cmd === 'sync-ui') {
    syncUiToChuanban();
    const pluginInstalled = installNativePluginFiles();
    console.log(JSON.stringify({ ok: true, action: 'sync-ui', css: CHUANBAN_CSS, js: CHUANBAN_JS, pluginInstalled }, null, 2));
    return;
  }

  if (cmd === 'start') {
    const health = await startDaemon();
    console.log(JSON.stringify({ ok: true, action: 'start', health }, null, 2));
    return;
  }

  if (cmd === 'stop') {
    await stopDaemon();
    console.log(JSON.stringify({ ok: true, action: 'stop' }, null, 2));
    return;
  }

  if (cmd === 'status' || cmd === 'doctor') {
    const health = await fetchHealth();
    let taskStatus = null;
    if (process.platform === 'win32') {
      try {
        const out = execFileSync('schtasks', ['/Query', '/TN', TASK_NAME, '/FO', 'LIST'], {
          windowsHide: true,
          encoding: 'utf8',
        });
        taskStatus = out.includes(TASK_NAME) ? 'registered' : 'missing';
      } catch {
        taskStatus = 'missing';
      }
    }
    console.log(JSON.stringify({
      ok: Boolean(health?.ok),
      action: cmd,
      baseUrl: BASE_URL,
      scheduledTask: taskStatus,
      chuanbanInstalled: existsSync(CHUANBAN_MANIFEST),
      pluginInstalled: existsSync(join(PLUGIN_DEST_DIR, 'plugin.json')),
      health,
    }, null, 2));
    return;
  }

  if (cmd === 'uninstall') {
    await stopDaemon();
    removeAutostartService();
    try { if (existsSync(VBS_FILE)) unlinkSync(VBS_FILE); } catch {}
    if (existsSync(CHUANBAN_USER_DIR)) {
      writeFileSync(CHUANBAN_CSS, '/* 已卸载动态壁纸扩展 */\n', 'utf8');
      writeFileSync(CHUANBAN_JS, '/* 已卸载动态壁纸扩展 */\n', 'utf8');
    }
    try {
      if (existsSync(PLUGIN_DEST_DIR)) rmSync(PLUGIN_DEST_DIR, { recursive: true, force: true });
    } catch {}
    let chuanbanUninstalled = false;
    if (hasFlag('--full') && existsSync(CHUANBAN_INSTALLER)) {
      const r = spawnSync(process.execPath, [CHUANBAN_INSTALLER, 'uninstall'], { stdio: 'inherit', windowsHide: true });
      chuanbanUninstalled = r.status === 0;
    }
    console.log(JSON.stringify({
      ok: true,
      action: 'uninstall',
      chuanbanRestored: existsSync(CHUANBAN_USER_DIR),
      chuanbanUninstalled,
    }, null, 2));
    return;
  }

  console.error(`未知命令: ${cmd}，支持: install | sync-ui | start | stop | status | doctor | uninstall`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});
