# 后端核心逻辑（src-tauri）

本文件描述 `src-tauri/` 下 Rust 侧的核心实现，作为阅读 `lib.rs` / `db.rs` 的导航。内容描述代码现状，不含历史改动叙事。

---

## 1. 穿透模式（重点）

### 设计：Rust 为唯一真相源

穿透状态由 Rust 托管（`PassthroughState`，内部 `AtomicBool`），托盘菜单与挂件右键菜单**统一经由同一个切换入口** `do_toggle_passthrough`，不存在第二条旁路。

### 完整实现链路

```
托盘菜单 "toggle_passthrough" ────────┐
                                      ├─→ do_toggle_passthrough ──→ apply_transparent + set_input_enabled
前端 invoke("toggle_passthrough") ────┘    （挂件右键菜单项，复用同一函数）
```

`do_toggle_passthrough(app, window: Option<&WebviewWindow>, tray_item)` 顺序执行：

1. **取主窗口 HWND**（`main_hwnd`）：`window` 为 `None`（窗口未就绪）或取句柄失败时，只翻转状态、广播事件，跳过样式操作。
2. **翻转状态并计算目标值** `next = !当前值`。
3. **`apply_transparent`**：设置/清除窗口扩展样式位，`SetWindowPos(SWP_FRAMECHANGED)` 强制系统重算。
4. **`set_input_enabled`**：穿透时 `EnableWindow(hwnd, FALSE)`，退出时 `TRUE`。
5. **`PassthroughState::write_current`**：写入唯一真相源。
6. **`app.emit("passthrough-state", new_on)`**：广播给前端同步显示。
7. **同步托盘勾选**：`tray_item.set_checked(new_on)`。

### Win32 样式位（apply_transparent）

```rust
let bits = (WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_LAYERED).0 as isize;
```

| 样式 | 作用 |
| --- | --- |
| `WS_EX_TRANSPARENT` | 命中测试穿透，点击落到下方窗口（后方内容可交互） |
| `WS_EX_NOACTIVATE` | 点击不激活本窗口，焦点不会切到应用 |
| `WS_EX_LAYERED` | 分层窗口，保证 TRANSPARENT 命中穿透稳定生效 |

切换后 `SetWindowPos(HWND_TOP, 0,0,0,0, SWP_NOMOVE|SWP_NOSIZE|SWP_FRAMECHANGED)` 强制系统立即应用/移除样式位。

### EnableWindow 的作用（set_input_enabled）

仅靠样式位，窗口在部分场景仍可能收到点击/抢焦点。`EnableWindow(hwnd, FALSE)` 让窗口连同其 webview 子窗口**完全不接收任何鼠标/键盘输入**，也不成为激活窗口，点击直接落到 z-order 下方——窗口只保留视觉效果。退出穿透时恢复 `TRUE`。

- 函数位于 `windows::Win32::UI::Input::KeyboardAndMouse::EnableWindow`，需在 `Cargo.toml` 的 windows 依赖启用 `Win32_UI_Input_KeyboardAndMouse` feature。
- 返回值为 `must_use`，调用处加 `let _ =`。

### 托盘勾选项同步（TrayPassthroughRef）

```rust
pub struct TrayPassthroughRef(pub Mutex<Option<CheckMenuItem<tauri::Wry>>>);
```

setup 阶段把托盘穿透菜单项 clone 存入该托管引用；切换命令 / 事件处理器从引用取回并 `set_checked`，保证托盘勾选与真实状态同步。

> 泛型必须是 `CheckMenuItem<tauri::Wry>`（Tauri v2 的菜单类型），不是 `AppHandle`。

### 前端配合

- 前端 `setPassthrough(on)` 只调 `invoke("toggle_passthrough")`，不做本地状态翻转。
- 显示状态完全由 `listen<boolean>("passthrough-state")` 广播驱动，消除双路径状态竞态。
- 穿透开启时前端执行 `showOnly()` + `setMode("hidden")`，挂件保持屏幕内并强制 idle 渲染（见 `src/LOGIC.md`）。

### 命令与权限

- command `toggle_passthrough(app, window, tray_ref)`：参数自动注入 `State<TrayPassthroughRef>`。
- 权限：`permissions/commands.toml` 定义 `allow-toggle-passthrough`，`capabilities/default.json` 引用。
- 注意：Tauri v2 默认以 Rust 函数名（snake_case）注册命令，前端 `invoke` 与 `permissions` 的 allow 项必须一致。

---

## 2. 鼠标轮询（MouseWatcher）

- `MouseWatcher`：托管状态（`app.manage`），内含 `AtomicBool running`，`start()` 幂等（重复调用为 no-op）。
- 后台线程每 100ms 调 `GetCursorPos`（物理像素），`app.emit("cursor-move", {x, y})` 广播。
- 非 Windows 平台 `current_cursor()` 返回 `None`。
- 命令 `start_mouse_watch(app, watcher)` 供前端启动轮询。

前端 `ProximitySensor` 订阅该事件并把物理像素按 `devicePixelRatio` 换算为逻辑像素，由 App 依据当前 UI 真实 bounds 判定接近/离开。

---

## 3. 系统托盘

setup 阶段构建，菜单项：

| ID | 行为 |
| --- | --- |
| `show` | `emit("show-widget")` |
| `hide` | `emit("hide-widget")` |
| `toggle_passthrough` | `CheckMenuItem`，调 `do_toggle_passthrough`（主窗口未就绪时传 `None`，退化为仅翻转状态） |
| `quit` | `app.exit(0)` |

- 托盘穿透项初始 `set_checked(false)`，并托管进 `TrayPassthroughRef`。
- 挂件右键菜单的穿透切换由前端 `invoke("toggle_passthrough")` 触发，command 内部复用 `do_toggle_passthrough`。
- 窗口未就绪时（`win.as_ref()` 为 `None`）`do_toggle_passthrough` 退化为仅翻转状态 + 广播 + 同步勾选，待窗口就绪后由下一次切换补全样式；该分支由函数内部统一处理，调用方不再各自实现。

---

## 4. 数据库（db.rs）

- `init_db(app)`：setup 阶段建库建表，失败即 panic（存储不可用就快速失败）。
- 表：
  - `notes`：旧版单文档遗留表（单行 `id = 1`，存 note 正文与 todos JSON）。仅用于迁移，新版本不再读写。
  - `tabs`：速记标签页（title / content / position）。
  - `categories`：待办分类（title / todos JSON / position）。
  - `meta`：键值对，存激活项 id 与迁移标记。
- 一次性迁移（以 `meta` 中 `migrated_notes` / `migrated_categories` 标记防重复）：
  - `migrated_notes`：首次启动且 `tabs` 为空时，把 `notes` 单行正文迁入第一个标签页「速记」。
  - `migrated_categories`：首次启动且 `categories` 为空时，把 `notes` 单行残留的 todos 迁入默认分类「主要」。
- 命令：`load_tabs` / `save_tabs`（覆盖式全量写回）、`set_active_tab`、`load_categories` / `save_categories`（覆盖式）、`set_active_category`。
- `save_tabs` 与 `save_categories` 共用 `replace_all` helper：同一事务内先 `DELETE` 整表、再按 `position` 重新 `INSERT`；空列表直接跳过（防止误清空）。
- 前端通过 `src/lib/db.ts` 的 invoke 封装访问，`todos` 字段在 Rust 侧以 JSON 字符串存、前端解析为数组。

---

## 5. 皮肤发现（list_skins）

- 读取 `resource_dir()` 下的 `skin/` 目录，返回文件夹名列表（跳过 `.` 开头的隐藏目录，排序后返回）。
- dev 与 prod 下 `resource_dir` 层级不同，枚举多个候选路径，取第一个真实存在的目录。
- 前端 `loadSkins()` 据此探测图片文件判定模式（见 `src/LOGIC.md`）。
