import { useCallback, useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import QueryPage from './QueryPage.jsx'

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
  { id: 9, row: 2, col: 0, display: '每周一早上跑', copy: '' },
  { id: 10, row: 3, col: 0, display: '【每日】存款', copy: '' },
  { id: 11, row: 3, col: 1, display: 'core.cunkuan', copy: 'core.cunkuan' },
  { id: 12, row: 3, col: 2, display: '查昨天', copy: 'SELECT * FROM core.cunkuan WHERE rq = $zt;' },
  { id: 13, row: 3, col: 3, display: '查上月底', copy: 'SELECT * FROM core.cunkuan WHERE rq = $syd;' },
  { id: 8, row: 2, col: 1, display: '慢查询TOP10', copy: 'SELECT ... LIMIT 10;' },
]

const hasCopy = cell => cell.copy.trim() !== ''

const ZOOMS = [0.85, 1, 1.2] // 小 / 中 / 大

// 日期变量注入：复制时把 $jt 等替换为带单引号的 'yyyy-MM-dd'
function dateVars() {
  const p = n => String(n).padStart(2, '0')
  const f = d => `'${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}'`
  const now = new Date()
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return [
    ['$zt', f(new Date(t.getTime() - 86400000))],            // 昨天
    ['$syd', f(new Date(t.getFullYear(), t.getMonth(), 0))], // 上月底（上月最后一天）
  ]
}

function injectVars(text) {
  if (!text.includes('$')) return { text, hit: false }
  let out = text, hit = false
  for (const [k, v] of dateVars()) {
    if (out.includes(k)) { out = out.split(k).join(v); hit = true }
  }
  return { text: out, hit }
}

export default function App() {
  const [cells, setCells] = useState([])
  const [editing, setEditing] = useState(false)
  const [toasts, setToasts] = useState([])
  const [tab, setTab] = useState('clip')
  const [modal, setModal] = useState(null) // {id, display, copy}
  const [menu, setMenu] = useState(null)   // {x, y, cell}
  const [query, setQuery] = useState('')
  const [level, setLevel] = useState(() => {
    const v = parseInt(localStorage.getItem('fontLevel'))
    return [0, 1, 2].includes(v) ? v : 1 // 默认中档
  })
  useEffect(() => { localStorage.setItem('fontLevel', String(level)) }, [level])

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

  // 每次复制生成一条独立 toast，各自计时 1.5s 后消失
  const showToast = () => {
    const id = Date.now() + Math.random()
    setToasts(ts => [...ts, id])
    setTimeout(() => setToasts(ts => ts.filter(t => t !== id)), 1500)
  }

  const clickCell = async (cell) => {
    if (editing) { setModal({ ...cell }); return }
    const raw = hasCopy(cell) ? cell.copy : cell.display // 无复制值则复制显示值
    const { text } = injectVars(raw) // 复制时注入日期变量
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

  // 在 cell 右侧插入新单元格（同行右侧列依次右移一格）
  const insertRight = async (cell, display, copy) => {
    setMenu(null)
    if (isTauri) { await invoke('insert_cell', { row: cell.row, col: cell.col, display, copy }); await load() }
    else setCells(cs => [
      ...cs.map(c => (c.row === cell.row && c.col > cell.col ? { ...c, col: c.col + 1 } : c)),
      { id: Date.now(), row: cell.row, col: cell.col + 1, display, copy },
    ])
  }

  // 生成select：以显示值为表名生成查询 SQL，右侧新增「查询」单元格
  const genSelect = (cell, yesterday) =>
    insertRight(cell, '查询', `select * from ${cell.display}${yesterday ? ' where data_date = $zt' : ''};`)

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
    <div className={editing ? 'app editing' : 'app'} onClick={() => setMenu(null)}>
      <header>
        <h1>SQL <em>剪切板</em></h1>
        <div className="sub">Query Ledger · 账簿</div>
        <div className="tabs">
          <button className={tab === 'clip' ? 'tab on' : 'tab'} onClick={() => setTab('clip')}>剪切板</button>
          <button className={tab === 'query' ? 'tab on' : 'tab'} onClick={() => setTab('query')}>查询执行</button>
        </div>
        {tab === 'clip' && (<>
        <div className="f-wrap">
          <input
            className="filter"
            placeholder="筛选显示值…"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          {query && (
            <button className="f-clear" title="清空" onClick={() => setQuery('')}>✕</button>
          )}
        </div>
        <div className="switch" onClick={() => setEditing(e => !e)}>
          <span>编辑模式</span><div className="tg" />
        </div>
        <div className="fs-wrap">
          <button className="fs-btn" title="字体大小">Aa</button>
          <div className="fs-panel" onClick={e => e.stopPropagation()}>
            <input
              type="range" min="0" max="2" step="1"
              value={level}
              onChange={e => setLevel(parseInt(e.target.value))}
            />
            <div className="fs-labels">
              {['小', '中', '大'].map((t, i) => (
                <span key={t} className={level === i ? 'on' : ''}>{t}</span>
              ))}
            </div>
          </div>
        </div>
        </>)}
      </header>

      {tab === 'clip' && (<>
      <main style={{ zoom: ZOOMS[level] }}>
        {rows.length === 0 && (
          <div className="empty">还没有内容，开启右上角「编辑模式」后可添加行。</div>
        )}
        {rows.length > 0 && visibleRows.length === 0 && (
          <div className="empty">没有命中「{query.trim()}」的行。</div>
        )}
        <div className="grid">
        {visibleRows.map(([r, list]) => (
          <div className="row" key={r}>
            {list.map((cell, idx) => {
              const cls = [
                hasCopy(cell) ? 'cell' : 'note',
                idx === 0 ? 'lead' : '', // 仅第一列文本格显示 § 节号
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
                  {editing && (
                    <span
                      className="cell-x"
                      title="删除"
                      onClick={e => { e.stopPropagation(); deleteCell(cell) }}
                    >✕</span>
                  )}
                </div>
              )
            })}
            {editing && (
              <button className="addcol" title="追加列" onClick={() => addCol(r, list)}>＋</button>
            )}
          </div>
        ))}
        </div>
      </main>

      {editing && <button className="addrow" onClick={addRow}>＋ 添加行</button>}
      <div className="toasts">
        {toasts.map(id => <div className="toast-item" key={id}>已复制</div>)}
      </div>

      {menu && (
        <div
          className="ctx"
          style={{
            // 靠近窗口右/下边缘时翻转，避免菜单显示不全
            left: Math.min(menu.x, window.innerWidth - 170),
            top: menu.y + 190 > window.innerHeight ? Math.max(8, menu.y - 190) : menu.y,
          }}
          onClick={e => e.stopPropagation()}
          onContextMenu={e => e.preventDefault()}
        >
          <button onClick={() => { setModal({ ...menu.cell }); setMenu(null) }}>编辑</button>
          <button onClick={() => genSelect(menu.cell, false)}>生成select</button>
          <button onClick={() => genSelect(menu.cell, true)}>生成select（昨天）</button>
          <button onClick={() => insertRight(menu.cell, menu.cell.display, menu.cell.copy)}>复制</button>
          <button className="danger" onClick={() => deleteCell(menu.cell)}>删除</button>
        </div>
      )}

      {modal && (
        <div className="mask" onMouseDown={e => e.target === e.currentTarget && setModal(null)}>
          <EditBox cell={modal} onSave={saveModal} onDelete={deleteModal} onClose={() => setModal(null)} />
        </div>
      )}
      </>)}
      {tab === 'query' && <QueryPage />}
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
      <div className="hint">支持变量：<code>$zt</code> = 昨天、<code>$syd</code> = 上月底，复制时自动替换为带引号的 'yyyy-MM-dd'</div>
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