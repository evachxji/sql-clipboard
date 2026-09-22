#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

// ===================== 数据结构 =====================

#[derive(Serialize)]
struct Cell {
    id: i64,
    row: i64,
    col: i64,
    display: String,
    copy: String,
}

#[derive(Serialize)]
struct Conn {
    id: i64,
    name: String,
    jar: String,
    url: String,
    user: String,
    password: String,
}

#[derive(Serialize)]
struct Preset {
    id: i64,
    name: String,
    sql: String,
    remarks: String, // 变量备注 JSON：{"cust_no":"客户号"}
}

#[derive(Serialize)]
struct JavaInfo {
    path: String,
    auto: bool, // true=自动探测到，false=手动指定；path 为空表示未找到
}

#[derive(Serialize)]
struct TestResult {
    ok: bool,
    #[serde(rename = "elapsedMs")]
    elapsed_ms: i64,
    error: String,
    info: String, // 数据库产品名+版本，如 "MySQL 8.0.36"
}

#[derive(Serialize)]
struct QueryResult {
    ok: bool,
    columns: Vec<String>,
    rows: Vec<Vec<Option<String>>>,
    truncated: bool,
    #[serde(rename = "updateCount")]
    update_count: i64,
    #[serde(rename = "elapsedMs")]
    elapsed_ms: i64,
    error: String,
}

// ===================== SQLite =====================

/// 数据库放在 exe 同目录，保证便携性
fn db_path() -> PathBuf {
    exe_dir().join("sql_clipboard.db")
}

fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

fn open() -> Result<Connection, String> {
    let conn = Connection::open(db_path()).map_err(|e| e.to_string())?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS cells (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            \"row\" INTEGER NOT NULL,
            col INTEGER NOT NULL,
            display TEXT NOT NULL DEFAULT '显示值',
            copy TEXT NOT NULL DEFAULT ''
        )",
        [],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS connections (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            jar TEXT NOT NULL,
            url TEXT NOT NULL,
            user TEXT NOT NULL DEFAULT '',
            password TEXT NOT NULL DEFAULT ''
        )",
        [],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
        [],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS presets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            sql TEXT NOT NULL
        )",
        [],
    )
    .map_err(|e| e.to_string())?;
    // 老库迁移：presets 补 remarks 列（变量备注）
    let cols: Vec<String> = conn
        .prepare("PRAGMA table_info(presets)")
        .map_err(|e| e.to_string())?
        .query_map([], |r| r.get(1))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    if !cols.iter().any(|c| c == "remarks") {
        conn.execute("ALTER TABLE presets ADD COLUMN remarks TEXT NOT NULL DEFAULT ''", [])
            .map_err(|e| e.to_string())?;
    }
    // 首次运行放一条示例，方便理解用法
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM cells", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if count == 0 {
        conn.execute(
            "INSERT INTO cells (\"row\", col, display, copy) VALUES (0, 0, '示例：活跃用户查询',
             'SELECT * FROM users WHERE status=''active'';')",
            [],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(conn)
}

fn get_setting(k: &str) -> Option<String> {
    open().ok()?.query_row("SELECT v FROM settings WHERE k = ?1", [k], |r| r.get(0)).optional().ok()?
}

fn set_setting(k: &str, v: &str) -> Result<(), String> {
    open()?
        .execute("INSERT INTO settings (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = ?2", [k, v])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ===================== 剪切板（原有功能） =====================

#[tauri::command]
fn load_cells() -> Result<Vec<Cell>, String> {
    let conn = open()?;
    let mut stmt = conn
        .prepare("SELECT id, \"row\", col, display, copy FROM cells ORDER BY \"row\", col")
        .map_err(|e| e.to_string())?;
    let cells = stmt
        .query_map([], |r| {
            Ok(Cell { id: r.get(0)?, row: r.get(1)?, col: r.get(2)?, display: r.get(3)?, copy: r.get(4)? })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(cells)
}

#[tauri::command]
fn add_cell(row: i64, col: i64) -> Result<(), String> {
    open()?.execute("INSERT INTO cells (\"row\", col) VALUES (?1, ?2)", [row, col]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn insert_cell(row: i64, col: i64, display: String, copy: String) -> Result<(), String> {
    let conn = open()?;
    conn.execute("UPDATE cells SET col = col + 1 WHERE \"row\" = ?1 AND col > ?2", (row, col)).map_err(|e| e.to_string())?;
    conn.execute("INSERT INTO cells (\"row\", col, display, copy) VALUES (?1, ?2, ?3, ?4)", (row, col + 1, display, copy)).map_err(|e| e.to_string())?;
    Ok(())
}

/// 行内拖拽排序：按 ids 顺序重排该行的 col（前端保证 ids 覆盖该行全部单元格）
#[tauri::command]
fn reorder_row(row: i64, ids: Vec<i64>) -> Result<(), String> {
    let mut conn = open()?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for (i, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE cells SET col = ?1 WHERE id = ?2 AND \"row\" = ?3",
            (i as i64, id, row),
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

#[tauri::command]
fn update_cell(id: i64, display: String, copy: String) -> Result<(), String> {
    open()?.execute("UPDATE cells SET display = ?1, copy = ?2 WHERE id = ?3", (display, copy, id)).map_err(|e| e.to_string())?;
    Ok(())
}


#[tauri::command]
fn delete_cell(id: i64) -> Result<(), String> {
    open()?.execute("DELETE FROM cells WHERE id = ?1", [id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn copy_text(text: String) -> Result<(), String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    cb.set_text(text).map_err(|e| e.to_string())
}

// ===================== Java 探测 =====================

/// Windows 下隐藏子进程控制台窗口（CREATE_NO_WINDOW），避免黑窗一闪而过
fn no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

fn valid_java(p: &Path) -> bool {
    if !p.is_file() {
        return false;
    }
    let mut cmd = Command::new(p);
    cmd.arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    no_window(&mut cmd);
    cmd.status().map(|s| s.success()).unwrap_or(false)
}

fn java_from_java_home() -> Option<PathBuf> {
    let home = std::env::var("JAVA_HOME").ok()?;
    let p = PathBuf::from(home).join("bin").join("java.exe");
    valid_java(&p).then_some(p)
}

fn java_from_path() -> Option<PathBuf> {
    let mut cmd = Command::new("where");
    cmd.arg("java");
    no_window(&mut cmd);
    let out = cmd.output().ok()?;
    let first = String::from_utf8_lossy(&out.stdout).lines().next()?.trim().to_string();
    let p = PathBuf::from(first);
    valid_java(&p).then_some(p)
}

fn java_from_registry() -> Option<PathBuf> {
    for root in ["HKLM\\SOFTWARE\\JavaSoft\\JDK", "HKLM\\SOFTWARE\\JavaSoft\\JRE"] {
        if let Some(home) = reg_java_home(root) {
            let p = PathBuf::from(home).join("bin").join("java.exe");
            if valid_java(&p) {
                return Some(p);
            }
        }
    }
    None
}

fn reg_java_home(root: &str) -> Option<String> {
    // 先取 CurrentVersion，再取该版本的 JavaHome
    let mut cmd = Command::new("reg");
    cmd.args(["query", root, "/v", "CurrentVersion"]);
    no_window(&mut cmd);
    let out = cmd.output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let ver = text.lines().find_map(|l| l.split("REG_SZ").nth(1).map(|s| s.trim().to_string()))?;
    let key = format!("{}\\{}", root, ver);
    let mut cmd2 = Command::new("reg");
    cmd2.args(["query", &key, "/v", "JavaHome"]);
    no_window(&mut cmd2);
    let out2 = cmd2.output().ok()?;
    String::from_utf8_lossy(&out2.stdout)
        .lines()
        .find_map(|l| l.split("REG_SZ").nth(1).map(|s| s.trim().to_string()))
}

/// 手动设置优先，其后 JAVA_HOME → PATH → 注册表
fn resolve_java() -> (Option<PathBuf>, bool) {
    if let Some(manual) = get_setting("java_path") {
        let p = PathBuf::from(&manual);
        if valid_java(&p) {
            return (Some(p), false);
        }
    }
    if let Some(p) = java_from_java_home() {
        return (Some(p), true);
    }
    if let Some(p) = java_from_path() {
        return (Some(p), true);
    }
    if let Some(p) = java_from_registry() {
        return (Some(p), true);
    }
    (None, true)
}

/// async 命令：Java 探测会多次启动 JVM（java -version），放到阻塞线程池
#[tauri::command]
async fn get_java_info() -> JavaInfo {
    tauri::async_runtime::spawn_blocking(|| {
        let (p, auto) = resolve_java();
        JavaInfo { path: p.map(|x| x.to_string_lossy().into_owned()).unwrap_or_default(), auto }
    })
    .await
    .unwrap_or(JavaInfo { path: String::new(), auto: true })
}

#[tauri::command]
async fn set_java_path(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if path.is_empty() {
            set_setting("java_path", "")
        } else if valid_java(Path::new(&path)) {
            set_setting("java_path", &path)
        } else {
            Err("路径无效或不是可用的 java.exe".into())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

// ===================== JDBC 桥接子进程 =====================

const BRIDGE_JAR: &[u8] = include_bytes!("../bridge/jdbc-bridge.jar");
static BRIDGE: OnceLock<Mutex<Option<Bridge>>> = OnceLock::new();
static REQ_ID: AtomicU64 = AtomicU64::new(1);

struct Bridge {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    stderr: BufReader<ChildStderr>,
}

fn ensure_bridge_jar() -> Result<PathBuf, String> {
    let path = exe_dir().join("jdbc-bridge.jar");
    let need_write = match std::fs::metadata(&path) {
        Ok(m) => m.len() as usize != BRIDGE_JAR.len(),
        Err(_) => true,
    };
    if need_write {
        std::fs::write(&path, BRIDGE_JAR).map_err(|e| e.to_string())?;
    }
    Ok(path)
}

fn start_bridge() -> Result<Bridge, String> {
    let (java, _) = resolve_java();
    let java = java.ok_or("未找到 Java 运行时，请在连接设置中手动指定 JDK 路径")?;
    let jar = ensure_bridge_jar()?;
    let mut cmd = Command::new(java);
    cmd.arg("-cp").arg(jar).arg("JdbcBridge")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped()); // 捕获错误输出，进程退出时带出死因
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let stdin = child.stdin.take().ok_or("无法打开桥接进程 stdin")?;
    let stdout = BufReader::new(child.stdout.take().ok_or("无法打开桥接进程 stdout")?);
    let stderr = BufReader::new(child.stderr.take().ok_or("无法打开桥接进程 stdout")?);
    Ok(Bridge { child, stdin, stdout, stderr })
}

fn call_once(bridge: &mut Bridge, req: &Value) -> Result<Value, String> {
    let line = serde_json::to_string(req).map_err(|e| e.to_string())?;
    bridge.stdin.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    bridge.stdin.write_all(b"\n").map_err(|e| e.to_string())?;
    bridge.stdin.flush().map_err(|e| e.to_string())?;
    let mut resp = String::new();
    bridge.stdout.read_line(&mut resp).map_err(|e| e.to_string())?;
    if resp.is_empty() {
        // 进程已退出：等待结束并读取 stderr，把真实死因（如 Java 版本过低）带给用户
        let _ = bridge.child.wait();
        let mut err_out = String::new();
        let _ = bridge.stderr.read_to_string(&mut err_out);
        let detail = err_out.trim();
        return Err(if detail.is_empty() {
            "桥接进程已退出".into()
        } else {
            format!("{}\n{}", "桥接进程已退出", detail)
        });
    }
    serde_json::from_str(&resp).map_err(|e| format!("桥接响应解析失败: {e}"))
}

/// 调用桥接进程：懒启动，失败重启一次重试
fn bridge_call(mut req: Value) -> Result<Value, String> {
    req["id"] = json!(REQ_ID.fetch_add(1, Ordering::SeqCst));
    let lock = BRIDGE.get_or_init(|| Mutex::new(None));
    let mut g = lock.lock().map_err(|e| e.to_string())?;
    let mut last_err = String::new();
    for attempt in 0..2 {
        if g.is_none() {
            match start_bridge() {
                Ok(b) => *g = Some(b),
                Err(e) => return Err(e),
            }
        }
        match call_once(g.as_mut().unwrap(), &req) {
            Ok(v) => return Ok(v),
            Err(e) => {
                last_err = e;
                if let Some(mut b) = g.take() {
                    let _ = b.child.kill();
                }
                if attempt == 1 {
                    return Err(last_err);
                }
            }
        }
    }
    Err(last_err)
}

// ===================== 连接配置 & 执行 =====================

#[tauri::command]
fn pick_jar() -> String {
    let Some(f) = rfd::FileDialog::new().add_filter("JDBC 驱动", &["jar"]).pick_file() else {
        return String::new();
    };
    let dir = exe_dir().join("drivers");
    let _ = std::fs::create_dir_all(&dir);
    let name = f.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "driver.jar".into());
    let dst = dir.join(&name);
    match std::fs::copy(&f, &dst) {
        Ok(_) => dst.to_string_lossy().into_owned(),
        Err(_) => f.to_string_lossy().into_owned(), // 复制失败则直接用原路径
    }
}

#[tauri::command]
fn save_connection(id: Option<i64>, name: String, jar: String, url: String, user: String, password: String) -> Result<i64, String> {
    let conn = open()?;
    match id {
        Some(i) => {
            conn.execute(
                "UPDATE connections SET name=?1, jar=?2, url=?3, user=?4, password=?5 WHERE id=?6",
                (name, jar, url, user, password, i),
            )
            .map_err(|e| e.to_string())?;
            Ok(i)
        }
        None => {
            conn.execute(
                "INSERT INTO connections (name, jar, url, user, password) VALUES (?1, ?2, ?3, ?4, ?5)",
                (name, jar, url, user, password),
            )
            .map_err(|e| e.to_string())?;
            Ok(conn.last_insert_rowid())
        }
    }
}

#[tauri::command]
fn list_connections() -> Result<Vec<Conn>, String> {
    let conn = open()?;
    let mut stmt = conn
        .prepare("SELECT id, name, jar, url, user, password FROM connections ORDER BY id")
        .map_err(|e| e.to_string())?;
    let list = stmt
        .query_map([], |r| {
            Ok(Conn { id: r.get(0)?, name: r.get(1)?, jar: r.get(2)?, url: r.get(3)?, user: r.get(4)?, password: r.get(5)? })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(list)
}

#[tauri::command]
fn delete_connection(id: i64) -> Result<(), String> {
    open()?.execute("DELETE FROM connections WHERE id = ?1", [id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn list_presets() -> Result<Vec<Preset>, String> {
    let conn = open()?;
    let mut stmt = conn.prepare("SELECT id, name, sql, remarks FROM presets ORDER BY id").map_err(|e| e.to_string())?;
    let list = stmt
        .query_map([], |r| Ok(Preset { id: r.get(0)?, name: r.get(1)?, sql: r.get(2)?, remarks: r.get(3)? }))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(list)
}

#[tauri::command]
fn save_preset(id: Option<i64>, name: String, sql: String, remarks: String) -> Result<i64, String> {
    let conn = open()?;
    match id {
        Some(i) => {
            conn.execute("UPDATE presets SET name=?1, sql=?2, remarks=?3 WHERE id=?4", (name, sql, remarks, i)).map_err(|e| e.to_string())?;
            Ok(i)
        }
        None => {
            conn.execute("INSERT INTO presets (name, sql, remarks) VALUES (?1, ?2, ?3)", (name, sql, remarks)).map_err(|e| e.to_string())?;
            Ok(conn.last_insert_rowid())
        }
    }
}

#[tauri::command]
fn delete_preset(id: i64) -> Result<(), String> {
    open()?.execute("DELETE FROM presets WHERE id = ?1", [id]).map_err(|e| e.to_string())?;
    Ok(())
}

/// 预设导入条目（前端回传勾选结果）
#[derive(Deserialize)]
struct PresetIn {
    name: String,
    sql: String,
    remarks: String,
}

/// 预设文件条目：dup 表示与库内已有查询重名（导入时跳过）
#[derive(Serialize)]
struct PresetFileItem {
    name: String,
    sql: String,
    remarks: String,
    dup: bool,
}

fn preset_exists(conn: &Connection, name: &str) -> bool {
    conn.query_row("SELECT 1 FROM presets WHERE name = ?1", [name], |_| Ok(())).is_ok()
}

/// 读取预设文件：JSON 格式 [{"name":"...","sql":"..."}]，返回条目供前端勾选
#[tauri::command]
fn read_presets_file() -> Result<Vec<PresetFileItem>, String> {
    let Some(f) = rfd::FileDialog::new().add_filter("预设 SQL", &["json"]).pick_file() else {
        return Ok(Vec::new());
    };
    let text = std::fs::read_to_string(&f).map_err(|e| e.to_string())?;
    let arr: Vec<Value> = serde_json::from_str(&text).map_err(|e| format!("JSON 解析失败: {e}"))?;
    let conn = open()?;
    let mut out: Vec<PresetFileItem> = Vec::new();
    for item in &arr {
        let name = item["name"].as_str().unwrap_or_default().trim().to_string();
        let sql = item["sql"].as_str().unwrap_or_default().trim().to_string();
        if name.is_empty() || sql.is_empty() {
            continue;
        }
        // remarks 允许是 JSON 对象或字符串，省略则为空
        let remarks = match &item["remarks"] {
            Value::Object(_) => item["remarks"].to_string(),
            Value::String(t) => t.clone(),
            _ => String::new(),
        };
        // 与库内重名、或文件内同名条目已出现过，均标记跳过
        let dup = preset_exists(&conn, &name) || out.iter().any(|p| p.name == name);
        out.push(PresetFileItem { name, sql, remarks, dup });
    }
    Ok(out)
}

/// 导入勾选的预设：名称已存在则跳过，返回实际导入条数
#[tauri::command]
fn import_presets(items: Vec<PresetIn>) -> Result<i64, String> {
    let conn = open()?;
    let mut count = 0i64;
    for it in &items {
        let name = it.name.trim();
        let sql = it.sql.trim();
        if name.is_empty() || sql.is_empty() || preset_exists(&conn, name) {
            continue;
        }
        conn.execute("INSERT INTO presets (name, sql, remarks) VALUES (?1, ?2, ?3)", (name, sql, &it.remarks)).map_err(|e| e.to_string())?;
        count += 1;
    }
    Ok(count)
}

/// 导出勾选的预设：JSON 文件 [{"name","sql","remarks"}]，返回导出条数（取消为 0）
#[tauri::command]
fn export_presets(ids: Vec<i64>) -> Result<i64, String> {
    if ids.is_empty() {
        return Ok(0);
    }
    let Some(f) = rfd::FileDialog::new()
        .add_filter("预设 SQL", &["json"])
        .set_file_name("presets.json")
        .save_file()
    else {
        return Ok(0);
    };
    let conn = open()?;
    let mut arr = Vec::new();
    for id in &ids {
        let row = conn
            .query_row("SELECT name, sql, remarks FROM presets WHERE id = ?1", [id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
            })
            .ok();
        if let Some((name, sql, remarks)) = row {
            // remarks 库内为 JSON 字符串，导出时还原为对象便于阅读
            let mut o = json!({ "name": name, "sql": sql });
            if !remarks.trim().is_empty() {
                o["remarks"] = serde_json::from_str::<Value>(&remarks).unwrap_or(Value::String(remarks));
            }
            arr.push(o);
        }
    }
    let text = serde_json::to_string_pretty(&arr).map_err(|e| e.to_string())?;
    std::fs::write(&f, text).map_err(|e| e.to_string())?;
    Ok(arr.len() as i64)
}

/// async 命令：JVM 启动 + 建连耗时数秒，放到阻塞线程池，避免卡住界面
#[tauri::command]
async fn test_connection(jar: String, url: String, user: String, password: String) -> TestResult {
    tauri::async_runtime::spawn_blocking(move || {
        let req = json!({"cmd": "test", "jar": jar, "url": url, "user": user, "password": password});
        match bridge_call(req) {
            Ok(v) => TestResult {
                ok: v["ok"].as_bool().unwrap_or(false),
                elapsed_ms: v["elapsedMs"].as_i64().unwrap_or(0),
                error: v["error"].as_str().unwrap_or_default().into(),
                info: v["dbInfo"].as_str().unwrap_or_default().into(),
            },
            Err(e) => TestResult { ok: false, elapsed_ms: 0, error: e, info: String::new() },
        }
    })
    .await
    .unwrap_or_else(|e| TestResult { ok: false, elapsed_ms: 0, error: e.to_string(), info: String::new() })
}

#[tauri::command]
async fn execute_query(jar: String, url: String, user: String, password: String, sql: String, params: Option<std::collections::HashMap<String, String>>) -> QueryResult {
    tauri::async_runtime::spawn_blocking(move || execute_query_blocking(jar, url, user, password, sql, params))
        .await
        .unwrap_or_else(|e| QueryResult { ok: false, columns: vec![], rows: vec![], truncated: false, update_count: -1, elapsed_ms: 0, error: e.to_string() })
}

fn execute_query_blocking(jar: String, url: String, user: String, password: String, sql: String, params: Option<std::collections::HashMap<String, String>>) -> QueryResult {
    let fail = |e: String| QueryResult { ok: false, columns: vec![], rows: vec![], truncated: false, update_count: -1, elapsed_ms: 0, error: e };
    let mut req = json!({"cmd": "query", "jar": jar, "url": url, "user": user, "password": password, "sql": sql, "maxRows": 1000});
    if let Some(p) = params {
        if !p.is_empty() {
            req["params"] = json!(p);
        }
    }
    match bridge_call(req) {
        Ok(v) => {
            if !v["ok"].as_bool().unwrap_or(false) {
                return fail(v["error"].as_str().unwrap_or("未知错误").into());
            }
            QueryResult {
                ok: true,
                columns: v["columns"].as_array().map(|a| a.iter().map(|x| x.as_str().unwrap_or_default().into()).collect()).unwrap_or_default(),
                rows: v["rows"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .map(|r| r.as_array().map(|c| c.iter().map(|x| x.as_str().map(|s| s.to_string())).collect()).unwrap_or_default())
                            .collect()
                    })
                    .unwrap_or_default(),
                truncated: v["truncated"].as_bool().unwrap_or(false),
                update_count: v["updateCount"].as_i64().unwrap_or(-1),
                elapsed_ms: v["elapsedMs"].as_i64().unwrap_or(0),
                error: String::new(),
            }
        }
        Err(e) => fail(e),
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            load_cells, add_cell, insert_cell, update_cell, delete_cell, reorder_row, copy_text,
            get_java_info, set_java_path, pick_jar,
            save_connection, list_connections, delete_connection,
            list_presets, save_preset, delete_preset, read_presets_file, import_presets, export_presets,
            test_connection, execute_query
        ])
        .run(tauri::generate_context!())
        .expect("error while running application");
}