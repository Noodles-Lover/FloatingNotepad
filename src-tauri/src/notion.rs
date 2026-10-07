//! Notion 同步：把速记 / 待办 / 日程镜像到三个 Notion 数据库，供手机端查看与编辑。
//!
//! 设计要点（v1，细节待调）：
//! - **本地优先**：本地 SQLite 是正常工作路径，同步失败不影响本机使用。
//! - **变更检测用签名比对**：映射表 `db::notion_sync` 记住上次同步时两边的内容签名，
//!   因此不必给三条业务表加时间戳，也不用改既有的写入路径。
//! - **删除检测用差集**：本地没了 → 归档 Notion 页面；Notion 没了 → 本地删除；
//!   Notion 上「本地ID」为空的页面 → 视为手机端新建，回写本地并把 ID 写回该页。
//! - **冲突**：两边都改过且内容不同时，v1 以本地为准（桌面是主力编辑器），并留痕。
//! - 周常日程在 Notion 上写成「下一次到期日」，这样手机端也能收到提醒。
//!
//! 参考：<https://developers.notion.com/reference/intro>（API 版本 2022-06-28）

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::db;

const API: &str = "https://api.notion.com/v1";
const VERSION: &str = "2022-06-28";
/// Notion 单个富文本块上限 2000 字符；长正文必须切片，否则整页写入会失败。
const RICH_CHUNK: usize = 1800;

/// 三个集合的名字（同时是映射表里的 collection 值）。
const C_NOTES: &str = "notes";
const C_TODOS: &str = "todos";
const C_PLANS: &str = "plans";

/// 属性名：手机端要看得懂，就用中文。
const P_LOCAL_ID: &str = "本地ID";
/// 锚点列的说明：同步靠它认条目，用户误删误改会导致重复同步。
const DESC_LOCAL_ID: &str = "同步锚点，勿删改";
const DESC_DATE: &str = "可在此设置 Notion 提醒";
const DESC_WEEKDAY: &str = "0=周日，有效值 0-6";
const P_TITLE: &str = "标题";
const P_CONTENT: &str = "内容";
const P_DONE: &str = "完成";
const P_PRIORITY: &str = "优先级";
const P_NOTE: &str = "备注";
const P_CATEGORY: &str = "分类";
const P_DATE: &str = "日期";
const P_KIND: &str = "类型";
const P_WEEKDAY: &str = "星期";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    /// Internal Integration 的密钥。
    pub token: String,
    /// 容器页：三个数据库建在它下面（用户只需建一个空页并分享给 integration）。
    pub parent_page_id: String,
    pub db_notes: String,
    pub db_todos: String,
    pub db_plans: String,
    /// 自动同步开关与轮询间隔（秒）。轮询在前端跑，这里只负责持久化。
    pub auto_sync: bool,
    pub sync_interval_secs: u64,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            token: String::new(),
            parent_page_id: String::new(),
            db_notes: String::new(),
            db_todos: String::new(),
            db_plans: String::new(),
            auto_sync: false,
            sync_interval_secs: 60,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Summary {
    /// 本地改动推到 Notion。
    pub pushed: usize,
    /// Notion 改动拉回本地。
    pub pulled: usize,
    /// 一边删除导致另一边跟着删除。
    pub deleted: usize,
    /// 两边都改过（v1 以本地为准）。
    pub conflicts: usize,
}

struct Stats {
    pushed: usize,
    pulled: usize,
    deleted: usize,
    conflicts: usize,
}

impl Stats {
    fn add(&mut self, o: &Stats) {
        self.pushed += o.pushed;
        self.pulled += o.pulled;
        self.deleted += o.deleted;
        self.conflicts += o.conflicts;
    }
    fn into_summary(self) -> Summary {
        Summary {
            pushed: self.pushed,
            pulled: self.pulled,
            deleted: self.deleted,
            conflicts: self.conflicts,
        }
    }
}

const CFG_KEY: &str = "notion_config";

pub fn load_cfg() -> Config {
    db::meta_get(CFG_KEY)
        .and_then(|raw| serde_json::from_str::<Config>(&raw).ok())
        .unwrap_or_default()
}

pub fn save_cfg(cfg: &Config) {
    let raw = serde_json::to_string(cfg).unwrap_or_default();
    db::meta_set(CFG_KEY, &raw);
}

/// 把用户粘贴的 Notion 页面链接还原成 32 位页面 ID；本来就是 ID 则原样返回。
/// 链接形如 `https://www.notion.so/标题-1a2b3c...`，ID 是结尾那段十六进制。
pub fn normalize_page_id(input: &str) -> String {
    let s = input.trim();
    let tail = s.rsplit(['/', '-', '?', '#'].as_ref()).next().unwrap_or(s);
    let hex: String = tail.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if hex.len() == 32 {
        return hex;
    }
    s.to_string()
}

// ---- HTTP ----

async fn call(
    method: reqwest::Method,
    token: &str,
    path: &str,
    body: Option<&Value>,
) -> Result<Value, String> {
    let client = reqwest::Client::new();
    let mut req = client
        .request(method, format!("{API}{path}"))
        .header("Notion-Version", VERSION)
        .header("Content-Type", "application/json")
        .bearer_auth(token);
    if let Some(b) = body {
        req = req.json(b);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("请求 Notion 失败: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("Notion 返回 {status}: {text}"));
    }
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&text).map_err(|e| format!("解析 Notion 响应失败: {e}"))
}

// ---- 属性构造 / 解析 ----

/// 长文本切成多段富文本：Notion 单个富文本块上限 2000 字符。
fn rich_parts(v: &str) -> Vec<Value> {
    if v.is_empty() {
        return vec![];
    }
    let mut out = Vec::new();
    let mut rest = v;
    while !rest.is_empty() {
        let end = rest
            .char_indices()
            .take(RICH_CHUNK + 1)
            .last()
            .map(|(i, c)| i + c.len_utf8())
            .unwrap_or(rest.len());
        let take = end.min(rest.len());
        out.push(json!({"type": "text", "text": { "content": &rest[..take] }}));
        rest = &rest[take..];
    }
    out
}

fn rich(v: &str) -> Value {
    json!({ "rich_text": rich_parts(v) })
}

fn title_of(v: &str) -> Value {
    json!({ "title": [{ "type": "text", "text": { "content": v } }] })
}

fn number_of(v: Option<i64>) -> Value {
    match v {
        Some(n) => json!({ "number": n }),
        None => json!({ "number": Value::Null }),
    }
}

fn select_of(v: Option<&str>) -> Value {
    match v {
        Some(s) if !s.is_empty() => json!({ "select": { "name": s } }),
        _ => json!({ "select": Value::Null }),
    }
}

/// 本地时区对 UTC 的偏移，形如 "+08:00"。Notion 带时刻的日期必须带时区。
fn tz_offset() -> String {
    use windows::Win32::System::Time::GetTimeZoneInformation;
    const TIME_ZONE_ID_DAYLIGHT: u32 = 2;
    unsafe {
        let mut tzi = Default::default();
        let id = GetTimeZoneInformation(&mut tzi);
        let mut bias = tzi.Bias;
        if id == TIME_ZONE_ID_DAYLIGHT {
            bias += tzi.DaylightBias;
        } else {
            bias += tzi.StandardBias;
        }
        // Windows 的 Bias 是「UTC = 本地 + Bias」，本地对 UTC 的偏移取负。
        let mins = -bias;
        let sign = if mins >= 0 { '+' } else { '-' };
        let mins = mins.unsigned_abs();
        format!("{sign}{:02}:{:02}", mins / 60, mins % 60)
    }
}

/// 日期：有时刻就带时间与时区（Notion 会自动开启「包含时间」，能按点提醒）。
fn date_of(date: Option<&str>, time: Option<&str>) -> Value {
    match date {
        Some(d) if !d.is_empty() => {
            let start = match time {
                Some(t) if !t.is_empty() => {
                    let t = if t.len() == 5 { format!("{t}:00") } else { t.to_string() };
                    format!("{d}T{t}{}", tz_offset())
                }
                _ => d.to_string(),
            };
            json!({ "date": { "start": start } })
        }
        _ => json!({ "date": Value::Null }),
    }
}

fn read_title(p: &Value, key: &str) -> String {
    p["properties"][key]["title"][0]["plain_text"]
        .as_str()
        .unwrap_or("")
        .to_string()
}

fn read_rich(p: &Value, key: &str) -> String {
    p["properties"][key]["rich_text"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x["plain_text"].as_str())
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
}

fn read_number(p: &Value, key: &str) -> Option<i64> {
    p["properties"][key]["number"].as_i64()
}

fn read_bool(p: &Value, key: &str) -> bool {
    p["properties"][key]["checkbox"].as_bool().unwrap_or(false)
}

fn read_select(p: &Value, key: &str) -> Option<String> {
    p["properties"][key]["select"]["name"]
        .as_str()
        .map(|s| s.to_string())
}

/// Notion 日期的日期部分（"2026-10-03T09:00" → "2026-10-03"）。
fn read_date(p: &Value, key: &str) -> Option<String> {
    let s = p["properties"][key]["date"]["start"].as_str()?;
    Some(s.split('T').next().unwrap_or(s).to_string())
}

fn read_time(p: &Value, key: &str) -> Option<String> {
    let s = p["properties"][key]["date"]["start"].as_str()?;
    // Notion 回读带秒与时区（"09:00:00+08:00"），归一化成与本地一致的 "HH:MM"。
    let t = s.split('T').nth(1)?;
    t.get(0..5).filter(|h| h.len() == 5).map(|h| h.to_string())
}

fn page_id(p: &Value) -> String {
    p["id"].as_str().unwrap_or("").to_string()
}

/// 页面上记录的本地 ID；为空说明这条是手机端新建的。
fn local_id_of(p: &Value) -> Option<String> {
    read_number(p, P_LOCAL_ID).map(|n| n.to_string())
}

// ---- 页面读写 ----

async fn query_all(token: &str, db_id: &str) -> Result<Vec<Value>, String> {
    let mut pages = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let mut body = json!({ "page_size": 100 });
        if let Some(c) = &cursor {
            body["start_cursor"] = json!(c);
        }
        let resp = call(
            reqwest::Method::POST,
            token,
            &format!("/databases/{db_id}/query"),
            Some(&body),
        )
        .await?;
        for p in resp["results"].as_array().cloned().unwrap_or_default() {
            pages.push(p);
        }
        if resp["has_more"].as_bool().unwrap_or(false) {
            cursor = resp["next_cursor"].as_str().map(|s| s.to_string());
            if cursor.is_none() {
                break;
            }
        } else {
            break;
        }
    }
    Ok(pages)
}

async fn create_page(token: &str, db_id: &str, props: Value) -> Result<String, String> {
    let body = json!({ "parent": { "database_id": db_id }, "properties": props });
    let resp = call(reqwest::Method::POST, token, "/pages", Some(&body)).await?;
    let id = page_id(&resp);
    if id.is_empty() {
        return Err("创建 Notion 页面失败：响应里没有 id".to_string());
    }
    Ok(id)
}

async fn update_page(token: &str, page: &str, props: Value) -> Result<(), String> {
    call(
        reqwest::Method::PATCH,
        token,
        &format!("/pages/{page}"),
        Some(&json!({ "properties": props })),
    )
    .await
    .map(|_| ())
}

async fn archive_page(token: &str, page: &str) -> Result<(), String> {
    call(
        reqwest::Method::PATCH,
        token,
        &format!("/pages/{page}"),
        Some(&json!({ "archived": true })),
    )
    .await
    .map(|_| ())
}

/// 把本地 ID 写回 Notion 页面（手机端新建的条目回写后要补上这个锚点）。
async fn stamp_local_id(token: &str, page: &str, id: i64) -> Result<(), String> {
    update_page(token, page, json!({ P_LOCAL_ID: number_of(Some(id)) })).await
}

// ---- 建库 ----

fn notes_props_schema() -> Value {
    json!({
        P_TITLE: { "title": {} },
        P_CONTENT: { "rich_text": {} },
        P_LOCAL_ID: { "number": {}, "description": DESC_LOCAL_ID },
    })
}

/// 待办的本地 id 与速记/日程一样是时间戳数字，锚点同为「本地ID」；
/// id 类属性一律放最后（Notion 的列顺序就是建库时的属性顺序）。
fn todos_props_schema() -> Value {
    json!({
        P_CONTENT: { "title": {} },
        P_DONE: { "checkbox": {} },
        P_PRIORITY: { "number": {} },
        P_NOTE: { "rich_text": {} },
        P_CATEGORY: { "select": { "options": [] } },
        P_LOCAL_ID: { "number": {}, "description": DESC_LOCAL_ID },
    })
}

/// 日程的时刻已并入「日期」（带时区），不再单独建「时刻」列。
/// 「星期」用 0–6 表示周日至周六，写在属性说明里（悬停列名可见），
/// 栏名保持简短——栏名一改，已建的库就读不到了。
fn plans_props_schema() -> Value {
    json!({
        P_CONTENT: { "title": {} },
        P_DATE: { "date": {}, "description": DESC_DATE },
        P_KIND: { "select": { "options": [
            { "name": "一次性" }, { "name": "每周" }
        ] } },
        P_WEEKDAY: { "number": {}, "description": DESC_WEEKDAY },
        P_LOCAL_ID: { "number": {}, "description": DESC_LOCAL_ID },
    })
}

async fn create_database(token: &str, parent: &str, title: &str, props: Value) -> Result<String, String> {
    let body = json!({
        "parent": { "type": "page_id", "page_id": parent },
        "title": [{ "type": "text", "text": { "content": title } }],
        "properties": props,
    });
    let resp = match call(reqwest::Method::POST, token, "/databases", Some(&body)).await {
        Ok(r) => r,
        // 属性说明是锦上添花（少数 workspace 可能不接受），去掉再试一次，
        // 绝不能因为这个可选字段就让建库失败、同步卡住。
        Err(e) => {
            call(
                reqwest::Method::POST,
                token,
                "/databases",
                Some(&json!({
                    "parent": { "type": "page_id", "page_id": parent },
                    "title": [{ "type": "text", "text": { "content": title } }],
                    "properties": without_descriptions(&props),
                })),
            )
            .await
            .map_err(|_| e)?
        }
    };
    let id = page_id(&resp);
    if id.is_empty() {
        return Err(format!("创建 Notion 数据库「{title}」失败：响应里没有 id"));
    }
    Ok(id)
}

/// 去掉属性定义里的说明字段（建库重试用）。
fn without_descriptions(props: &Value) -> Value {
    let mut out = props.clone();
    if let Some(map) = out.as_object_mut() {
        for v in map.values_mut() {
            v.as_object_mut().map(|o| o.remove("description"));
        }
    }
    out
}

/// 确保三个数据库存在；缺哪个就在容器页下建哪个，并把 ID 记进配置。
pub async fn ensure_databases() -> Result<Config, String> {
    let mut cfg = load_cfg();
    if cfg.token.is_empty() {
        return Err("还没填写 Notion 密钥".to_string());
    }
    if cfg.parent_page_id.is_empty() {
        return Err("还没填写 Notion 容器页 ID".to_string());
    }
    let token = cfg.token.clone();
    let parent = cfg.parent_page_id.clone();

    // 配置里记着 ID ≠ 库还在：在 Notion 里删掉的库会让查询 404。
    // 先逐个验证，404 的清掉 ID 并作废该集合的旧映射（旧页已随库消失，
    // 不作废的话"删除获胜"规则会把本地数据也删掉），走下面的建库重建。
    let mut invalidated: Vec<&'static str> = Vec::new();
    for (col, id) in [
        (C_NOTES, &mut cfg.db_notes),
        (C_TODOS, &mut cfg.db_todos),
        (C_PLANS, &mut cfg.db_plans),
    ] {
        if id.is_empty() {
            continue;
        }
        match call(reqwest::Method::GET, &token, &format!("/databases/{id}"), None).await {
            Ok(resp) => {
                // 回收站里的库 GET 仍返回 200（archived/in_trash = true），
                // 但查询会 404——同样视为已删，走重建。
                let gone = resp["archived"].as_bool().unwrap_or(false)
                    || resp["in_trash"].as_bool().unwrap_or(false);
                if gone {
                    *id = String::new();
                    invalidated.push(col);
                }
            }
            Err(e) if e.starts_with("Notion 返回 404") => {
                *id = String::new();
                invalidated.push(col);
            }
            Err(e) => return Err(e),
        }
    }
    if !invalidated.is_empty() {
        save_cfg(&cfg);
        for col in &invalidated {
            db::notion_clear(col);
            db::notion_conflict_clear(col);
        }
    }

    if cfg.db_notes.is_empty() {
        cfg.db_notes =
            create_database(&token, &parent, "浮笺 · 速记", notes_props_schema()).await?;
        save_cfg(&cfg);
    }
    if cfg.db_todos.is_empty() {
        cfg.db_todos =
            create_database(&token, &parent, "浮笺 · 待办", todos_props_schema()).await?;
        save_cfg(&cfg);
    }
    if cfg.db_plans.is_empty() {
        cfg.db_plans =
            create_database(&token, &parent, "浮笺 · 日程", plans_props_schema()).await?;
        save_cfg(&cfg);
    }
    Ok(cfg)
}

// ---- 记录形状与签名 ----

#[derive(Serialize, Deserialize)]
struct NoteRec {
    title: String,
    content: String,
}

fn note_sig(r: &NoteRec) -> String {
    format!("{}\u{1}{}", r.title, r.content)
}

#[derive(Serialize, Deserialize)]
struct TodoRec {
    category: String,
    text: String,
    done: bool,
    priority: i64,
    note: String,
}

fn todo_sig(r: &TodoRec) -> String {
    format!(
        "{}\u{1}{}\u{1}{}\u{1}{}\u{1}{}",
        r.category, r.text, r.done, r.priority, r.note
    )
}

#[derive(Serialize, Deserialize)]
struct PlanRec {
    kind: String,
    date: Option<String>,
    weekday: Option<i64>,
    time: Option<String>,
    text: String,
}

fn plan_sig(r: &PlanRec) -> String {
    format!(
        "{}\u{1}{}\u{1}{}\u{1}{}\u{1}{}",
        r.kind,
        r.date.clone().unwrap_or_default(),
        r.weekday.unwrap_or(-1),
        r.time.clone().unwrap_or_default(),
        r.text
    )
}

/// 更新页面用的属性行：推送与冲突解决共用（建页时再补锚点字段）。
fn note_payload(r: &NoteRec) -> Value {
    json!({ P_TITLE: title_of(&r.title), P_CONTENT: rich(&r.content) })
}

fn todo_payload(cat: &str, t: &db::TodoItem) -> Value {
    json!({
        P_CONTENT: title_of(&t.text),
        P_DONE: json!({ "checkbox": t.done }),
        P_PRIORITY: number_of(Some(t.priority)),
        P_NOTE: rich(&t.note),
        P_CATEGORY: select_of(Some(cat)),
    })
}

fn plan_payload(p: &db::Plan) -> Value {
    let date = plan_remote_date(&p.kind, p.date.as_deref(), p.weekday);
    json!({
        P_CONTENT: title_of(&p.text),
        P_DATE: date_of(date.as_deref(), p.time.as_deref()),
        P_KIND: select_of(Some(if p.kind == "weekly" { "每周" } else { "一次性" })),
        P_WEEKDAY: number_of(p.weekday),
    })
}

/// 把一条冲突记进暂存表：两侧内容序列化存档，label 用于面板展示。
fn record_conflict<T: Serialize, U: Serialize>(
    collection: &str,
    local_id: &str,
    page_id: &str,
    local: &T,
    remote: &U,
    label: &str,
) {
    let local_json = serde_json::to_string(local).unwrap_or_default();
    let remote_json = serde_json::to_string(remote).unwrap_or_default();
    db::notion_conflict_put(collection, local_id, page_id, &local_json, &remote_json, label);
}

// ---- 三个集合的同步 ----

async fn sync_notes(token: &str, cfg: &Config) -> Result<Stats, String> {
    let mut st = Stats {
        pushed: 0,
        pulled: 0,
        deleted: 0,
        conflicts: 0,
    };
    let pages = query_all(token, &cfg.db_notes).await?;

    let mut remote: HashMap<String, (String, NoteRec)> = HashMap::new();
    let mut unlinked: Vec<(String, NoteRec)> = Vec::new();
    for p in &pages {
        let rec = NoteRec {
            title: read_title(p, P_TITLE),
            content: read_rich(p, P_CONTENT),
        };
        match local_id_of(p) {
            Some(id) => {
                remote.insert(id, (page_id(p), rec));
            }
            None => unlinked.push((page_id(p), rec)),
        }
    }

    let locals = db::load_state().tabs;
    let local_ids: HashMap<String, i64> = locals
        .iter()
        .map(|t| (t.id.to_string(), t.id))
        .collect();

    // 1) 已有映射：按签名决定推 / 拉 / 删
    for (lid, pid, old_local, old_remote) in db::notion_all(C_NOTES) {
        let has_local = local_ids.contains_key(&lid);
        let has_remote = remote.contains_key(&lid);
        match (has_local, has_remote) {
            (false, true) => {
                archive_page(token, &remote[&lid].0).await?;
                db::notion_del(C_NOTES, &lid);
                st.deleted += 1;
            }
            (true, false) => {
                if let Some(id) = local_ids.get(&lid) {
                    db::delete_tab(*id);
                }
                db::notion_del(C_NOTES, &lid);
                st.deleted += 1;
            }
            (false, false) => {
                db::notion_del(C_NOTES, &lid);
            }
            (true, true) => {
                let id = local_ids[&lid];
                let (rpid, rrec) = &remote[&lid];
                let cur_local = locals.iter().find(|t| t.id == id).unwrap();
                let local_rec = NoteRec {
                    title: cur_local.title.clone(),
                    content: cur_local.content.clone(),
                };
                let l_sig = note_sig(&local_rec);
                let r_sig = note_sig(rrec);
                let local_changed = old_local != l_sig;
                let remote_changed = old_remote != r_sig;
                if local_changed && remote_changed && l_sig != r_sig {
                    // 两边都改过且不同：记下冲突交给用户选择，不动任何一侧。
                    let label = if local_rec.title.is_empty() { &rrec.title } else { &local_rec.title };
                    record_conflict(C_NOTES, &lid, rpid, &local_rec, rrec, label);
                    st.conflicts += 1;
                } else if local_changed || (remote_changed && !local_changed && l_sig != r_sig) {
                    if local_changed {
                        update_page(token, rpid, note_payload(&local_rec)).await?;
                        db::notion_put(C_NOTES, &lid, rpid, &l_sig, &l_sig);
                        st.pushed += 1;
                    } else {
                        db::update_tab(id, &rrec.title, &rrec.content);
                        db::notion_put(C_NOTES, &lid, rpid, &r_sig, &r_sig);
                        st.pulled += 1;
                    }
                }
                let _ = pid;
            }
        }
    }

    // 2) 本地有、没映射过 → 在 Notion 新建
    for t in &locals {
        let lid = t.id.to_string();
        if db::notion_get(C_NOTES, &lid).is_some() {
            continue;
        }
        let rec = NoteRec {
            title: t.title.clone(),
            content: t.content.clone(),
        };
        let sig = note_sig(&rec);
        let npid = create_page(
            token,
            &cfg.db_notes,
            json!({
                P_TITLE: title_of(&rec.title),
                P_CONTENT: rich(&rec.content),
                P_LOCAL_ID: number_of(Some(t.id)),
            }),
        )
        .await?;
        db::notion_put(C_NOTES, &lid, &npid, &sig, &sig);
        st.pushed += 1;
    }

    // 3) Notion 上没有本地 ID 的页 → 手机端新建 → 回写本地
    for (pid, rec) in unlinked {
        let new_id = db::insert_tab(&rec.title, &rec.content);
        stamp_local_id(token, &pid, new_id).await?;
        let sig = note_sig(&rec);
        db::notion_put(C_NOTES, &new_id.to_string(), &pid, &sig, &sig);
        st.pulled += 1;
    }

    Ok(st)
}

async fn sync_todos(token: &str, cfg: &Config) -> Result<Stats, String> {
    let mut st = Stats {
        pushed: 0,
        pulled: 0,
        deleted: 0,
        conflicts: 0,
    };
    let pages = query_all(token, &cfg.db_todos).await?;

    let mut remote: HashMap<String, (String, TodoRec)> = HashMap::new();
    let mut unlinked: Vec<(String, TodoRec)> = Vec::new();
    for p in &pages {
        let rec = TodoRec {
            category: read_select(p, P_CATEGORY).unwrap_or_default(),
            text: read_title(p, P_CONTENT),
            done: read_bool(p, P_DONE),
            priority: read_number(p, P_PRIORITY).unwrap_or(5),
            note: read_rich(p, P_NOTE),
        };
        match local_id_of(p) {
            Some(id) => {
                remote.insert(id, (page_id(p), rec));
            }
            None => unlinked.push((page_id(p), rec)),
        }
    }

    let locals = db::load_todos_flat();
    let local_map: HashMap<String, (String, db::TodoItem)> = locals
        .iter()
        .map(|(cat, t)| (t.id.clone(), (cat.clone(), t.clone())))
        .collect();

    // 本轮归档过的页面可能仍在 unlinked 列表里（锚点读不出来才会进那里），
    // 导入时必须跳过，否则会把刚归档的页再导入一份。
    let mut archived: HashSet<String> = HashSet::new();

    for (lid, _pid, old_local, old_remote) in db::notion_all(C_TODOS) {
        let has_local = local_map.contains_key(&lid);
        let has_remote = remote.contains_key(&lid);
        match (has_local, has_remote) {
            (false, true) => {
                archive_page(token, &remote[&lid].0).await?;
                archived.insert(remote[&lid].0.clone());
                db::notion_del(C_TODOS, &lid);
                st.deleted += 1;
            }
            (true, false) => {
                db::delete_todo(&lid);
                db::notion_del(C_TODOS, &lid);
                st.deleted += 1;
            }
            (false, false) => {
                db::notion_del(C_TODOS, &lid);
            }
            (true, true) => {
                let (cat, item) = &local_map[&lid];
                let (rpid, rrec) = &remote[&lid];
                let l_sig = todo_sig(&TodoRec {
                    category: cat.clone(),
                    text: item.text.clone(),
                    done: item.done,
                    priority: item.priority,
                    note: item.note.clone(),
                });
                let r_sig = todo_sig(rrec);
                let local_changed = old_local != l_sig;
                let remote_changed = old_remote != r_sig;
                if local_changed && remote_changed && l_sig != r_sig {
                    // 两边都改过且不同：记下冲突交给用户选择，不动任何一侧。
                    // 注意存 TodoRec（含分类）而不是 TodoItem，否则反序列化对不上。
                    let local_rec = TodoRec {
                        category: cat.clone(),
                        text: item.text.clone(),
                        done: item.done,
                        priority: item.priority,
                        note: item.note.clone(),
                    };
                    record_conflict(C_TODOS, &lid, rpid, &local_rec, rrec, &item.text);
                    st.conflicts += 1;
                } else if local_changed {
                    update_page(token, rpid, todo_payload(cat, item)).await?;
                    db::notion_put(C_TODOS, &lid, rpid, &l_sig, &l_sig);
                    st.pushed += 1;
                } else if remote_changed && l_sig != r_sig {
                    let item = db::TodoItem {
                        id: lid.clone(),
                        text: rrec.text.clone(),
                        done: rrec.done,
                        priority: rrec.priority,
                        note: rrec.note.clone(),
                    };
                    // 分类可能被手机端改了：先摘掉旧的再插到新分类下。
                    db::delete_todo(&lid);
                    db::upsert_todo(&rrec.category, &item);
                    db::notion_put(C_TODOS, &lid, rpid, &r_sig, &r_sig);
                    st.pulled += 1;
                }
            }
        }
    }

    for (cat, item) in &locals {
        if db::notion_get(C_TODOS, &item.id).is_some() {
            continue;
        }
        let rec = TodoRec {
            category: cat.clone(),
            text: item.text.clone(),
            done: item.done,
            priority: item.priority,
            note: item.note.clone(),
        };
        let sig = todo_sig(&rec);
        let npid = create_page(
            token,
            &cfg.db_todos,
            json!({
                P_CONTENT: title_of(&item.text),
                P_DONE: json!({ "checkbox": item.done }),
                P_PRIORITY: number_of(Some(item.priority)),
                P_NOTE: rich(&item.note),
                P_CATEGORY: select_of(Some(cat)),
                P_LOCAL_ID: number_of(Some(item.id.parse::<i64>().unwrap_or(0))),
            }),
        )
        .await?;
        db::notion_put(C_TODOS, &item.id, &npid, &sig, &sig);
        st.pushed += 1;
    }

    for (pid, rec) in unlinked {
        // 刚归档的页不再导入，否则重复。
        if archived.contains(&pid) {
            continue;
        }
        let id = new_todo_id();
        let item = db::TodoItem {
            id: id.clone(),
            text: rec.text.clone(),
            done: rec.done,
            priority: rec.priority,
            note: rec.note.clone(),
        };
        db::upsert_todo(&rec.category, &item);
        db::notion_put(C_TODOS, &id, &pid, &todo_sig(&rec), &todo_sig(&rec));
        // 锚点立刻回写：下一轮同步要靠它认出这页是我们的，否则会被再导入一次。
        stamp_local_id(token, &pid, id.parse::<i64>().unwrap_or(0)).await?;
        st.pulled += 1;
    }

    Ok(st)
}

/// Notion 端新建待办导入时分配的本地 id：时间戳毫秒（与速记/日程同风格），
/// 原子序号保证同毫秒内不重复。
fn new_todo_id() -> String {
    use std::sync::atomic::{AtomicI64, Ordering};
    static SEQ: AtomicI64 = AtomicI64::new(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    (now + SEQ.fetch_add(1, Ordering::Relaxed)).to_string()
}

async fn sync_plans(token: &str, cfg: &Config) -> Result<Stats, String> {
    let mut st = Stats {
        pushed: 0,
        pulled: 0,
        deleted: 0,
        conflicts: 0,
    };
    let pages = query_all(token, &cfg.db_plans).await?;

    let mut remote: HashMap<String, (String, PlanRec)> = HashMap::new();
    let mut unlinked: Vec<(String, PlanRec)> = Vec::new();
    for p in &pages {
        let kind_cn = read_select(p, P_KIND).unwrap_or_default();
        let kind = if kind_cn == "每周" {
            "weekly".to_string()
        } else {
            "once".to_string()
        };
        let time = match read_time(p, P_DATE) {
            Some(t) if !t.is_empty() => Some(t),
            _ => None,
        };
        let rec = PlanRec {
            date: read_date(p, P_DATE),
            weekday: read_number(p, P_WEEKDAY),
            time,
            kind,
            text: read_title(p, P_CONTENT),
        };
        match local_id_of(p) {
            Some(id) => {
                remote.insert(id, (page_id(p), rec));
            }
            None => unlinked.push((page_id(p), rec)),
        }
    }

    let locals = db::load_plans();
    let local_map: HashMap<String, &db::Plan> = locals
        .iter()
        .map(|p| (p.id.to_string(), p))
        .collect();

    for (lid, _pid, old_local, old_remote) in db::notion_all(C_PLANS) {
        let has_local = local_map.contains_key(&lid);
        let has_remote = remote.contains_key(&lid);
        match (has_local, has_remote) {
            (false, true) => {
                archive_page(token, &remote[&lid].0).await?;
                db::notion_del(C_PLANS, &lid);
                st.deleted += 1;
            }
            (true, false) => {
                if let Ok(id) = lid.parse::<i64>() {
                    db::delete_plan(id).ok();
                }
                db::notion_del(C_PLANS, &lid);
                st.deleted += 1;
            }
            (false, false) => {
                db::notion_del(C_PLANS, &lid);
            }
            (true, true) => {
                let p = local_map[&lid];
                let (rpid, rrec) = &remote[&lid];
                let l_sig = plan_sig(&PlanRec {
                    kind: p.kind.clone(),
                    date: p.date.clone(),
                    weekday: p.weekday,
                    time: p.time.clone(),
                    text: p.text.clone(),
                });
                let r_sig = plan_sig(rrec);
                let local_changed = old_local != l_sig;
                let remote_changed = old_remote != r_sig;
                if local_changed && remote_changed && l_sig != r_sig {
                    // 两边都改过且不同：记下冲突交给用户选择，不动任何一侧。
                    record_conflict(C_PLANS, &lid, rpid, p, rrec, &p.text);
                    st.conflicts += 1;
                } else if local_changed {
                    update_page(token, rpid, plan_payload(p)).await?;
                    db::notion_put(C_PLANS, &lid, rpid, &l_sig, &l_sig);
                    st.pushed += 1;
                } else if remote_changed && l_sig != r_sig {
                    if let Ok(id) = lid.parse::<i64>() {
                        db::update_plan(
                            id,
                            &rrec.kind,
                            rrec.date.as_deref(),
                            rrec.weekday,
                            rrec.time.as_deref(),
                            &rrec.text,
                        );
                        db::notion_put(C_PLANS, &lid, rpid, &r_sig, &r_sig);
                        st.pulled += 1;
                    }
                }
            }
        }
    }

    for p in &locals {
        let lid = p.id.to_string();
        if db::notion_get(C_PLANS, &lid).is_some() {
            continue;
        }
        let rec = PlanRec {
            kind: p.kind.clone(),
            date: p.date.clone(),
            weekday: p.weekday,
            time: p.time.clone(),
            text: p.text.clone(),
        };
        let sig = plan_sig(&rec);
        let date = plan_remote_date(&p.kind, p.date.as_deref(), p.weekday);
        let npid = create_page(
            token,
            &cfg.db_plans,
            json!({
                P_CONTENT: title_of(&p.text),
                P_DATE: date_of(date.as_deref(), p.time.as_deref()),
                P_KIND: select_of(Some(if p.kind == "weekly" { "每周" } else { "一次性" })),
                P_WEEKDAY: number_of(p.weekday),
                P_LOCAL_ID: number_of(Some(p.id)),
            }),
        )
        .await?;
        db::notion_put(C_PLANS, &lid, &npid, &sig, &sig);
        st.pushed += 1;
    }

    for (pid, rec) in unlinked {
        let created = db::add_plan(
            &rec.kind,
            rec.date.as_deref(),
            rec.weekday,
            rec.time.as_deref(),
            &rec.text,
        )
        .map_err(|e| format!("写入日程失败: {e}"))?;
        stamp_local_id(token, &pid, created.id).await?;
        let sig = plan_sig(&rec);
        db::notion_put(C_PLANS, &created.id.to_string(), &pid, &sig, &sig);
        st.pulled += 1;
    }

    Ok(st)
}

/// 同步重置：归档三个库里的全部页面并清空映射表；本地数据不动。
/// 用于映射状态损坏后的重建——重置后跑一轮同步，按本地现状重新推上去。
pub async fn reset() -> Result<u32, String> {
    let cfg = load_cfg();
    if cfg.token.is_empty() {
        return Err("还没填写 Notion 密钥".to_string());
    }
    let token = cfg.token;
    let mut archived = 0u32;
    for db_id in [&cfg.db_notes, &cfg.db_todos, &cfg.db_plans] {
        if db_id.is_empty() {
            continue;
        }
        for p in query_all(&token, db_id).await? {
            archive_page(&token, &page_id(&p)).await?;
            archived += 1;
        }
    }
    db::notion_clear(C_NOTES);
    db::notion_clear(C_TODOS);
    db::notion_clear(C_PLANS);
    db::notion_conflict_clear_all();
    Ok(archived)
}

// ---- 冲突：面板展示与解决 ----

/// 冲突列表项（给面板的视图）。
#[derive(Debug, Clone, Serialize)]
pub struct ConflictView {
    /// 集合代码（notes/todos/plans）——解决命令要原样传回，查库靠它。
    pub collection: String,
    /// 集合中文名（速记/待办/日程），展示用。
    pub collection_label: String,
    pub local_id: String,
    /// 条目名（标题/文本），来自检测冲突时。
    pub label: String,
    /// 应用侧内容摘要。
    pub local_desc: String,
    /// Notion 侧内容摘要。
    pub remote_desc: String,
}

fn note_desc(json: &str) -> String {
    match serde_json::from_str::<NoteRec>(json) {
        Ok(r) if r.content.is_empty() => r.title,
        Ok(r) => format!("{}（{} 字）", r.title, r.content.chars().count()),
        Err(_) => "（内容不可读）".to_string(),
    }
}

fn todo_desc(json: &str) -> String {
    match serde_json::from_str::<TodoRec>(json) {
        Ok(r) => format!("{}{}，优先级 {}", if r.done { "✔ " } else { "✘ " }, r.text, r.priority),
        Err(_) => "（内容不可读）".to_string(),
    }
}

fn plan_desc(json: &str) -> String {
    match serde_json::from_str::<PlanRec>(json) {
        Ok(r) => match (&r.date, &r.time) {
            (Some(d), Some(t)) => format!("{}（{d} {t}）", r.text),
            (Some(d), None) => format!("{}（{d}）", r.text),
            _ => format!("{}（每周）", r.text),
        },
        Err(_) => "（内容不可读）".to_string(),
    }
}

/// 当前待处理的冲突列表（面板展示用）。
pub fn conflicts() -> Vec<ConflictView> {
    db::notion_conflict_all()
        .into_iter()
        .map(|(col, lid, _pid, ljson, rjson, label)| {
            let (name, ld, rd) = match col.as_str() {
                C_NOTES => ("速记", note_desc(&ljson), note_desc(&rjson)),
                C_TODOS => ("待办", todo_desc(&ljson), todo_desc(&rjson)),
                _ => ("日程", plan_desc(&ljson), plan_desc(&rjson)),
            };
            ConflictView {
                collection: col,
                collection_label: name.to_string(),
                local_id: lid,
                label,
                local_desc: ld,
                remote_desc: rd,
            }
        })
        .collect()
}

// ---- 冲突解决的共用读写 ----

/// 把一条速记内容写进本地库。
fn write_note_local(id: i64, r: &NoteRec) {
    db::update_tab(id, &r.title, &r.content);
}

/// 把一条待办内容写进本地库（先摘掉旧位置再插到分类下）。
fn write_todo_local(lid: &str, r: &TodoRec) {
    let item = db::TodoItem {
        id: lid.to_string(),
        text: r.text.clone(),
        done: r.done,
        priority: r.priority,
        note: r.note.clone(),
    };
    db::delete_todo(lid);
    db::upsert_todo(&r.category, &item);
}

/// 把一条日程内容写进本地库。
fn write_plan_local(id: i64, r: &PlanRec) {
    db::update_plan(id, &r.kind, r.date.as_deref(), r.weekday, r.time.as_deref(), &r.text);
}

/// 把速记内容推上 Notion 页并对齐签名。
async fn push_note_remote(token: &str, page_id: &str, lid: &str, r: &NoteRec) -> Result<(), String> {
    update_page(token, page_id, note_payload(r)).await?;
    db::notion_put(C_NOTES, lid, page_id, &note_sig(r), &note_sig(r));
    Ok(())
}

/// 把待办内容推上 Notion 页并对齐签名。
async fn push_todo_remote(token: &str, page_id: &str, lid: &str, cat: &str, item: &db::TodoItem) -> Result<(), String> {
    update_page(token, page_id, todo_payload(cat, item)).await?;
    let sig = todo_sig(&TodoRec {
        category: cat.to_string(),
        text: item.text.clone(),
        done: item.done,
        priority: item.priority,
        note: item.note.clone(),
    });
    db::notion_put(C_TODOS, lid, page_id, &sig, &sig);
    Ok(())
}

/// 把日程内容推上 Notion 页并对齐签名。
async fn push_plan_remote(token: &str, page_id: &str, lid: &str, p: &db::Plan) -> Result<(), String> {
    update_page(token, page_id, plan_payload(p)).await?;
    let sig = plan_sig(&PlanRec {
        kind: p.kind.clone(),
        date: p.date.clone(),
        weekday: p.weekday,
        time: p.time.clone(),
        text: p.text.clone(),
    });
    db::notion_put(C_PLANS, lid, page_id, &sig, &sig);
    Ok(())
}

/// 解决冲突：以应用为准 → 取本地当前内容推上 Notion。
pub async fn resolve_local(cfg: &Config, collection: &str, local_id: &str, page_id: &str) -> Result<(), String> {
    let token = &cfg.token;
    match collection {
        C_NOTES => {
            let id: i64 = local_id.parse().map_err(|_| "本地条目已不存在".to_string())?;
            let tab = db::load_state()
                .tabs
                .into_iter()
                .find(|t| t.id == id)
                .ok_or_else(|| "本地条目已不存在".to_string())?;
            let rec = NoteRec { title: tab.title.clone(), content: tab.content.clone() };
            push_note_remote(token, page_id, local_id, &rec).await
        }
        C_TODOS => {
            let (cat, item) = db::load_todos_flat()
                .into_iter()
                .find(|(_, t)| t.id == local_id)
                .ok_or_else(|| "本地条目已不存在".to_string())?;
            push_todo_remote(token, page_id, local_id, &cat, &item).await
        }
        C_PLANS => {
            let id: i64 = local_id.parse().map_err(|_| "本地条目已不存在".to_string())?;
            let p = db::load_plans()
                .into_iter()
                .find(|p| p.id == id)
                .ok_or_else(|| "本地条目已不存在".to_string())?;
            push_plan_remote(token, page_id, local_id, &p).await
        }
        _ => return Err("未知的条目类型".to_string()),
    }
}

/// 解决冲突：以 Notion 为准 → 把检测冲突时的远端内容写进本地。
/// （远端内容本来就在 Notion 页上，只需改写本地并更新签名，不需要 HTTP。）
pub fn resolve_remote(collection: &str, local_id: &str, page_id: &str, remote_json: &str) -> Result<(), String> {
    match collection {
        C_NOTES => {
            let rec: NoteRec = serde_json::from_str(remote_json).map_err(|e| e.to_string())?;
            let id: i64 = local_id.parse().map_err(|_| "本地条目已不存在".to_string())?;
            write_note_local(id, &rec);
            db::notion_put(C_NOTES, local_id, page_id, &note_sig(&rec), &note_sig(&rec));
        }
        C_TODOS => {
            let rec: TodoRec = serde_json::from_str(remote_json).map_err(|e| e.to_string())?;
            write_todo_local(local_id, &rec);
            db::notion_put(C_TODOS, local_id, page_id, &todo_sig(&rec), &todo_sig(&rec));
        }
        C_PLANS => {
            let rec: PlanRec = serde_json::from_str(remote_json).map_err(|e| e.to_string())?;
            let id: i64 = local_id.parse().map_err(|_| "本地条目已不存在".to_string())?;
            write_plan_local(id, &rec);
            db::notion_put(C_PLANS, local_id, page_id, &plan_sig(&rec), &plan_sig(&rec));
        }
        _ => return Err("未知的条目类型".to_string()),
    }
    Ok(())
}

/// 周常日程没有日期，但 Notion 提醒依赖日期 → 写成「下一次到期日」。
fn plan_remote_date(kind: &str, date: Option<&str>, weekday: Option<i64>) -> Option<String> {
    if kind == "weekly" {
        let target = weekday?;
        let today = db::local_weekday();
        let days = (target - today).rem_euclid(7);
        return Some(db::date_after(days));
    }
    date.map(|s| s.to_string())
}

// ---- 对外入口 ----

/// 跑一轮完整同步。命令是 async 的，不会占住主线程。
pub async fn sync() -> Result<Summary, String> {
    let cfg = ensure_databases().await?;
    let token = cfg.token.clone();
    let mut total = Stats {
        pushed: 0,
        pulled: 0,
        deleted: 0,
        conflicts: 0,
    };
    total.add(&sync_notes(&token, &cfg).await?);
    total.add(&sync_todos(&token, &cfg).await?);
    total.add(&sync_plans(&token, &cfg).await?);
    Ok(total.into_summary())
}
