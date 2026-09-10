# 后端核心逻辑（src-tauri）

本文件描述 `src-tauri/` 下 Rust 侧的核心实现，作为阅读 `lib.rs` / `db.rs` 的导航。内容描述代码现状，不含历史改动叙事。

---

## 1. 穿透模式（重点）

### 设计：Rust 为唯一真相源

穿透状态由 Rust 托管（`PassthroughState`，内部 `AtomicBool`），托盘菜单与挂件右键菜单**统一经由同一个切换入口** `do_toggle_passthrough`，不存在第二条旁路。

### 完整实现链路

```
托盘菜单 "toggle_passthrough" ────────┐
挂件右键 invoke("toggle_passthrough") ├─→ toggle_passthrough ──→ do_toggle_passthrough
解锁按钮 invoke("toggle_passthrough") ┘                          ──→ apply_transparent + set_input_enabled
```

`do_toggle_passthrough(app, tray_item)` 顺序执行：

1. **取主窗口 HWND**：**按 label `"main"` 取窗口**，再经 `main_hwnd` 取句柄；取不到时只翻转状态、广播事件，跳过样式操作。

   > 目标窗口必须在函数内部解析，**不能接收调用方注入的 `WebviewWindow`**。注入的是「发起 invoke 的窗口」，锁窗口调用时就会把样式打在锁自己身上，主窗口的穿透位永远不被清除（表现为解锁后点击仍穿透）。
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
- 穿透开启时前端执行 `showOnly()` + `setMode("hidden")`，挂件呈半掩静态展示并强制 idle 图渲染（见 `src/LOGIC.md`）。

### 命令与权限

- command `toggle_passthrough(app, tray_ref)`：`tray_ref` 为自动注入的 `State<TrayPassthroughRef>`。
- 权限：`permissions/commands.toml` 定义 `allow-toggle-passthrough`，`capabilities/default.json` 引用。
- 注意：Tauri v2 默认以 Rust 函数名（snake_case）注册命令，前端 `invoke` 与 `permissions` 的 allow 项必须一致。
- 权限文件改动后必须重新编译才生效：ACL 由 `tauri-build` 在编译期生成（默认扫描 `./capabilities/**/*` 与 `./permissions/**/*`）。`tauri-build` 自身会 emit `rerun-if-changed=capabilities` 与 `rerun-if-changed=permissions`，故这两个目录变化时 build script 会重跑。若改用 `AppSettings::capabilities_path_pattern` / `permissions_path_pattern` 自定义路径，则需自行 emit 对应的 `rerun-if-changed`，否则会出现「新命令编译进了 exe、ACL 却是旧版本，invoke 被静默拒绝」。

---

## 2. 穿透解锁锁（widget-lock 窗口）

主窗口穿透时对系统整体穿透，其内部任何 DOM 都收不到鼠标事件，因此「点击解锁」必须由**自身不穿透的独立窗口**承载。

### 窗口属性

`ensure_lock_window()` 创建（setup 阶段预创建并常驻隐藏）：

| 属性 | 值 | 原因 |
| --- | --- | --- |
| label | `widget-lock` | 前端 `main.tsx` 按 label 分流渲染 `LockView` |
| URL | `index.html` | 不附加 query：`WebviewUrl::App(PathBuf)` 不支持 query string，`?` 会被编码破坏 |
| 尺寸 | 40×40 | 与 CSS 的 `.lock-btn` 一致 |
| `skip_taskbar` + `WS_EX_TOOLWINDOW` | — | 不出现在任务栏与 Alt-Tab |
| `WS_EX_NOACTIVATE` | — | 点击不激活，焦点不离开当前应用 |
| `always_on_top` | — | 保证浮在其他窗口之上 |

### hover 检测

检测**完全在 Rust 完成**，不依赖前端事件：

- 穿透时主窗口被 `EnableWindow(hwnd, FALSE)` 禁用，其 webview 内的 JS 不保证继续推进，前端无法可靠判断鼠标位置。
- `MouseWatcher` 每 100ms 轮询时，若处于穿透态则调用 `update_lock_hover(app, x, y)`。
- 坐标均为物理像素：`GetWindowRect` 取主窗口矩形，`GetCursorPos` 取光标，可直接比较，无需 dpr 换算。

```
热区 = 主窗口矩形 ∪ 锁矩形
  在内 → 显示锁（先 set_position 后 show，避免闪现在旧位置）
  离开 → 累计时长超过 hide_delay_ms 后隐藏
```

锁位于挂件内侧：主窗口 `left <= 2` 视为贴左，锁放在其右侧，否则放左侧，垂直居中。

### 状态

托管 `LockState`：`visible`（是否显示中）、`left_at`（离开热区的时刻）、`hide_delay_ms`（自动隐藏延时）。

- `hide_delay_ms` 默认 600，由前端 `invoke("set_lock_hide_delay")` 在配置加载与设置变更时同步为 `autoCloseDelay`。
- `do_toggle_passthrough` 关闭穿透时统一调用 `hide_lock_now()` 并重置状态，不依赖前端。

### 命令

`show_lock_window` / `hide_lock_window` / `set_lock_hide_delay`，权限定义于 `permissions/commands.toml`。

---

## 3. 鼠标轮询（MouseWatcher）

- `MouseWatcher`：托管状态（`app.manage`），内含 `AtomicBool running`，`start()` 幂等（重复调用为 no-op）。
- 后台线程每 100ms 调 `GetCursorPos`（物理像素）：
  - 处于穿透态时先执行 `update_lock_hover`（见第 2 节）；
  - 随后 `app.emit("cursor-move", {x, y})` 广播。
- 非 Windows 平台 `current_cursor()` 返回 `None`。
- 命令 `start_mouse_watch(app, watcher)` 供前端启动轮询。

前端 `ProximitySensor` 订阅该事件并把物理像素按 `devicePixelRatio` 换算为逻辑像素，由 App 依据当前 UI 真实 bounds 判定接近/离开。

---

## 4. 系统托盘

setup 阶段构建，菜单项：

| ID | 行为 |
| --- | --- |
| `show` | `emit("show-widget")` |
| `hide` | `emit("hide-widget")` |
| `toggle_passthrough` | `CheckMenuItem`，调 `do_toggle_passthrough` |
| `quit` | `do_quit_app` |

- 托盘穿透项初始 `set_checked(false)`，并托管进 `TrayPassthroughRef`。
- 主窗口未就绪时 `do_toggle_passthrough` 退化为仅翻转状态 + 广播 + 同步勾选，待窗口就绪后由下一次切换补全样式；该分支由函数内部统一处理，调用方不再各自实现。

### 退出（do_quit_app）

托盘 `quit`、挂件右键「退出」、命令 `quit_app` 共用 `do_quit_app`。

退出的收尾流程：

1. **`app.emit("before-quit")`**：前端监听后执行 `scheduleSave(true)`，把防抖中的文本/待办编辑立即落库（结构性变更本就是立即保存，这里补的是防抖项）。
2. **延时 `QUIT_FLUSH_MS`（250ms）后 `app.exit(0)`**：兜底强制退出。

> 延时是固定的，不等待前端响应：穿透态下主窗口被 `EnableWindow(FALSE)` 禁用，其 webview 内的 JS 不保证推进，前端可能收不到 `before-quit`。250ms 对本地 SQLite 写入有充足余量。

> 退出必须走 `do_quit_app`。若前端自行 `getCurrentWindow().close()`，一是与托盘行为不一致（关窗口而非退应用），二是依赖 `core:window:allow-close` 权限——该权限不在 `core:window:default` 内，缺省时 invoke 会被静默拒绝。

**多入口功能必须收敛到单一实现**（详见开发思维规则）。本项目有三个入口共用同一函数的例子：穿透切换、退出、锁窗口显隐。

---

## 5. 数据库（db.rs）

- `init_db(app)`：setup 阶段建库建表，失败即 panic（存储不可用就快速失败）。
- 表：
  - `notes`：旧版单文档遗留表（单行 `id = 1`，存 note 正文与 todos JSON）。仅用于迁移，新版本不再读写。
  - `tabs`：速记标签页（title / content / position）。
  - `categories`：待办分类（title / todos JSON / position）。
  - `meta`：键值对，存激活项 id 与迁移标记。
  - `usage_sessions`：应用使用统计（day / app / start_ms / end_ms，按 day 建索引）。启动时清理 30 天前的数据——面板只展示当天，历史留着只会让库无谓变大。
- 一次性迁移（以 `meta` 中 `migrated_notes` / `migrated_categories` 标记防重复）：
  - `migrated_notes`：首次启动且 `tabs` 为空时，把 `notes` 单行正文迁入第一个标签页「速记」。
  - `migrated_categories`：首次启动且 `categories` 为空时，把 `notes` 单行残留的 todos 迁入默认分类「主要」。
- 命令：`load_tabs` / `save_tabs`（覆盖式全量写回）、`set_active_tab`、`load_categories` / `save_categories`（覆盖式）、`set_active_category`。
- `save_tabs` 与 `save_categories` 共用 `replace_all` helper：同一事务内先 `DELETE` 整表、再按 `position` 重新 `INSERT`；空列表直接跳过（防止误清空）。
- 前端通过 `src/lib/db.ts` 的 invoke 封装访问，`todos` 字段在 Rust 侧以 JSON 字符串存、前端解析为数组。

---

## 6. 皮肤发现（list_skins）

- 读取 `resource_dir()` 下的 `skin/` 目录，返回文件夹名列表（跳过 `.` 开头的隐藏目录，排序后返回）。
- dev 与 prod 下 `resource_dir` 层级不同，枚举多个候选路径，取第一个真实存在的目录。
- 前端 `loadSkins()` 据此探测图片文件判定模式（见 `src/LOGIC.md`）。

---

## 7. 应用使用统计（usage.rs）

每 10 秒采样一次前台应用，把「连续使用某个应用」记成一条会话写进 `usage_sessions`。

- **会话边界**：只有前台切换、跨天、空闲（>60s 无键鼠输入）或关闭功能时才结束会话；其余时候只 `UPDATE` 结束时间续期——进程被强杀也只丢一个轮询间隔。
- **跨天**：旧会话属于昨天时，结束时间按昨天最后一毫秒算（`day_start - 1`），不能写成「现在」，否则会把今天开头的几分钟记到昨天头上。
- **排除自身**：浮笺只是贴在别人上面的便签，`own_process()` 比对 `current_exe()` 的文件名后把自己排除在统计外。
- **空闲**：`foreground::idle_ms()` 读 `GetLastInputInfo`。人走开时前台应用不会变，只看前台窗口会把离席时间算成使用时间。
- **时间基准**：本地日期由 SQLite 的 `date('now','localtime')` 提供（`db::local_clock()`），不自己处理时区与夏令时。
- **前台读取**：`foreground.rs` 统一提供进程名 / 标题 / 空闲时长，全屏检测（`tracker.rs`）与使用统计共用一份实现，避免两套 Win32 调用各自漂移。
- **系统覆盖层**：Alt+Tab 切换器这类系统 UI 视为「没有在用任何应用」，切换期间不计入任何应用（见第 8 节）。
- **系统睡眠**：合盖 / 休眠时本线程被挂起，`GetTickCount` 与「最后输入时间」**一起冻结**，空闲判定失效——醒来后会把整段睡眠算成使用时间。改用墙上时钟识别：两次轮询的间隔超过 `SLEEP_GAP_MS`（60s，远大于 10s 轮询）即判定睡过，会话停在上一次轮询，睡眠时长不计入任何应用。锁屏（不睡眠）不受影响，那时 tick 照常推进、空闲判定正常生效。
- **日界**：一天以**凌晨 4 点**为界（`db::local_clock()`），熬夜到 3 点仍算前一天；起点 = 当前时刻减 4 小时后取当日零点再加 4 小时，无需分支判断。
- **短间隔合并**：`A → B（≤20s）→ A` 视为一直在用 A——命中时删掉中间那条记录、把前一段的结束时间续到现在（`db::merge_short_gap`）。误触或焦点被弹窗/UAC 短暂抢走不该在时间线上留下痕迹。跨天的旧会话不参与合并（它属于昨天，接不上今天的区间）。
- **与全屏检测的关系**：两者是**各自独立的轮询线程**（统计 10 秒、全屏 2 秒），只共用 `foreground.rs` 的窗口读取函数，不共用循环。节奏不同、开关也能独立启停，合并成一个循环会把两件事耦死。
  > 轮询间隔同时是「会话的最小可分辨时长」：合并阈值必须大于它，否则夹在中间的会话永远达不到判定长度（现在 20s > 10s）。
- 命令：`set_usage_tracking`（开关采样）、`load_usage`（当天的会话区间 + 各应用总时长）。

---

## 8. 系统覆盖层排除（is_shell_overlay）

Alt+Tab 切换器、任务视图、开始菜单这类系统 UI 由 explorer 提供，**无边框且铺满显示器**，
在几何上与「全屏应用」无法区分：一按 Alt+Tab 就会被判成进入全屏、自动开穿透。

`foreground::is_shell_overlay(hwnd)` 做两级判定，全屏检测与使用统计共用：

1. **类名**（`GetClassNameW`）：类名由系统定义、**不随显示语言变化**，比窗口标题稳定
   ——标题在中文系统上是「工作切换」、英文是「Task switching」，靠标题排除换个语言就失效。
   命中名单见 `SHELL_OVERLAY_CLASSES`；另有 `Shell_` 前缀一律视为外壳 UI。
2. **兜底**：不同 Windows 版本的切换器类名会变（实测 Win11 为 `XamlExplorerHostIslandWindow`，
   Win10 为 `TaskSwitcherWnd`，任务视图为 `MultitaskingViewFrame`），但都归 explorer；
   而资源管理器窗口一定带标题栏——所以「explorer 出的无边框铺满窗口」只可能是系统 UI。
   实测中平板模式遮罩 `TabletModeCoverWindow` 正是靠这条拦下的。

两个使用点：

- **全屏检测**：排除只作用于几何层。d3d 层是系统级判定（`SHQueryUserNotificationState`），
  独占全屏的真游戏不受影响。
- **使用统计**：覆盖层期间返回「无前台应用」，会话暂停，切换的那段时间不计入任何应用。
