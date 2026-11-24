---
name: agy-wallpaper-engine
description: >-
  船板 Antigravity 主题补丁 × 本机 Steam Wallpaper Engine 融合插件控制技能。当用户提到“切换壁纸”、“搜索壁纸”、“调整毛玻璃/透明度/模糊度”、“暂停或开启自动轮播”、“重启或卸载动态壁纸插件”时触发。日常不触发时不产生任何 Token 开销。
---

# 船板 × Wallpaper Engine 液态玻璃主题插件操控指南

本插件由两部分协同工作（**严禁直接修改船板 `core/` 内核目录**）：
1. **本地媒体与配置守护服务**：默认监听 `http://127.0.0.1:48791`（可通过环境变量 `AGY_WE_PORT` 自定义），服务与工程位置记录在本插件目录的 `.install-root` 文件中（Windows 为 `%USERPROFILE%\.gemini\config\plugins\agy-wallpaper-engine\.install-root`，macOS/Linux 为 `~/.gemini/config/plugins/agy-wallpaper-engine/.install-root`）。
2. **前端书卷液态玻璃层**：同步至 `~/.gemini/antigravity/theme-patch/user/custom.css` 与 `custom.js`（由船板补丁每 2.5 秒自动热重载）。

## 一、常用接口速查（任意终端或脚本可直接调用）

| 目标操作 | 方法与接口地址 | 请求体 / 说明 |
| :--- | :--- | :--- |
| 检查服务与壁纸数量 | `GET http://127.0.0.1:48791/api/health` | 返回 `ok`、`pid`、`wallpaperCount`、`currentId` |
| 获取当前设置与当前壁纸 | `GET http://127.0.0.1:48791/api/state` | 返回完整 `settings` 与 `current` 对象 |
| 列出全部本机壁纸 | `GET http://127.0.0.1:48791/api/wallpapers` | 支持 `?refresh=1` 强制重扫 Steam 工坊与本地导入 |
| 切换下一张 / 随机换壁纸 | `POST http://127.0.0.1:48791/api/next` | 可选 `{ "shuffle": true }` |
| 修改任意参数 / 指定壁纸 | `POST http://127.0.0.1:48791/api/settings` | 见下方字段表，更新后前端 4 秒内自动同步 |

### 可调节 `settings` 核心字段
- `enabled` (`boolean`)：总开关（`false` 时退回纯粹船板实色界面）；
- `glassEnabled` (`boolean`)：是否启用液态毛玻璃透底；
- `currentId` (`string`)：切换为指定壁纸 ID；
- `paused` / `muted` / `volume` (`0~1`)：播放、静音与音量；
- `sceneLive` (`boolean`)：是否开启 WebWallGL 3D/粒子场景实时渲染（`false` 时自动走视频/静态预览降级）；
- `pauseOnBlur` (`boolean`)：窗口失焦自动暂停省电；
- `showQuickBtn` (`boolean`)：是否显示右上角悬浮「壁纸」快捷按钮；
- `carouselEnabled` (`boolean`) & `carouselMinutes` (`number`)：自动轮播开关与间隔分钟数；
- `mainOpacity` (`20~96`)、`sidebarOpacity` (`20~98`)、`cardOpacity` (`25~98`)、`blurPx` (`0~36`)、`scrimOpacity` (`0~75`)：书卷液态玻璃通透度与模糊度参数。

## 二、生命周期运维命令

先读取本机安装路径：
- Windows (PowerShell): `$root = Get-Content "$HOME\.gemini\config\plugins\agy-wallpaper-engine\.install-root" -Raw`
- macOS / Linux: `ROOT=$(cat ~/.gemini/config/plugins/agy-wallpaper-engine/.install-root)`

然后执行对应命令：
```bash
# 查看状态 / 诊断 / 启动守护进程
node "$ROOT/install.mjs" status
node "$ROOT/install.mjs" start

# 修改前端样式或逻辑后一键热同步到船板 user/ 层
node "$ROOT/install.mjs" sync-ui

# 卸载壁纸插件并无损退回纯净船板界面（加 --full 可连同船板补丁一并卸载）
node "$ROOT/install.mjs" uninstall
```
