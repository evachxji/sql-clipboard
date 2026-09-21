import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

const base = p => (p || '').split(/[\\/]/).pop()

/** 从 SQL 提取命名参数 :name（跳过单引号字符串），去重保序 */
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

export default function QueryPage() {
  const [conns, setConns] = useState([])
  const [sel, setSel] = useState(null)
  const [modal, setModal] = useState(null) // 连接编辑 {id?,name,jar,url,user,password}
  const [javaInfo, setJavaInfo] = useState(null) // null=检测中
  const [testing, setTesting] = useState({})
  const [sql, setSql] = useState('')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState(null)
  const [presets, setPresets] = useState([])
  const [activePreset, setActivePreset] = useState(null) // preset 对象
  const [paramValues, setParamValues] = useState({})
  const [presetModal, setPresetModal] = useState(null) // {id?,name,sql}
  const [showEditor, setShowEditor] = useState(false)
  const [importMsg, setImportMsg] = useState('')

  const loadConns = useCallback(async () => {
    try {
      const list = await invoke('list_connections')
      setConns(list)
      if (list.length && !list.some(c => c.id === sel)) setSel(list[0].id)
    } catch (e) { setResult({ error: 'list_connections 失败: ' + String(e) }) }
  }, [sel])

  const loadPresets = useCallback(async () => {
    try { setPresets(await invoke('list_presets')) }
    catch (e) { setResult({ error: 'list_presets 失败: ' + String(e) }) }
  }, [])

  useEffect(() => {
    loadConns()
    loadPresets()
    invoke('get_java_info').then(setJavaInfo).catch(e => setResult({ error: 'get_java_info 失败: ' + String(e) }))
  }, []) // eslint-disable-line

  const test = async (c) => {
    setTesting(t => ({ ...t, [c.id]: { st: 'run', msg: '测试中…' } }))
    const r = await invoke('test_connection', { jar: c.jar, url: c.url, user: c.user, password: c.password })
    setTesting(t => ({
      ...t,
      [c.id]: r.ok ? { st: 'ok', msg: `✓ ${r.elapsedMs}ms` } : { st: 'err', msg: '✗ ' + (r.error || '连接失败') },
    }))
  }

  const del = async (c) => {
    await invoke('delete_connection', { id: c.id })
    await loadConns()
  }

  const importPresets = async () => {
    try {
      const n = await invoke('import_presets')
      if (n > 0) {
        setImportMsg(`已导入 ${n} 条`)
        await loadPresets()
      } else setImportMsg('未导入')
      setTimeout(() => setImportMsg(''), 2500)
    } catch (e) {
      setImportMsg(String(e))
      setTimeout(() => setImportMsg(''), 4000)
    }
  }

  const clickPreset = (p) => {
    setActivePreset(p)
    setParamValues({})
    setResult(null)
  }

  const run = async (sqlText, params) => {
    const c = conns.find(x => x.id === sel)
    if (!c) { setResult({ error: '请先在左侧选择或新建一个连接' }); return }
    if (!sqlText.trim()) { setResult({ error: '请输入要执行的 SQL' }); return }
    setRunning(true)
    setResult(null)
    const r = await invoke('execute_query', { jar: c.jar, url: c.url, user: c.user, password: c.password, sql: sqlText, params: params || null })
    setResult(r)
    setRunning(false)
  }

  const selConn = conns.find(x => x.id === sel)
  const activeParams = activePreset ? extractParams(activePreset.sql) : []
  const paramsReady = activeParams.every(n => (paramValues[n] || '').trim() !== '')

  return (
    <div className="qwrap">
      <aside className="qside">
        <button className="qnew" onClick={() => setModal({ name: '', jar: '', url: '', user: '', password: '' })}>＋ 新建连接</button>
        {conns.length === 0 && <div className="qside-empty">还没有连接配置</div>}
        {conns.map(c => (
          <div key={c.id} className={sel === c.id ? 'conn-card on' : 'conn-card'} onClick={() => setSel(c.id)}>
            <div className="cc-name">{c.name}</div>
            <div className="cc-url" title={c.url}>{c.url}</div>
            <div className="cc-jar" title={c.jar}>{base(c.jar)}</div>
            <div className="cc-btns" onClick={e => e.stopPropagation()}>
              <button onClick={() => test(c)}>测试</button>
              <button onClick={() => setModal({ ...c })}>编辑</button>
              <button className="danger" onClick={() => del(c)}>删除</button>
            </div>
            {testing[c.id] && <div className={'cc-status ' + testing[c.id].st}>{testing[c.id].msg}</div>}
          </div>
        ))}
      </aside>

      <section className="qmain">
        {javaInfo && !javaInfo.path && <JavaBanner onReady={setJavaInfo} />}

        <div className="preset-head">
          <span className="sec-title">预设查询</span>
          <span className="sec-actions">
            <button className="mini-btn" onClick={() => setPresetModal({ name: '', sql: '' })}>＋ 新建</button>
            <button className="mini-btn" onClick={importPresets}>导入</button>
            {importMsg && <span className="import-msg">{importMsg}</span>}
          </span>
        </div>
        {presets.length === 0 && <div className="preset-empty">还没有预设 SQL，点「导入」批量导入，或「＋ 新建」单条创建。</div>}
        <div className="preset-chips">
          {presets.map(p => (
            <span key={p.id} className={activePreset && activePreset.id === p.id ? 'pchip on' : 'pchip'} title={p.sql}>
              <span className="pchip-name" onClick={() => clickPreset(p)}>{p.name}</span>
              <span className="pchip-ops">
                <i title="编辑" onClick={() => setPresetModal({ ...p })}>✎</i>
                <i title="删除" onClick={async () => { await invoke('delete_preset', { id: p.id }); if (activePreset && activePreset.id === p.id) setActivePreset(null); await loadPresets() }}>✕</i>
              </span>
            </span>
          ))}
        </div>

        {activePreset && (
          <div className="param-form">
            <div className="pf-title">{activePreset.name}</div>
            {activeParams.map(n => (
              <label key={n} className="pf-field">
                <span>:{n}</span>
                <input
                  value={paramValues[n] || ''}
                  onChange={e => setParamValues(v => ({ ...v, [n]: e.target.value }))}
                  onKeyDown={e => { if (e.key === 'Enter' && paramsReady) run(activePreset.sql, paramValues) }}
                />
              </label>
            ))}
            <button
              className="btn save"
              disabled={running || !selConn || !paramsReady}
              onClick={() => run(activePreset.sql, paramValues)}
            >{running ? '执行中…' : '执行'}</button>
            {!selConn && <span className="pf-hint">先在左侧选择连接</span>}
          </div>
        )}

        <div className="editor-toggle" onClick={() => setShowEditor(s => !s)}>
          自定义 SQL {showEditor ? '▾' : '▸'}
        </div>
        {showEditor && (
          <>
            <textarea
              className="sql-editor"
              placeholder={selConn ? `在「${selConn.name}」上执行 SQL，Ctrl+Enter 运行` : '先在左侧选择或新建一个连接…'}
              value={sql}
              onChange={e => setSql(e.target.value)}
              onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') run(sql, null) }}
              spellCheck={false}
            />
            <div className="run-row">
              <button className="btn save" disabled={running || !selConn} onClick={() => run(sql, null)}>
                {running ? '执行中…' : '执行 (Ctrl+Enter)'}
              </button>
              {selConn && <span className="run-conn">{selConn.name} · {selConn.url}</span>}
            </div>
          </>
        )}

        {result && result.error && <div className="qerr">{result.error}</div>}
        {result && !result.error && result.updateCount >= 0 && (
          <div className="qinfo">执行成功，影响行数：{result.updateCount} · {result.elapsedMs}ms</div>
        )}
        {result && !result.error && result.updateCount < 0 && (
          <div className="result-wrap">
            <table className="result">
              <thead><tr>{result.columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
              <tbody>
                {result.rows.map((r, i) => (
                  <tr key={i}>{r.map((v, j) => <td key={j}>{v === null ? <span className="null">NULL</span> : v}</td>)}</tr>
                ))}
              </tbody>
            </table>
            <div className="result-status">
              {result.rows.length} 行 · {result.elapsedMs}ms{result.truncated ? ' · 已截断（上限 1000 行）' : ''}
            </div>
          </div>
        )}
      </section>

      {modal && (
        <div className="mask" onMouseDown={e => e.target === e.currentTarget && setModal(null)}>
          <ConnModal
            init={modal}
            javaInfo={javaInfo}
            onJavaChange={setJavaInfo}
            onClose={() => setModal(null)}
            onSave={async () => { setModal(null); await loadConns() }}
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
  const set = (k, v) => setF(x => ({ ...x, [k]: v }))
  const incomplete = !f.name.trim() || !f.jar || !f.url.trim()

  const pickJar = async () => {
    const p = await invoke('pick_jar')
    if (p) set('jar', p)
  }

  const save = async () => {
    try {
      await invoke('save_connection', {
        id: f.id ?? null,
        name: f.name.trim(), jar: f.jar, url: f.url.trim(), user: f.user, password: f.password,
      })
      onSave()
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
        <span />
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
  const [err, setErr] = useState('')
  const incomplete = !name.trim() || !sql.trim()
  const params = extractParams(sql)

  const save = async () => {
    try {
      await invoke('save_preset', { id: init.id ?? null, name: name.trim(), sql })
      onSave()
    } catch (e) { setErr(String(e)) }
  }

  return (
    <div className="box">
      <h3>{init.id ? '编辑预设' : '新建预设'}</h3>
      <label>按钮名称</label>
      <input className="finput" value={name} onChange={e => setName(e.target.value)} placeholder="例如：查用户信息" />
      <label>SQL（命名参数 :param，日期变量 $zt / $syd）</label>
      <textarea
        className="finput mono"
        rows={6}
        value={sql}
        onChange={e => setSql(e.target.value)}
        spellCheck={false}
        placeholder="SELECT * FROM core.kehu WHERE cust_no = :cust_no"
      />
      {params.length > 0 && (
        <div className="hint">将生成 {params.length} 个条件输入框：{params.map(n => ':' + n).join('、')}</div>
      )}
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