import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { OFFICIAL } from './edition.js'

const base = p => (p || '').split(/[\\/]/).pop()

/** 内置日期变量：$zt = 昨天、$syd = 上月底。SQL 中不带引号书写，注入值自带引号 */
const DATE_VARS = ['zt', 'syd']
function dateVarPairs() {
  const p = n => String(n).padStart(2, '0')
  const f = d => `'${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}'`
  const now = new Date()
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return { zt: f(new Date(t.getTime() - 86400000)), syd: f(new Date(t.getFullYear(), t.getMonth(), 0)) }
}

/** 提取手动变量 $name（排除内置日期变量），去重保序 */
function extractVars(sql) {
  const names = []
  const re = /\$([A-Za-z_]\w*)/g
  let m
  while ((m = re.exec(sql))) {
    if (!DATE_VARS.includes(m[1]) && !names.includes(m[1])) names.push(m[1])
  }
  return names
}

/** 提取命名参数 :name（跳过单引号字符串），去重保序 —— 兼容旧预设 */
function extractParams(sql) {
  const names = []
  let inStr = false
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (ch === "'") { inStr = !inStr; continue }
    if (!inStr && ch === ':' && /[A-Za-z_]/.test(sql[i + 1] || '')) {
      let e = i + 1
      while (e < sql.length && /\w/.test(sql[e])) e++
      const n = sql.slice(i + 1, e)
      if (!names.includes(n)) names.push(n)
      i = e - 1
    }
  }
  return names
}

/** 按顶层 AND/OR 切分 WHERE 主体（跳过单引号字符串与括号内部） */
function splitTopLevel(body) {
  const segs = []
  let buf = '', conn = '', inStr = false, depth = 0, i = 0
  while (i < body.length) {
    const ch = body[i]
    if (ch === "'") { inStr = !inStr; buf += ch; i++; continue }
    if (inStr) { buf += ch; i++; continue }
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    if (depth === 0) {
      const w = /^\s+(and|or)\b/i.exec(body.slice(i))
      if (w) {
        segs.push({ conn, text: buf.trim() })
        buf = ''
        conn = w[1].toUpperCase()
        i += w[0].length
        continue
      }
    }
    buf += ch
    i++
  }
  segs.push({ conn, text: buf.trim() })
  return segs.filter(s => s.text)
}

/** 摘除 WHERE 子句中包含未填变量的条件段；整句摘空则去掉 WHERE */
function stripConditions(sql, missing) {
  const wm = /\bwhere\b/i.exec(sql)
  if (!wm) return sql
  const bodyStart = wm.index + wm[0].length
  const rest = sql.slice(bodyStart)
  const tm = /\bgroup\s+by\b|\border\s+by\b|\bhaving\b|\blimit\b|;/i.exec(rest)
  const bodyEnd = tm ? bodyStart + tm.index : sql.length
  const kept = splitTopLevel(sql.slice(bodyStart, bodyEnd))
    .filter(seg => !missing.some(v => new RegExp('\\$' + v + '\\b').test(seg.text)))
  if (!kept.length) return (sql.slice(0, wm.index) + sql.slice(bodyEnd)).replace(/\s+$/, ' ')
  const rebuilt = kept.map((seg, i) => (i === 0 ? seg.text : seg.conn + ' ' + seg.text)).join(' ')
  return (sql.slice(0, bodyStart) + ' ' + rebuilt + ' ' + sql.slice(bodyEnd)).replace(/\s+$/, '')
}

/** 生成最终 SQL：日期变量（自带引号）→ 已填变量（转义单引号）→ 摘除未填条件 */
function buildSql(sql, values) {
  const dates = dateVarPairs()
  let out = sql.replace(/\$(zt|syd)\b/g, (_, k) => dates[k])
  const missing = []
  for (const n of extractVars(sql)) {
    const v = (values[n] || '').trim()
    if (v) out = out.replace(new RegExp('\\$' + n + '\\b', 'g'), () => v.replace(/'/g, "''"))
    else missing.push(n)
  }
  if (missing.length) out = stripConditions(out, missing)
  return { sql: out, missing }
}

const parseRemarks = r => { try { return JSON.parse(r || '{}') } catch { return {} } }

export default function QueryPage() {
  const [conns, setConns] = useState([])
  const [sel, setSel] = useState(null)
  const [connModal, setConnModal] = useState(null) // 连接编辑 {id?,name,jar,url,user,password}
  const [javaInfo, setJavaInfo] = useState(null) // null=检测中
  const [connStatus, setConnStatus] = useState({}) // id -> {st:'run'|'ok'|'err', msg}
  const [presets, setPresets] = useState([])
  const [presetModal, setPresetModal] = useState(null) // {id?,name,sql,remarks}
  const [importMsg, setImportMsg] = useState('')
  const [pickModal, setPickModal] = useState(null) // 导入/导出勾选弹窗 {title, okText, items, onOk}
  const [runPreset, setRunPreset] = useState(null) // 待填变量的预设
  const [paramValues, setParamValues] = useState({})
  const [sql, setSql] = useState('')
  const [showEditor, setShowEditor] = useState(false)
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState([]) // 每次执行结果一个标签 [{key, label, r}]
  const [activeKey, setActiveKey] = useState(null)
  const [pageErr, setPageErr] = useState('')
  const tabSeq = useRef(0) // {…execute_query 返回, label, sqlText}
  const [menu, setMenu] = useState(null)   // 右键菜单 {x, y, items:[{label,danger,action}]}
  const [confirm, setConfirm] = useState(null) // 删除二次确认 {text, action}

  const loadConns = useCallback(async () => {
    try {
      const list = await invoke('list_connections')
      setConns(list)
      if (list.length && !list.some(c => c.id === sel)) setSel(list[0].id)
    } catch (e) { setPageErr('list_connections 失败: ' + String(e)) }
  }, [sel])

  const loadPresets = useCallback(async () => {
    try { setPresets(await invoke('list_presets')) }
    catch (e) { setPageErr('list_presets 失败: ' + String(e)) }
  }, [])

  useEffect(() => {
    loadConns()
    loadPresets()
    invoke('get_java_info').then(setJavaInfo).catch(e => setPageErr('get_java_info 失败: ' + String(e)))
  }, []) // eslint-disable-line

  /** 测试 / 预热连接：异步命令，不阻塞界面 */
  const testConn = useCallback(async (c) => {
    setConnStatus(t => ({ ...t, [c.id]: { st: 'run', msg: '连接中' } }))
    const r = await invoke('test_connection', { jar: c.jar, url: c.url, user: c.user, password: c.password })
    setConnStatus(t => ({
      ...t,
      [c.id]: r.ok ? { st: 'ok', msg: `已连接 · ${r.elapsedMs}ms` } : { st: 'err', msg: r.error || '连接失败' },
    }))
  }, [])

  // 选中连接后自动预热（进入页面即后台建连，界面保持可操作）
  useEffect(() => {
    const c = conns.find(x => x.id === sel)
    if (c && !connStatus[c.id]) testConn(c)
  }, [sel, conns]) // eslint-disable-line

  // 执行中的标签每 500ms 刷新「已执行 N 秒」
  useEffect(() => {
    const t = setInterval(() => {
      setResults(list => list.some(x => x.st === 'run')
        ? list.map(x => x.st === 'run' ? { ...x, elapsed: Math.floor((Date.now() - x.startedAt) / 1000) } : x)
        : list)
    }, 500)
    return () => clearInterval(t)
  }, [])

  const delConn = async (c) => {
    await invoke('delete_connection', { id: c.id })
    setConnStatus(t => { const n = { ...t }; delete n[c.id]; return n })
    await loadConns()
  }

  const flash = (msg, ms = 2500) => {
    setImportMsg(msg)
    setTimeout(() => setImportMsg(''), ms)
  }

  const importPresets = async () => {
    try {
      const items = await invoke('read_presets_file')
      if (!items.length) { flash('未导入'); return }
      setPickModal({
        title: '导入预设查询',
        okText: '导入',
        items: items.map((it, i) => ({ key: i, name: it.name, sub: it.sql, disabled: it.dup, hint: it.dup ? '重名跳过' : '', raw: it })),
        onOk: async (picked) => {
          const n = await invoke('import_presets', { items: picked.map(p => p.raw) })
          await loadPresets()
          flash(n > 0 ? `已导入 ${n} 条` : '未导入')
        },
      })
    } catch (e) { flash(String(e), 4000) }
  }

  const exportPresets = () => {
    if (!presets.length) { flash('没有可导出的查询'); return }
    setPickModal({
      title: '导出预设查询',
      okText: '导出',
      items: presets.map(p => ({ key: p.id, name: p.name, sub: p.sql })),
      onOk: async (picked) => {
        try {
          const n = await invoke('export_presets', { ids: picked.map(p => p.key) })
          flash(n > 0 ? `已导出 ${n} 条` : '已取消')
        } catch (e) { flash(String(e), 4000) }
      },
    })
  }

  const delPreset = async (p) => {
    await invoke('delete_preset', { id: p.id })
    if (runPreset && runPreset.id === p.id) setRunPreset(null)
    await loadPresets()
  }

  const selConn = useMemo(() => conns.find(x => x.id === sel), [conns, sel])
  const selStatus = sel ? connStatus[sel] : null

  const runNow = async (template, values, label) => {
    if (!selConn) { setPageErr('请先在左侧选择或新建一个连接'); return }
    const { sql: finalSql } = buildSql(template, values || {})
    if (!finalSql.trim()) { setPageErr('生成的 SQL 为空'); return }
    // 模板处理后剩余的 :param 走 JDBC 命名参数绑定（兼容旧预设）
    const legacy = {}
    for (const n of extractParams(finalSql)) legacy[n] = (values && values[n]) || ''
    setRunning(true)
    setPageErr('')
    // 先创建标签（loading 态），执行完成后再回填结果
    const key = ++tabSeq.current
    setResults(list => [...list, { key, label, st: 'run', startedAt: Date.now(), elapsed: 0, r: null }])
    setActiveKey(key)
    const r = await invoke('execute_query', {
      jar: selConn.jar, url: selConn.url, user: selConn.user, password: selConn.password,
      sql: finalSql, params: Object.keys(legacy).length ? legacy : null,
    })
    setResults(list => list.map(t => t.key === key ? { ...t, st: 'done', r: { ...r, sqlText: finalSql } } : t))
    setRunning(false)
  }

  const closeTab = (key) => {
    const rest = results.filter(t => t.key !== key)
    setResults(rest)
    if (key === activeKey) setActiveKey(rest.length ? rest[rest.length - 1].key : null)
  }

  const openMenu = (e, items) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, items })
  }
  const askDelete = (text, action) => setConfirm({ text, action })

  const clickPreset = (p) => {
    if (!selConn) { setPageErr('请先在左侧选择或新建一个连接'); return }
    if (extractVars(p.sql).length || extractParams(p.sql).length) {
      setParamValues({})
      setRunPreset(p)
    } else {
      runNow(p.sql, {}, p.name)
    }
  }

  const curResult = results.find(t => t.key === activeKey) || results[results.length - 1]

  return (
    <div className="qwrap" onClick={() => setMenu(null)}>
      {!OFFICIAL && (
      <aside className="qside">
        <button className="qnew" onClick={() => setConnModal({ name: '', jar: '', url: '', user: '', password: '' })}>＋ 新建连接</button>
        {conns.length === 0 && <div className="qside-empty">还没有连接配置</div>}
        {conns.map(c => {
          const st = connStatus[c.id]
          return (
            <div
              key={c.id}
              className={sel === c.id ? 'conn-card on' : 'conn-card'}
              onClick={() => setSel(c.id)}
              onContextMenu={e => openMenu(e, [
                { label: '删除', danger: true, action: () => askDelete(`确认删除连接「${c.name}」？删除后不可恢复。`, () => delConn(c)) },
              ])}
            >
              <div className="cc-name">{c.name}</div>
              <div className="cc-url" title={c.url}>{c.url}</div>
              <div className="cc-jar" title={c.jar}>{base(c.jar)}</div>
              {st && (
                <div className={'cc-status ' + st.st}>
                  {st.st === 'run' && <span className="spin">§</span>}
                  {st.st === 'ok' && '✓ '}
                  {st.st === 'err' && '✗ '}
                  {st.msg}
                </div>
              )}
              <div className="cc-btns" onClick={e => e.stopPropagation()}>
                <button onClick={() => setConnModal({ ...c })}>编辑</button>
              </div>
            </div>
          )
        })}
      </aside>
      )}

      <section className="qmain">
        {javaInfo && !javaInfo.path && <JavaBanner onReady={setJavaInfo} />}

        <div className="preset-head">
          <span className="sec-title">预设查询</span>
          <span className="sec-actions">
            {importMsg && <span className="import-msg">{importMsg}</span>}
            <button className="mini-btn" onClick={importPresets}>导入</button>
            <button className="mini-btn" onClick={exportPresets}>导出</button>
            <button className="mini-btn" onClick={() => setShowEditor(s => !s)}>自定义 SQL {showEditor ? '▾' : '▸'}</button>
            <button className="mini-btn accent" onClick={() => setPresetModal({ name: '', sql: '', remarks: '' })}>＋ 新建查询</button>
          </span>
        </div>
        {presets.length === 0 && <div className="preset-empty">还没有预设查询，点右上角「＋ 新建查询」创建一个，或「导入」批量导入。</div>}
        <div className="preset-cells">
          {presets.map((p, idx) => {
            const vars = extractVars(p.sql)
            const rem = parseRemarks(p.remarks)
            return (
              <div
                key={p.id}
                className="pcell"
                style={{ animationDelay: `${idx * 40}ms` }}
                title={p.sql}
                onClick={() => clickPreset(p)}
                onContextMenu={e => openMenu(e, [
                  { label: '编辑', action: () => setPresetModal({ ...p }) },
                  { label: '删除', danger: true, action: () => askDelete(`确认删除预设查询「${p.name}」？删除后不可恢复。`, () => delPreset(p)) },
                ])}
              >
                <div className="pcell-name">{p.name}</div>
                <div className="pcell-vars">
                  {vars.length
                    ? vars.map(n => <code key={n}>{rem[n] || n}</code>)
                    : <span className="pcell-direct">直接执行</span>}
                </div>
              </div>
            )
          })}
        </div>

        {showEditor && (
          <>
            <textarea
              className="sql-editor"
              placeholder={selConn ? `在「${selConn.name}」上执行 SQL，支持 $zt / $syd 日期变量，Ctrl+Enter 运行` : '先在左侧选择或新建一个连接…'}
              value={sql}
              onChange={e => setSql(e.target.value)}
              onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') runNow(sql, {}, '自定义 SQL') }}
              spellCheck={false}
            />
            <div className="run-row">
              <button className="btn save" disabled={running || !selConn} onClick={() => runNow(sql, {}, '自定义 SQL')}>
                {running ? '执行中…' : '执行 (Ctrl+Enter)'}
              </button>
              {selConn && (
                <span className="run-conn">
                  {selConn.name} · {selConn.url}
                  {selStatus && selStatus.st === 'run' && <span className="conn-warming"><span className="spin">§</span> 连接中…</span>}
                </span>
              )}
            </div>
          </>
        )}

        {pageErr && <div className="qerr">{pageErr}</div>}
        {curResult && (
          <div className="result-wrap">
            <div className="rtabs" onWheel={e => { e.currentTarget.scrollLeft += e.deltaY }}>
              {results.map(t => (
                <div key={t.key} className={'rtab' + (t.key === curResult.key ? ' on' : '')} onClick={() => setActiveKey(t.key)}>
                  {t.st === 'run' && <span className="spin">§</span>}
                  <span>{t.label}</span>
                  <span className="rtab-x" title="关闭" onClick={e => { e.stopPropagation(); closeTab(t.key) }}>×</span>
                </div>
              ))}
            </div>
            {curResult.st === 'run' && (
              <div className="rtab-loading">
                <span className="spin">§</span>
                <div>正在执行查询…</div>
                <div className="elapsed">已执行 {curResult.elapsed} 秒</div>
              </div>
            )}
            {curResult.st !== 'run' && curResult.r.sqlText && <div className="run-sql" title={curResult.r.sqlText}>{curResult.r.sqlText}</div>}
            {curResult.st !== 'run' && curResult.r.error && <div className="qerr wrap-err">{curResult.r.error}</div>}
            {curResult.st !== 'run' && !curResult.r.error && (curResult.r.updateCount >= 0
              ? <div className="qinfo">执行成功，影响行数：{curResult.r.updateCount} · {curResult.r.elapsedMs}ms</div>
              : (
                <>
                  <div className="result-body">
                    <table className="result">
                      <thead><tr>{curResult.r.columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
                      <tbody>
                        {curResult.r.rows.map((row, i) => (
                          <tr key={i}>{row.map((v, j) => <td key={j}>{v === null ? <span className="null">NULL</span> : v}</td>)}</tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="result-status">
                    {curResult.r.rows.length} 行 · {curResult.r.elapsedMs}ms{curResult.r.truncated ? ' · 已截断（上限 1000 行）' : ''}
                  </div>
                </>
              ))}
          </div>
        )}
      </section>

      {connModal && (
        <div className="mask" onMouseDown={e => e.target === e.currentTarget && setConnModal(null)}>
          <ConnModal
            init={connModal}
            javaInfo={javaInfo}
            onJavaChange={setJavaInfo}
            onClose={() => setConnModal(null)}
            onSave={async (id) => {
              setConnModal(null)
              setConnStatus(t => { const n = { ...t }; delete n[id]; return n })
              await loadConns()
              setSel(id)
            }}
          />
        </div>
      )}
      {presetModal && (
        <div className="mask" onMouseDown={e => e.target === e.currentTarget && setPresetModal(null)}>
          <PresetModal
            init={presetModal}
            onClose={() => setPresetModal(null)}
            onSave={async () => { setPresetModal(null); await loadPresets() }}
          />
        </div>
      )}
      {pickModal && (
        <div className="mask" onMouseDown={e => e.target === e.currentTarget && setPickModal(null)}>
          <PickModal
            title={pickModal.title}
            okText={pickModal.okText}
            items={pickModal.items}
            onClose={() => setPickModal(null)}
            onOk={async (picked) => { setPickModal(null); await pickModal.onOk(picked) }}
          />
        </div>
      )}
      {runPreset && (
        <div className="mask" onMouseDown={e => e.target === e.currentTarget && setRunPreset(null)}>
          <ParamModal
            preset={runPreset}
            values={paramValues}
            onChange={setParamValues}
            running={running}
            connecting={!!selStatus && selStatus.st === 'run'}
            onClose={() => setRunPreset(null)}
            onRun={async () => {
              const p = runPreset
              setRunPreset(null)
              await runNow(p.sql, paramValues, p.name)
            }}
          />
        </div>
      )}
      {menu && (
        <div
          className="ctx"
          style={{
            // 靠近窗口右/下边缘时翻转，避免菜单显示不全
            left: Math.min(menu.x, window.innerWidth - 150),
            top: menu.y + menu.items.length * 34 + 20 > window.innerHeight
              ? Math.max(8, menu.y - menu.items.length * 34 - 12)
              : menu.y,
          }}
          onClick={e => e.stopPropagation()}
          onContextMenu={e => e.preventDefault()}
        >
          {menu.items.map((it, i) => (
            <button key={i} className={it.danger ? 'danger' : ''} onClick={async () => { setMenu(null); await it.action() }}>
              {it.label}
            </button>
          ))}
        </div>
      )}
      {confirm && (
        <div className="mask" onMouseDown={e => e.target === e.currentTarget && setConfirm(null)}>
          <div className="box">
            <h3>确认删除</h3>
            <div className="confirm-text">{confirm.text}</div>
            <div className="actions">
              <span />
              <span>
                <button className="btn" onClick={() => setConfirm(null)}>取消</button>
                <button className="btn del" onClick={async () => { setConfirm(null); await confirm.action() }}>删除</button>
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** 导入/导出勾选弹窗：disabled 项（如重名）不可选 */
function PickModal({ title, okText, items, onClose, onOk }) {
  const [checked, setChecked] = useState(() => new Set(items.filter(i => !i.disabled).map(i => i.key)))
  const toggle = (key) => setChecked(s => {
    const n = new Set(s)
    if (n.has(key)) n.delete(key); else n.add(key)
    return n
  })
  const pickable = items.filter(i => !i.disabled)

  return (
    <div className="box">
      <h3>{title}</h3>
      <div className="pick-bar">
        <span className="pick-count">已选 {checked.size} / {items.length} 条</span>
        <button className="pick-link" onClick={() => setChecked(new Set(pickable.map(i => i.key)))}>全选</button>
        <button className="pick-link" onClick={() => setChecked(new Set())}>清空</button>
      </div>
      <div className="pick-list">
        {items.map(it => (
          <div key={it.key} className={'pick-row' + (it.disabled ? ' disabled' : '')} onClick={() => !it.disabled && toggle(it.key)}>
            <input type="checkbox" disabled={it.disabled} checked={checked.has(it.key)} readOnly />
            <span className="pick-main">
              <span className="pick-name">{it.name}{it.hint ? <em className="pick-hint">{it.hint}</em> : null}</span>
              <span className="pick-sub">{it.sub}</span>
            </span>
          </div>
        ))}
      </div>
      <div className="actions">
        <span />
        <span>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn save" disabled={checked.size === 0} onClick={() => onOk(items.filter(i => checked.has(i.key)))}>
            {okText}（{checked.size}）
          </button>
        </span>
      </div>
    </div>
  )
}
/** 预设执行弹窗：按备注提示输入变量值 */
function ParamModal({ preset, values, onChange, running, connecting, onClose, onRun }) {
  const manualVars = extractVars(preset.sql)
  const legacyParams = extractParams(preset.sql)
  const rem = parseRemarks(preset.remarks)
  const filled = manualVars.filter(n => (values[n] || '').trim() !== '')
  const manualReady = manualVars.length === 0 || filled.length >= 1
  const legacyReady = legacyParams.every(n => (values[n] || '').trim() !== '')
  const canRun = manualReady && legacyReady && !running

  const set = (n, v) => onChange({ ...values, [n]: v })

  return (
    <div className="box">
      <h3>{preset.name}</h3>
      {legacyParams.length > 0 && (
        <div className="pm-hint"><div>旧版 :param 参数需全部填写。</div></div>
      )}
      {manualVars.map(n => (
        <label key={n} className="pm-field">
          <span className="pm-label">{rem[n] || n}</span>
          <input
            className="finput mono"
            value={values[n] || ''}
            placeholder="留空则忽略该条件"
            autoFocus={n === manualVars[0]}
            onChange={e => set(n, e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && canRun) onRun() }}
          />
        </label>
      ))}
      {legacyParams.map(n => (
        <label key={n} className="pm-field">
          <span className="pm-label">{rem[n] || n}<code>:{n}</code></span>
          <input
            className="finput mono"
            value={values[n] || ''}
            onChange={e => set(n, e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && canRun) onRun() }}
          />
        </label>
      ))}
      {!manualReady && <div className="pm-warn">请至少填写一个查询条件</div>}
      <div className="actions">
        <span className="pm-conn">{connecting && <><span className="spin">§</span> 连接中…</>}</span>
        <span>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn save" disabled={!canRun} onClick={onRun}>{running ? '查询中…' : '查询'}</button>
        </span>
      </div>
    </div>
  )
}

function JavaBanner({ onReady }) {
  const [path, setPath] = useState('')
  const [err, setErr] = useState('')
  return (
    <div className="java-banner">
      <span>未检测到 Java 运行时，请手动指定 java.exe 路径：</span>
      <input value={path} onChange={e => setPath(e.target.value)} placeholder="C:\Program Files\...\bin\java.exe" />
      <button onClick={async () => {
        try { await invoke('set_java_path', { path }); onReady({ path, auto: false }); setErr('') }
        catch (e) { setErr(String(e)) }
      }}>保存</button>
      {err && <span className="java-err">{err}</span>}
    </div>
  )
}

function ConnModal({ init, javaInfo, onJavaChange, onClose, onSave }) {
  const [f, setF] = useState({ ...init })
  const [err, setErr] = useState('')
  const [javaPath, setJavaPath] = useState('')
  const [testSt, setTestSt] = useState(null) // null | {st:'run'|'ok'|'err', msg}
  const set = (k, v) => setF(x => ({ ...x, [k]: v }))
  const incomplete = !f.name.trim() || !f.jar || !f.url.trim()

  const test = async () => {
    setTestSt({ st: 'run', msg: '连接中' })
    const r = await invoke('test_connection', { jar: f.jar, url: f.url.trim(), user: f.user, password: f.password })
    setTestSt(r.ok
      ? { st: 'ok', msg: `连接成功${r.info ? ' · ' + r.info : ''} · ${r.elapsedMs}ms` }
      : { st: 'err', msg: r.error || '连接失败' })
  }

  const pickJar = async () => {
    const p = await invoke('pick_jar')
    if (p) set('jar', p)
  }

  const save = async () => {
    try {
      const id = await invoke('save_connection', {
        id: f.id ?? null,
        name: f.name.trim(), jar: f.jar, url: f.url.trim(), user: f.user, password: f.password,
      })
      onSave(id)
    } catch (e) { setErr(String(e)) }
  }

  return (
    <div className="box">
      <h3>{f.id ? '编辑连接' : '新建连接'}</h3>
      <label>名称</label>
      <input className="finput" value={f.name} onChange={e => set('name', e.target.value)} placeholder="例如：核心库-生产" />
      <label>驱动 jar</label>
      <div className="jar-row">
        <span className={f.jar ? 'jar-name' : 'jar-name empty'}>{f.jar ? base(f.jar) : '未选择'}</span>
        <button className="btn" onClick={pickJar}>选择 jar…</button>
      </div>
      <label>连接 URL</label>
      <input className="finput mono" value={f.url} onChange={e => set('url', e.target.value)} placeholder="jdbc:mysql://host:3306/db" />
      <label>用户名</label>
      <input className="finput" value={f.user} onChange={e => set('user', e.target.value)} />
      <label>密码</label>
      <input className="finput" type="password" value={f.password} onChange={e => set('password', e.target.value)} />
      <div className="java-line">
        {!javaInfo
          ? <span className="java-ok">Java：检测中…</span>
          : javaInfo.path
          ? <span className="java-ok">Java：{javaInfo.path}{javaInfo.auto ? '（自动探测）' : '（手动指定）'}</span>
          : <span className="java-err">未检测到 Java，请指定：
              <input value={javaPath} onChange={e => setJavaPath(e.target.value)} placeholder="…\bin\java.exe" />
              <button onClick={async () => {
                try { await invoke('set_java_path', { path: javaPath }); onJavaChange({ path: javaPath, auto: false }) }
                catch (e) { setErr(String(e)) }
              }}>保存</button>
            </span>}
      </div>
      {err && <div className="err">{err}</div>}
      <div className="actions">
        <span className="test-area">
          <button className="btn" disabled={!f.jar || !f.url.trim() || (testSt && testSt.st === 'run')} onClick={test}>
            测试连接
          </button>
          {testSt && (
            <span className={'cc-status ' + testSt.st}>
              {testSt.st === 'run' && <span className="spin">§</span>}
              {testSt.st === 'ok' && '✓ '}
              {testSt.st === 'err' && '✗ '}
              {testSt.msg}
            </span>
          )}
        </span>
        <span>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn save" disabled={incomplete} onClick={save}>保存</button>
        </span>
      </div>
    </div>
  )
}

function PresetModal({ init, onClose, onSave }) {
  const [name, setName] = useState(init.name)
  const [sql, setSql] = useState(init.sql)
  const [remarks, setRemarks] = useState(() => parseRemarks(init.remarks))
  const [err, setErr] = useState('')
  const incomplete = !name.trim() || !sql.trim()
  const vars = extractVars(sql)
  const legacy = extractParams(sql)
  const hasDate = /\$(zt|syd)\b/.test(sql)

  const save = async () => {
    try {
      // 只保留当前 SQL 中仍存在的变量备注
      const kept = {}
      for (const n of [...vars, ...legacy]) if ((remarks[n] || '').trim()) kept[n] = remarks[n].trim()
      await invoke('save_preset', { id: init.id ?? null, name: name.trim(), sql, remarks: JSON.stringify(kept) })
      onSave()
    } catch (e) { setErr(String(e)) }
  }

  return (
    <div className="box">
      <h3>{init.id ? '编辑查询' : '新建查询'}</h3>
      <label>查询名称</label>
      <input className="finput" value={name} onChange={e => setName(e.target.value)} placeholder="例如：按客户查存款" />
      <label>SQL（变量写作 '$name'，执行时未填的条件自动忽略）</label>
      <textarea
        className="finput mono"
        rows={6}
        value={sql}
        onChange={e => setSql(e.target.value)}
        spellCheck={false}
        placeholder={"SELECT * FROM core.kehu\nWHERE cust_no = '$cust_no' AND cust_name LIKE '%$cust_name%' AND rq = $zt"}
      />
      {vars.length > 0 && (
        <div className="vr-box">
          <div className="vr-title">检测到 {vars.length} 个变量，可为每个变量备注含义：</div>
          {vars.map(n => (
            <div key={n} className="vr-row">
              <code>${n}</code>
              <input
                value={remarks[n] || ''}
                placeholder="含义备注，如：客户号"
                onChange={e => setRemarks(r => ({ ...r, [n]: e.target.value }))}
              />
            </div>
          ))}
        </div>
      )}
      {legacy.length > 0 && (
        <div className="hint">兼容旧语法，将生成 {legacy.length} 个必填参数：{legacy.map(n => ':' + n).join('、')}</div>
      )}
      {hasDate && <div className="hint">已使用日期变量 $zt / $syd，执行时自动注入（昨天 / 上月底）。</div>}
      {err && <div className="err">{err}</div>}
      <div className="actions">
        <span />
        <span>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn save" disabled={incomplete} onClick={save}>保存</button>
        </span>
      </div>
    </div>
  )
}
