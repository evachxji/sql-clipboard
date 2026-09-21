import java.io.*;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.sql.*;
import java.util.*;

/**
 * JDBC 桥接进程：stdin/stdout 按行收发 JSON。
 * 请求:  {"cmd":"test","id":1,"jar":"...","url":"...","user":"...","password":"..."}
 *        {"cmd":"query","id":2,"jar":...,"url":...,"user":...,"password":...,"sql":"...","maxRows":1000}
 * 响应:  {"id":1,"ok":true,"elapsedMs":12,"error":null}
 *        {"id":2,"ok":true,"columns":[...],"rows":[[...]],"truncated":false,"updateCount":-1,"elapsedMs":5,"error":null}
 */
public class JdbcBridge {
    private static final Map<String, Connection> POOL = new HashMap<>();       // url + user 缓存连接
    private static final Set<String> REGISTERED = new HashSet<>();             // 已注册驱动的 jar

    public static void main(String[] args) throws Exception {
        DriverManager.setLoginTimeout(30);
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        PrintWriter out = new PrintWriter(new OutputStreamWriter(System.out, StandardCharsets.UTF_8), true);
        String line;
        while ((line = in.readLine()) != null) {
            line = line.trim();
            if (line.isEmpty()) continue;
            Map<String, Object> resp = new LinkedHashMap<>();
            try {
                @SuppressWarnings("unchecked")
                Map<String, Object> req = (Map<String, Object>) Json.parse(line);
                resp.put("id", req.get("id"));
                long t0 = System.currentTimeMillis();
                String cmd = str(req.get("cmd"));
                if ("test".equals(cmd)) {
                    doTest(req, resp);
                } else if ("query".equals(cmd)) {
                    doQuery(req, resp);
                } else {
                    resp.put("ok", false);
                    resp.put("error", "unknown cmd: " + cmd);
                }
                resp.put("elapsedMs", System.currentTimeMillis() - t0);
            } catch (Throwable e) {
                resp.put("ok", false);
                resp.put("error", err(e));
            }
            out.println(Json.stringify(resp));
        }
    }

    /** 测试连通性：建连即关 */
    private static void doTest(Map<String, Object> req, Map<String, Object> resp) throws Exception {
        ensureDriver(str(req.get("jar")));
        try (Connection c = DriverManager.getConnection(str(req.get("url")), str(req.get("user")), str(req.get("password")))) {
            resp.put("ok", c.isValid(5));
        }
    }

    /** 执行 SQL：复用连接；SELECT 返回结果集，其余返回影响行数 */
    private static void doQuery(Map<String, Object> req, Map<String, Object> resp) throws Exception {
        ensureDriver(str(req.get("jar")));
        String url = str(req.get("url")), user = str(req.get("user"));
        int maxRows = req.get("maxRows") instanceof Number ? ((Number) req.get("maxRows")).intValue() : 1000;
        String key = url + "" + user;
        Connection conn = POOL.get(key);
        if (conn == null || conn.isClosed() || !conn.isValid(3)) {
            conn = DriverManager.getConnection(url, user, str(req.get("password")));
            POOL.put(key, conn);
        }
        try (Statement st = conn.createStatement()) {
            st.setQueryTimeout(30);
            boolean isRs = st.execute(str(req.get("sql")));
            if (isRs) {
                try (ResultSet rs = st.getResultSet()) {
                    ResultSetMetaData md = rs.getMetaData();
                    int n = md.getColumnCount();
                    List<Object> cols = new ArrayList<>();
                    for (int i = 1; i <= n; i++) cols.add(md.getColumnLabel(i));
                    List<Object> rows = new ArrayList<>();
                    while (rows.size() < maxRows && rs.next()) {
                        List<Object> row = new ArrayList<>();
                        for (int i = 1; i <= n; i++) {
                            Object v = rs.getObject(i);
                            row.add(v == null ? null : String.valueOf(v));
                        }
                        rows.add(row);
                    }
                    resp.put("columns", cols);
                    resp.put("rows", rows);
                    resp.put("truncated", rs.next()); // 还有下一条说明被截断
                    resp.put("updateCount", -1);
                }
            } else {
                resp.put("columns", Collections.emptyList());
                resp.put("rows", Collections.emptyList());
                resp.put("truncated", false);
                resp.put("updateCount", st.getUpdateCount());
            }
            resp.put("ok", true);
        }
    }

    /** 加载 jar 并通过 DriverShim 注册驱动（每个 jar 只注册一次） */
    private static void ensureDriver(String jarPath) throws Exception {
        if (REGISTERED.contains(jarPath)) return;
        File jar = new File(jarPath);
        if (!jar.isFile()) throw new SQLException("驱动 jar 不存在: " + jarPath);
        URLClassLoader cl = new URLClassLoader(new URL[]{jar.toURI().toURL()}, JdbcBridge.class.getClassLoader());
        Driver found = null;
        for (Driver d : ServiceLoader.load(Driver.class, cl)) { found = d; break; }
        if (found == null) throw new SQLException("jar 中未找到 JDBC 驱动: " + jarPath);
        DriverManager.registerDriver(new DriverShim(found));
        REGISTERED.add(jarPath);
    }

    private static String str(Object o) { return o == null ? "" : String.valueOf(o); }
    private static String err(Throwable e) {
        String m = e.getMessage();
        return e.getClass().getSimpleName() + (m == null ? "" : ": " + m);
    }

    /** 驱动代理：绕过 DriverManager 的类加载器可见性限制 */
    static class DriverShim implements Driver {
        private final Driver d;
        DriverShim(Driver d) { this.d = d; }
        public Connection connect(String u, Properties p) throws SQLException { return d.connect(u, p); }
        public boolean acceptsURL(String u) throws SQLException { return d.acceptsURL(u); }
        public DriverPropertyInfo[] getPropertyInfo(String u, Properties p) throws SQLException { return d.getPropertyInfo(u, p); }
        public int getMajorVersion() { return d.getMajorVersion(); }
        public int getMinorVersion() { return d.getMinorVersion(); }
        public boolean jdbcCompliant() { return d.jdbcCompliant(); }
        public java.util.logging.Logger getParentLogger() { return null; }
    }

    /** 零依赖 JSON 解析/序列化（仅支持本协议子集） */
    static class Json {
        static Object parse(String s) { return new Json(s).value(); }
        private final String s; private int i;
        Json(String s) { this.s = s; }
        private void ws() { while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++; }
        private Object value() {
            ws();
            char c = s.charAt(i);
            if (c == '{') { Map<String, Object> m = new LinkedHashMap<>(); i++; ws();
                if (s.charAt(i) == '}') { i++; return m; }
                while (true) { ws(); String k = (String) value(); ws(); i++; m.put(k, value()); ws();
                    char d = s.charAt(i++); if (d == '}') return m; } }
            if (c == '[') { List<Object> l = new ArrayList<>(); i++; ws();
                if (s.charAt(i) == ']') { i++; return l; }
                while (true) { l.add(value()); ws(); char d = s.charAt(i++); if (d == ']') return l; } }
            if (c == '"') { StringBuilder b = new StringBuilder(); i++;
                while (true) { char ch = s.charAt(i++);
                    if (ch == '"') return b.toString();
                    if (ch == '\\') { char e = s.charAt(i++);
                        switch (e) { case 'n': b.append('\n'); break; case 't': b.append('\t'); break;
                            case 'r': b.append('\r'); break; case 'b': b.append('\b'); break; case 'f': b.append('\f'); break;
                            case 'u': b.append((char) Integer.parseInt(s.substring(i, i + 4), 16)); i += 4; break;
                            default: b.append(e); } }
                    else b.append(ch); } }
            if (c == 't') { i += 4; return Boolean.TRUE; }
            if (c == 'f') { i += 5; return Boolean.FALSE; }
            if (c == 'n') { i += 4; return null; }
            int j = i;
            while (i < s.length() && "-+0123456789.eE".indexOf(s.charAt(i)) >= 0) i++;
            String num = s.substring(j, i);
            return num.contains(".") || num.contains("e") || num.contains("E")
                    ? (Object) Double.parseDouble(num) : (Object) Long.parseLong(num);
        }
        static String stringify(Object o) {
            StringBuilder b = new StringBuilder();
            write(b, o);
            return b.toString();
        }
        @SuppressWarnings("unchecked")
        private static void write(StringBuilder b, Object o) {
            if (o == null) { b.append("null"); return; }
            if (o instanceof String) { b.append('"');
                for (char c : ((String) o).toCharArray()) {
                    switch (c) { case '"': b.append("\\\""); break; case '\\': b.append("\\\\"); break;
                        case '\n': b.append("\\n"); break; case '\r': b.append("\\r"); break; case '\t': b.append("\\t"); break;
                        default: if (c < 0x20) b.append(String.format("\\u%04x", (int) c)); else b.append(c); } }
                b.append('"'); return; }
            if (o instanceof Map) { b.append('{'); boolean first = true;
                for (Map.Entry<String, Object> e : ((Map<String, Object>) o).entrySet()) {
                    if (!first) b.append(','); first = false;
                    write(b, e.getKey()); b.append(':'); write(b, e.getValue()); }
                b.append('}'); return; }
            if (o instanceof Collection) { b.append('['); boolean first = true;
                for (Object v : (Collection<Object>) o) { if (!first) b.append(','); first = false; write(b, v); }
                b.append(']'); return; }
            b.append(o);
        }
    }
}