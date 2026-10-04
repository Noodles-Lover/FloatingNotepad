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

use std::collections::HashMap;

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
const P_LOCAL_UID: &str = "本地UID";
const P_TITLE: &str = "标题";
const P_CONTENT: &str = "内容";
const P_DONE: &str = "完成";
const P_PRIORITY: &str = "优先级";
const P_NOTE: &str = "备注";
const P_CATEGORY: &str = "分类";
const P_DATE: &str = "日期";
const P_KIND: &str = "类型";
const P_WEEKDAY: &str = "星期";
const P_TIME: &str = "时刻";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Config {
    /// Internal Integration 的密钥。
    pub token: String,
    /// 容器页：三个数据库建在它下面（用户只需建一个空页并分享给 integration）。
    pub parent_page_id: String,
    pub db_notes: String,
    pub db_todos: String,
    pub db_plans: String,
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

/// 待办 id 是 UUID 字符串，数字属性放不下，锚点改用 rich_text 存。
fn local_uid_of(p: &Value) -> Option<String> {
    let s = read_rich(p, P_LOCAL_UID);
    if s.is_empty() { None } else { Some(s) }
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
        P_LOCAL_ID: { "number": {} },
    })
}

fn todos_props_schema() -> Value {
    json!({
        P_CONTENT: { "title": {} },
        P_DONE: { "checkbox": {} },
        P_PRIORITY: { "number": {} },
        P_NOTE: { "rich_text": {} },
        P_CATEGORY: { "select": { "options": [] } },
        P_LOCAL_ID: { "number": {} },
        P_LOCAL_UID: { "rich_text": {} },
    })
}

fn plans_props_schema() -> Value {
    json!({
        P_CONTENT: { "title": {} },
        P_DATE: { "date": {} },
        P_KIND: { "select": { "options": [
            { "name": "一次性" }, { "name": "每周" }
        ] } },
        P_WEEKDAY: { "number": {} },
        P_TIME: { "rich_text": {} },
        P_LOCAL_ID: { "number": {} },
    })
}

async fn create_database(token: &str, parent: &str, title: &str, props: Value) -> Result<String, String> {
    let body = json!({
        "parent": { "type": "page_id", "page_id": parent },
        "title": [{ "type": "text", "text": { "content": title } }],
        "properties": props,
    });
    let resp = call(reqwest::Method::POST, token, "/databases", Some(&body)).await?;
    let id = page_id(&resp);
    if id.is_empty() {
        return Err(format!("创建 Notion 数据库「{title}」失败：响应里没有 id"));
    }
    Ok(id)
}

/// 给已存在的数据库补属性（幂等）：老版本建的待办库还没有「本地UID」。
async fn patch_database(token: &str, db_id: &str, props: Value) -> Result<(), String> {
    let body = json!({ "properties": props });
    call(reqwest::Method::PATCH, token, &format!("/databases/{db_id}"), Some(&body))
        .await
        .map(|_| ())
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
    // 老库升级：给已存在的待办库补「本地UID」（PATCH 同名属性是幂等的）。
    if !cfg.db_todos.is_empty() {
        patch_database(&token, &cfg.db_todos, json!({ P_LOCAL_UID: { "rich_text": {} } })).await?;
    }
    Ok(cfg)
}

// ---- 记录形状与签名 ----

struct NoteRec {
    title: String,
    content: String,
}

fn note_sig(r: &NoteRec) -> String {
    format!("{}\u{1}{}", r.title, r.content)
}

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
                    st.conflicts += 1;
                }
                if local_changed || (remote_changed && !local_changed && l_sig != r_sig) {
                    if local_changed {
                        update_page(
                            token,
                            rpid,
                            json!({ P_TITLE: title_of(&local_rec.title), P_CONTENT: rich(&local_rec.content) }),
                        )
                        .await?;
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
        match local_uid_of(p) {
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

    for (lid, _pid, old_local, old_remote) in db::notion_all(C_TODOS) {
        let has_local = local_map.contains_key(&lid);
        let has_remote = remote.contains_key(&lid);
        match (has_local, has_remote) {
            (false, true) => {
                archive_page(token, &remote[&lid].0).await?;
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
                    st.conflicts += 1;
                }
                if local_changed {
                    update_page(
                        token,
                        rpid,
                        json!({
                            P_CONTENT: title_of(&item.text),
                            P_DONE: json!({ "checkbox": item.done }),
                            P_PRIORITY: number_of(Some(item.priority)),
                            P_NOTE: rich(&item.note),
                            P_CATEGORY: select_of(Some(cat)),
                        }),
                    )
                    .await?;
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
                P_LOCAL_UID: rich(&item.id),
            }),
        )
        .await?;
        db::notion_put(C_TODOS, &item.id, &npid, &sig, &sig);
        st.pushed += 1;
    }

    for (pid, rec) in unlinked {
        let id = uuid_like();
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
        update_page(token, &pid, json!({ P_LOCAL_UID: rich(&id) })).await?;
        st.pulled += 1;
    }

    Ok(st)
}

/// 本地生成的待办 id（Notion 端新建的条目需要一个本地 id）。
fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("n{:x}", now)
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
                    st.conflicts += 1;
                }
                if local_changed {
                    let date = plan_remote_date(&p.kind, p.date.as_deref(), p.weekday);
                    update_page(
                        token,
                        rpid,
                        json!({
                            P_CONTENT: title_of(&p.text),
                            P_DATE: date_of(date.as_deref(), p.time.as_deref()),
                            P_KIND: select_of(Some(if p.kind == "weekly" { "每周" } else { "一次性" })),
                            P_WEEKDAY: number_of(p.weekday),
                        }),
                    )
                    .await?;
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
    Ok(archived)
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
