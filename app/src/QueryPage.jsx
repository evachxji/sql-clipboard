import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

const base = p => (p || '').split(/[\\/]/).pop()

export default function QueryPage() {
  const [conns, setConns] = useState([])
  const [sel, setSel] = useState(null)
  const [modal, setModal] = useState(null) // {id?,name,jar,url,user,password}
  const [javaInfo, setJavaInfo] = useState(null) // null=检测中
  const [testing, setTesting] = useState({}) // id -> {st:'run'|'ok'|'err', msg}
  const [sql, setSql] = useState('')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState(null)

  const loadConns = useCallback(async () => {
    try {
      const list = await invoke('list_connections')
      setConns(list)
      if (list.length && !list.some(c => c.id === sel)) setSel(list[0].id)
    } catch (e) { setResult({ error: 'list_connections 失败: ' + String(e) }) }
  }, [sel])
  useEffect(() => {
    loadConns()
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

  const run = async () => {
    const c = conns.find(x => x.id === sel)
    if (!c) { setResult({ error: '请先在左侧选择或新建一个连接' }); return }
    if (!sql.trim()) { setResult({ error: '请输入要执行的 SQL' }); return }
    setRunning(true)
    setResult(null)
    const r = await invoke('execute_query', { jar: c.jar, url: c.url, user: c.user, password: c.password, sql })
    setResult(r)
    setRunning(false)
  }

  const selConn = conns.find(x => x.id === sel)

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
        <textarea
          className="sql-editor"
          placeholder={selConn ? `在「${selConn.name}」上执行 SQL，Ctrl+Enter 运行` : '先在左侧选择或新建一个连接…'}
          value={sql}
          onChange={e => setSql(e.target.value)}
          onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') run() }}
          spellCheck={false}
        />
        <div className="run-row">
          <button className="btn save" disabled={running || !selConn} onClick={run}>
            {running ? '执行中…' : '执行 (Ctrl+Enter)'}
          </button>
          {selConn && <span className="run-conn">{selConn.name} · {selConn.url}</span>}
        </div>

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