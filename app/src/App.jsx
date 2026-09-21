import { useCallback, useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

const isTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__

// 浏览器预览时使用的示例数据（打包后在 Tauri 中走 SQLite）
const MOCK = [
  { id: 1, row: 0, col: 0, display: '活跃用户查询', copy: "SELECT * FROM users WHERE status='active';" },
  { id: 2, row: 0, col: 1, display: '按近30天登录口径', copy: '' },
  { id: 3, row: 0, col: 2, display: '月度订单统计', copy: 'SELECT ... GROUP BY m;' },
  { id: 4, row: 0, col: 3, display: '库存预警', copy: 'SELECT sku,name,qty FROM inventory;' },
  { id: 5, row: 1, col: 0, display: '权限审计', copy: 'SELECT u.name,r.role ...;' },
  { id: 6, row: 1, col: 1, display: '数据去重', copy: 'DELETE FROM logs ...;' },
  { id: 7, row: 1, col: 2, display: '先备份再执行', copy: '' },
  { id: 8, row: 2, col: 0, display: '慢查询TOP10', copy: 'SELECT ... LIMIT 10;' },
]

const hasCopy = cell => cell.copy.trim() !== ''

export default function App() {
  const [cells, setCells] = useState([])
  const [editing, setEditing] = useState(false)
  const [toast, setToast] = useState(false)
  const [modal, setModal] = useState(null) // {id, display, copy}
  const [menu, setMenu] = useState(null)   // {x, y, cell}
  const [query, setQuery] = useState('')
  const [size, setSize] = useState(() => localStorage.getItem('cellSize') || 'm')
  const [sizeMenu, setSizeMenu] = useState(false)
  useEffect(() => { localStorage.setItem('cellSize', size) }, [size])

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

  // 筛选：命中某个显示值，则展示其所在行的全部单元格
  const q = query.trim().toLowerCase()
  const visibleRows = useMemo(
    () => (q ? rows.filter(([, list]) => list.some(c => c.display.toLowerCase().includes(q))) : rows),
    [rows, q],
  )

  const showToast = () => {
    setToast(true)
    setTimeout(() => setToast(false), 1400)
  }

  const clickCell = async (cell) => {
    if (editing) { setModal({ ...cell }); return }
    const text = hasCopy(cell) ? cell.copy : cell.display // 无复制值则复制显示值
    if (isTauri) await invoke('copy_text', { text })
    else await navigator.clipboard.writeText(text)
    showToast()
  }

  const openMenu = (e, cell) => {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, cell })
  }

  const deleteCell = async (cell) => {
    setMenu(null)
    if (isTauri) { await invoke('delete_cell', { id: cell.id }); await load() }
    else setCells(cs => cs.filter(c => c.id !== cell.id))
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
    if (!display) return // 显示值必填（EditBox 已拦截，双保险）
    if (isTauri) { await invoke('update_cell', { id: modal.id, display, copy }); await load() }
    else setCells(cs => cs.map(c => c.id === modal.id ? { ...c, display, copy } : c))
    setModal(null)
  }

  const deleteModal = async () => {
    if (isTauri) { await invoke('delete_cell', { id: modal.id }); await load() }
    else setCells(cs => cs.filter(c => c.id !== modal.id))
    setModal(null)
  }

  return (
    <div className={editing ? 'app editing' : 'app'} onClick={() => { setMenu(null); setSizeMenu(false) }}>
      <header>
        <h1>SQL <em>剪切板</em></h1>
        <div className="sub">Query Ledger · 账簿</div>
        <input
          className="filter"
          placeholder="筛选显示值…"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
        <div className="switch" onClick={() => setEditing(e => !e)}>
          <span>编辑模式</span><div className="tg" />
        </div>
        <div className="fs-wrap">
          <button
            className="fs-btn"
            title="字体大小"
            onClick={e => { e.stopPropagation(); setSizeMenu(o => !o) }}
          >Aa</button>
          {sizeMenu && (
            <div className="ctx fs-menu" onClick={e => e.stopPropagation()}>
              {[['s', '小', 12], ['m', '中', 14], ['l', '大', 17]].map(([k, label, px]) => (
                <button key={k} className={size === k ? 'on' : ''} onClick={() => { setSize(k); setSizeMenu(false) }}>
                  <span>{label}</span>
                  <span className="fs-a" style={{ fontSize: px }}>A</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </header>

      <main style={{ zoom: { s: 0.85, m: 1, l: 1.2 }[size] }}>
        {rows.length === 0 && (
          <div className="empty">还没有内容，开启右上角「编辑模式」后可添加行。</div>
        )}
        {rows.length > 0 && visibleRows.length === 0 && (
          <div className="empty">没有命中「{query.trim()}」的行。</div>
        )}
        {visibleRows.map(([r, list]) => (
          <div className="row" key={r}>
            {list.map(cell => {
              const cls = [
                hasCopy(cell) ? 'cell' : 'note',
                q && cell.display.toLowerCase().includes(q) ? 'hit' : '',
              ].join(' ').trim()
              return (
                <div
                  className={cls}
                  key={cell.id}
                  title={cell.display}
                  onClick={() => clickCell(cell)}
                  onContextMenu={e => openMenu(e, cell)}
                >
                  <div className="d">{cell.display}</div>
                </div>
              )
            })}
            {editing && (
              <button className="addcol" title="追加列" onClick={() => addCol(r, list)}>＋</button>
            )}
          </div>
        ))}
      </main>

      {editing && <button className="addrow" onClick={addRow}>＋ 添加行</button>}
      <div className={toast ? 'toast show' : 'toast'}>已复制到剪贴板 ✓</div>

      {menu && (
        <div
          className="ctx"
          style={{ left: menu.x, top: menu.y }}
          onClick={e => e.stopPropagation()}
          onContextMenu={e => e.preventDefault()}
        >
          <button onClick={() => { setModal({ ...menu.cell }); setMenu(null) }}>编辑</button>
          <button className="danger" onClick={() => deleteCell(menu.cell)}>删除</button>
        </div>
      )}

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
  const empty = display.trim() === ''
  return (
    <div className="box">
      <h3>编辑单元格</h3>
      <label>显示值（必填）</label>
      <textarea
        className={empty ? 'disp invalid' : 'disp'}
        rows={2}
        value={display}
        onChange={e => setDisplay(e.target.value)}
      />
      {empty && <div className="err">显示值不能为空</div>}
      <label>复制值 (SQL，可留空；留空则点击复制显示值)</label>
      <textarea rows={7} value={copy} onChange={e => setCopy(e.target.value)} spellCheck={false} />
      <div className="actions">
        <button className="btn del" onClick={onDelete}>删除该单元格</button>
        <span>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn save" disabled={empty} onClick={() => onSave(display.trim(), copy)}>保存</button>
        </span>
      </div>
    </div>
  )
}