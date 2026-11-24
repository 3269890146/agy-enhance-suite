# agy-wallpaper-engine 开发与架构约定

## 模块边界
- **服务端 (`server/`)**：监听本地回环 `http://127.0.0.1:48791`（可通过 `AGY_WE_PORT` 覆盖），负责 Steam / Wallpaper Engine 目录探测、`.pkg` 头部索引与切片流读取、`webwallgl` 托管以及本地上传文件管理。
- **前端扩展层 (`client/`)**：通过船板 Antigravity 主题补丁的 `user/custom.css` 与 `user/custom.js` 热重载注入（约 2.5 秒自动生效）；**严禁修改船板补丁的 `core/` 内核目录**。
- **Antigravity 原生插件**：标准插件清单位于仓库根目录（`plugin.json`、`assets/logo.svg`、`skills/agy-wallpaper-engine/SKILL.md`），运行 `node install.mjs install` 时会自动安装至 `~/.gemini/config/plugins/agy-wallpaper-engine/`，并写入 `.install-root` 指向本地工程目录。

## 开发与验证原则
1. 所有修改涉及 `.mjs` / `.js` 时需通过 `node --check` 语法检查。
2. 禁止在 Git 跟踪文件中提交任何用户目录、私人路径、`data/` 本地壁纸上传缓存或第三方凭据。
3. 修改 `client/*` 后可运行 `node install.mjs sync-ui` 将前端变更热同步至当前客户端。
