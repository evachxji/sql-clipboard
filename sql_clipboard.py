# -*- coding: utf-8 -*-
"""SQL 剪切板 - 双击运行，一键复制 SQL"""
import os
import sqlite3
import sys
import tkinter as tk
from tkinter import ttk

# exe 打包后，数据库放在 exe 同目录；源码运行时放在脚本同目录
BASE_DIR = os.path.dirname(sys.executable if getattr(sys, "frozen", False) else os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "sql_clipboard.db")


# ---------- 数据层 ----------
def db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS cells ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "row INTEGER NOT NULL, col INTEGER NOT NULL,"
        "display TEXT NOT NULL DEFAULT '显示值',"
        "copy TEXT NOT NULL DEFAULT '')"
    )
    return conn


def load_cells():
    """返回 {row: [(id, col, display, copy), ...]}，按 row/col 排序"""
    with db() as conn:
        rows = conn.execute(
            "SELECT id, row, col, display, copy FROM cells ORDER BY row, col"
        ).fetchall()
    grid = {}
    for cid, r, c, disp, cp in rows:
        grid.setdefault(r, []).append((cid, c, disp, cp))
    return grid


def add_cell(row, col):
    with db() as conn:
        conn.execute("INSERT INTO cells (row, col) VALUES (?, ?)", (row, col))


def add_row():
    grid = load_cells()
    new_row = (max(grid) + 1) if grid else 0
    add_cell(new_row, 0)


def update_cell(cid, display, copy):
    with db() as conn:
        conn.execute("UPDATE cells SET display=?, copy=? WHERE id=?", (display, copy, cid))


def delete_cell(cid):
    with db() as conn:
        conn.execute("DELETE FROM cells WHERE id=?", (cid,))


# ---------- 界面 ----------
class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("SQL 剪切板")
        self.geometry("900x560")
        self.edit_mode = tk.BooleanVar(value=False)
        self._build_topbar()
        self._build_scroll_area()
        self._build_bottom()
        self.refresh()

    def _build_topbar(self):
        bar = ttk.Frame(self, padding=8)
        bar.pack(fill="x")
        ttk.Label(bar, text="SQL 剪切板", font=("", 13, "bold")).pack(side="left")
        # 右上角：编辑模式开关
        ttk.Checkbutton(
            bar, text="编辑模式", variable=self.edit_mode,
            command=self.refresh,
        ).pack(side="right")

    def _build_scroll_area(self):
        wrap = ttk.Frame(self)
        wrap.pack(fill="both", expand=True, padx=8)
        self.canvas = tk.Canvas(wrap, highlightthickness=0)
        vsb = ttk.Scrollbar(wrap, orient="vertical", command=self.canvas.yview)
        hsb = ttk.Scrollbar(self, orient="horizontal", command=self.canvas.xview)
        self.canvas.configure(yscrollcommand=vsb.set, xscrollcommand=hsb.set)
        vsb.pack(side="right", fill="y")
        self.canvas.pack(side="left", fill="both", expand=True)
        hsb.pack(fill="x")
        self.grid_frame = ttk.Frame(self.canvas, padding=4)
        self.canvas.create_window((0, 0), window=self.grid_frame, anchor="nw")
        self.grid_frame.bind(
            "<Configure>",
            lambda e: self.canvas.configure(scrollregion=self.canvas.bbox("all")),
        )
        # 鼠标滚轮滚动
        self.canvas.bind_all("<MouseWheel>", lambda e: self.canvas.yview_scroll(-e.delta // 120, "units"))

    def _build_bottom(self):
        ttk.Button(self, text="＋ 添加行", command=self.on_add_row).pack(fill="x", padx=8, pady=8)

    # ----- 渲染 -----
    def refresh(self):
        for w in self.grid_frame.winfo_children():
            w.destroy()
        grid = load_cells()
        editing = self.edit_mode.get()
        for r in sorted(grid):
            row_frame = ttk.Frame(self.grid_frame)
            row_frame.pack(fill="x", pady=2)
            for cid, c, disp, cp in grid[r]:
                text = disp if editing else (disp or "显示值")
                btn = tk.Button(
                    row_frame, text=text, width=18, anchor="w",
                    relief="solid", bd=1, wraplength=200, justify="left",
                    bg="#ffe9a8" if editing else "white",
                    command=lambda i=cid, d=disp, cp=cp: self.on_cell_click(i, d, cp),
                )
                btn.pack(side="left", padx=2)
            # 每行末尾：追加列
            ttk.Button(row_frame, text="＋", width=3,
                       command=lambda rr=r: self.on_add_col(rr)).pack(side="left", padx=6)

    # ----- 交互 -----
    def on_cell_click(self, cid, display, copy):
        if self.edit_mode.get():
            EditDialog(self, cid, display, copy)
        else:
            self.clipboard_clear()
            self.clipboard_append(copy if copy else display)
            self.title("SQL 剪切板 - 已复制 ✓")
            self.after(1200, lambda: self.title("SQL 剪切板"))

    def on_add_col(self, row):
        grid = load_cells()
        cols = [c for _, c, _, _ in grid.get(row, [])]
        add_cell(row, (max(cols) + 1) if cols else 0)
        self.refresh()

    def on_add_row(self):
        add_row()
        self.refresh()


class EditDialog(tk.Toplevel):
    """编辑单元格：显示值 / 复制值 / 删除"""

    def __init__(self, app, cid, display, copy):
        super().__init__(app)
        self.app = app
        self.cid = cid
        self.title("编辑单元格")
        self.transient(app)
        self.grab_set()
        self.resizable(True, True)

        ttk.Label(self, text="显示值:").grid(row=0, column=0, sticky="nw", padx=8, pady=(8, 2))
        self.disp = tk.Text(self, width=50, height=3)
        self.disp.insert("1.0", display)
        self.disp.grid(row=0, column=1, padx=8, pady=(8, 2))

        ttk.Label(self, text="复制值(SQL):").grid(row=1, column=0, sticky="nw", padx=8, pady=2)
        self.cp = tk.Text(self, width=50, height=10)
        self.cp.insert("1.0", copy)
        self.cp.grid(row=1, column=1, padx=8, pady=2)

        bar = ttk.Frame(self)
        bar.grid(row=2, column=0, columnspan=2, sticky="ew", padx=8, pady=8)
        ttk.Button(bar, text="保存", command=self.save).pack(side="right", padx=4)
        ttk.Button(bar, text="删除该单元格", command=self.delete).pack(side="left", padx=4)

    def save(self):
        update_cell(
            self.cid,
            self.disp.get("1.0", "end-1c").strip() or "显示值",
            self.cp.get("1.0", "end-1c"),
        )
        self.app.refresh()
        self.destroy()

    def delete(self):
        delete_cell(self.cid)
        self.app.refresh()
        self.destroy()


if __name__ == "__main__":
    # 首次运行若无数据，放一行示例，方便理解用法
    if not load_cells():
        add_row()
    App().mainloop()
