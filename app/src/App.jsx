import { useCallback, useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__

// 浏览器预览时使用的示例数据（打包后在 Tauri 中走 SQLite）
const MOCK = [
  { id: 1, row: 0, col: 0, display: '活跃用户查询', copy: "SELECT * FROM users WHERE status='active' AND last_login > DATE('now','-30 day');" },
  { id: 2, row: 0, col: 1, display: '月度订单统计', copy: "SELECT strftime('%Y-%m',created_at) m, COUNT(*), SUM(amount) FROM orders GROUP BY m;" },
  { id: 3, row: 0, col: 2, display: '库存预警', copy: 'SELECT sku,name,qty FROM inventory WHERE qty < safe_qty;' },
  { id: 4, row: 1, col: 0, display: '权限审计', copy: "SELECT u.name,r.role FROM users u JOIN user_roles r ON u.id=r.uid WHERE r.role='admin';" },
  { id: 5, row: 1, col: 1, display: '数据去重', copy: 'DELETE FROM logs WHERE id NOT IN (SELECT MIN(id) FROM logs GROUP BY hash);' },
  { id: 6, row: 2, col: 0, display: '慢查询TOP10', copy: 'SELECT sql_text,avg_time FROM perf ORDER BY avg_time DESC LIMIT 10;' },
]

export default function App() {
  const [cells, setCells] = useState([])
  const [editing, setEditing] = useState(false)
  const [toast, setToast] = useState(false)
  const [modal, setModal] = useState(null) // {id, display, copy}

  const load = useCallback(async () => {
    if (isTauri) setCells(await invoke('load_cells'))
    else setCells(MOCK)
  }, [])
  useEffect(() => { load() }, [load])

  const rows = useMemo(() => {
    const m = new Map()
    for (const c of cells) {
      if (!m.has(c.row)) m.set(c.row, [])
      m.get(c.row).push(c)
    }
    return [...m.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([r, list]) => [r, list.sort((a, b) => a.col - b.col)])
  }, [cells])

  const showToast = () => {
    setToast(true)
    setTimeout(() => setToast(false), 1400)
  }

  const clickCell = async (cell) => {
    if (editing) { setModal({ ...cell }); return }
    const text = cell.copy || cell.display
    if (isTauri) await invoke('copy_text', { text })
    else await navigator.clipboard.writeText(text)
    showToast()
  }

  const addCol = async (row, list) => {
    const col = list.length ? Math.max(...list.map(c => c.col)) + 1 : 0
    if (isTauri) { await invoke('add_cell', { row, col }); await load() }
    else setCells(cs => [...cs, { id: Date.now(), row, col, display: '显示值', copy: '' }])
  }

  const addRow = async () => {
    const row = cells.length ? Math.max(...cells.map(c => c.row)) + 1 : 0
    if (isTauri) { await invoke('add_cell', { row, col: 0 }); await load() }
    else setCells(cs => [...cs, { id: Date.now(), row, col: 0, display: '显示值', copy: '' }])
  }

  const saveModal = async (display, copy) => {
    if (isTauri) { await invoke('update_cell', { id: modal.id, display: display || '显示值', copy }); await load() }
    else setCells(cs => cs.map(c => c.id === modal.id ? { ...c, display: display || '显示值', copy } : c))
    setModal(null)
  }

  const deleteModal = async () => {
    if (isTauri) { await invoke('delete_cell', { id: modal.id }); await load() }
    else setCells(cs => cs.filter(c => c.id !== modal.id))
    setModal(null)
  }

  return (
    <div className={editing ? 'app editing' : 'app'}>
      <header>
        <h1>SQL <em>剪切板</em></h1>
        <div className="sub">Query Ledger · 账簿</div>
        <div className="switch" onClick={() => setEditing(e => !e)}>
          <span>编辑模式</span><div className="tg" />
        </div>
      </header>

      <main>
        {rows.length === 0 && (
          <div className="empty">还没有内容，点击下方「添加行」创建第一条 SQL 便签。</div>
        )}
        {rows.map(([r, list]) => (
          <div className="row" key={r}>
            {list.map(cell => (
              <div className="cell" key={cell.id} onClick={() => clickCell(cell)}>
                <div className="d">{cell.display}</div>
                <div className="c">{cell.copy || '— 未设置 SQL —'}</div>
              </div>
            ))}
            <button className="addcol" title="追加列" onClick={() => addCol(r, list)}>＋</button>
          </div>
        ))}
      </main>

      <button className="addrow" onClick={addRow}>＋ 添加行</button>
      <div className={toast ? 'toast show' : 'toast'}>已复制到剪贴板 ✓</div>

      {modal && (
        <div className="mask" onMouseDown={e => e.target === e.currentTarget && setModal(null)}>
          <EditBox cell={modal} onSave={saveModal} onDelete={deleteModal} onClose={() => setModal(null)} />
        </div>
      )}
    </div>
  )
}

function EditBox({ cell, onSave, onDelete, onClose }) {
  const [display, setDisplay] = useState(cell.display)
  const [copy, setCopy] = useState(cell.copy)
  return (
    <div className="box">
      <h3>编辑单元格</h3>
      <label>显示值</label>
      <textarea className="disp" rows={2} value={display} onChange={e => setDisplay(e.target.value)} />
      <label>复制值 (SQL)</label>
      <textarea rows={7} value={copy} onChange={e => setCopy(e.target.value)} spellCheck={false} />
      <div className="actions">
        <button className="btn del" onClick={onDelete}>删除该单元格</button>
        <span>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn save" onClick={() => onSave(display.trim(), copy)}>保存</button>
        </span>
      </div>
    </div>
  )
}
