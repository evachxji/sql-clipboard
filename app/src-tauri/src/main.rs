#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rusqlite::Connection;
use serde::Serialize;
use std::path::PathBuf;

#[derive(Serialize)]
struct Cell {
    id: i64,
    row: i64,
    col: i64,
    display: String,
    copy: String,
}

/// 数据库放在 exe 同目录，保证便携性
fn db_path() -> PathBuf {
    let dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));
    dir.join("sql_clipboard.db")
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

#[tauri::command]
fn load_cells() -> Result<Vec<Cell>, String> {
    let conn = open()?;
    let mut stmt = conn
        .prepare("SELECT id, \"row\", col, display, copy FROM cells ORDER BY \"row\", col")
        .map_err(|e| e.to_string())?;
    let cells = stmt
        .query_map([], |r| {
            Ok(Cell {
                id: r.get(0)?,
                row: r.get(1)?,
                col: r.get(2)?,
                display: r.get(3)?,
                copy: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(cells)
}

#[tauri::command]
fn add_cell(row: i64, col: i64) -> Result<(), String> {
    open()?
        .execute("INSERT INTO cells (\"row\", col) VALUES (?1, ?2)", [row, col])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn update_cell(id: i64, display: String, copy: String) -> Result<(), String> {
    open()?
        .execute(
            "UPDATE cells SET display = ?1, copy = ?2 WHERE id = ?3",
            (display, copy, id),
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 在 (row, col) 处插入单元格，该行 col 大于插入点的列依次右移一格
#[tauri::command]
fn insert_cell(row: i64, col: i64, display: String, copy: String) -> Result<(), String> {
    let conn = open()?;
    conn.execute(
        "UPDATE cells SET col = col + 1 WHERE \"row\" = ?1 AND col > ?2",
        [row, col],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO cells (\"row\", col, display, copy) VALUES (?1, ?2 + 1, ?3, ?4)",
        (row, col, display, copy),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn delete_cell(id: i64) -> Result<(), String> {
    open()?
        .execute("DELETE FROM cells WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn copy_text(text: String) -> Result<(), String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    cb.set_text(text).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            load_cells, add_cell, insert_cell, update_cell, delete_cell, copy_text
        ])
        .run(tauri::generate_context!())
        .expect("error while running application");
}
