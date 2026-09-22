# Repository Guidelines

## Project Structure & Module Organization

- `app/src/` — React 18 前端（`App.jsx` 界面与交互，`styles.css` 样式）
- `app/src-tauri/` — Tauri 2 Rust 后端；`src/main.rs` 含全部 `#[tauri::command]`（SQLite 持久化、arboard 剪贴板）
- `app/src-tauri/bridge/` — JDBC 桥接 jar（仅 `feat-execute-sql` 分支使用，主分支保留但不引用）
- `designs/` — UI 设计原型（HTML）与各版本截图
- `tools/` — 辅助脚本，如 `seed_example_data.py`（写入银行业务示例数据）
- `sql_clipboard.py` — 早期 Python/Tkinter 版本，已归档，仅供参考，勿改

运行时数据库为 exe 同目录的 `sql_clipboard.db`，勿提交。

## Build, Test, and Development Commands

``bash
cd app
npm install          # 安装依赖
npm run tauri dev    # 开发调试（热更新）
npm run tauri build  # 构建便携单文件 exe
npm run dev          # 仅前端 Vite（浏览器预览，走 MOCK 数据）
``

构建产物：`app/src-tauri/target/release/sql-clipboard.exe`。

## Coding Style & Naming Conventions

- 前端：JSX + 函数组件 + Hooks；2 空格缩进；状态用 `useState`，派生数据用 `useMemo`
- Rust：命令函数蛇形命名（`load_cells`、`insert_cell`），返回 `Result<T, String>`
- 前后端约定：单元格字段为 `{ id, row, col, display, copy }`；`copy` 为空表示「文本格」
- 日期变量仅 `$zt`（昨天）/ `$syd`（上月底），复制时替换为 `'yyyy-MM-dd'`
- ⚠️ `app/src/App.jsx` 中部分中文注释/字符串为历史遗留乱码（双重编码），编辑时保持现状，不要「顺手修复」或改编码

## Testing Guidelines

本仓库暂无自动化测试框架。验收方式为手动验证：`npm run tauri dev` 启动后逐项确认功能（复制、右键菜单、编辑模式、筛选），UI 改动需截图存档到 `designs/`（命名 `v<编号>-<特性>.png`）。

## Commit & Pull Request Guidelines

- 提交信息为中文，遵循 `type: 描述` 格式，type 用 `feat` / `fix` / `revert`
- 复杂改动在正文用 `-` 分条列要点（见 `86a35eb`、`94df45e`）
- 破坏性/大功能改动放独立分支（如 `feat-execute-sql`），主分支保持单一剪切板功能
- PR 需附：改动说明、UI 变更截图、关联 issue

## Security & Configuration Tips

- `app/src-tauri/tauri.conf.json` 控制窗口与打包配置；capabilities 文件管理权限白名单
- 勿在代码中硬编码数据库连接凭据；JDBC 连接配置由用户在界面录入并落库


## 打包约定

- 打包便携版 exe 后，把成品复制到仓库根目录的 `便携版\` 目录下，方便直接取用：
  `app\src-tauri\target\release\sql-clipboard.exe` → `便携版\sql-clipboard.exe`
