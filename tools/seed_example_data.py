# -*- coding: utf-8 -*-
"""往 sql_clipboard.db 追加 40 行银行业务数据"""
import sqlite3

DB = r"D:\Document\code\sql-smart\便携版\sql_clipboard.db"

TABLES = [
    ("【每日】贷款", "core.daikuan"),
    ("【全量】存款", "core.cunkuan_qs"),
    ("【全量】贷款", "core.daikuan_qs"),
    ("【每日】存款日均", "core.cunkuan_rj"),
    ("【每日】贷款日均", "core.daikuan_rj"),
    ("城乡两费签约", "core.cxlf_qy"),
    ("城乡两费批扣", "core.cxlf_pk"),
    ("城乡两费缴费", "core.cxlf_jf"),
    ("【每日】客户", "core.kehu"),
    ("【全量】客户", "core.kehu_qs"),
    ("【每日】机构", "core.jigou"),
    ("【每日】柜员", "core.guiyuan"),
    ("【每日】账户", "core.zhanghu"),
    ("【每日】交易流水", "core.liushui"),
    ("【每日】大额交易", "core.dae_jy"),
    ("【每日】理财", "core.licai"),
    ("【全量】理财", "core.licai_qs"),
    ("【每日】理财持仓", "core.licai_cc"),
    ("【每日】基金", "core.jijin"),
    ("【每日】贵金属", "core.guijinshu"),
    ("【每日】银行卡", "core.yinhangka"),
    ("【每日】信用卡", "core.xinyongka"),
    ("【每日】手机银行", "core.shoujiyh"),
    ("【每日】网上银行", "core.wangyin"),
    ("【每日】微信银行", "core.weixinyh"),
    ("【每日】收单", "core.shoudan"),
    ("【每日】商户", "core.shanghu"),
    ("【每日】ATM交易", "core.atm_jy"),
    ("【每日】柜面交易", "core.guimian_jy"),
    ("【每日】代发工资", "core.daifa_gz"),
    ("【每日】代扣业务", "core.daikou"),
    ("【每日】社保", "core.shebao"),
    ("【每日】医保", "core.yibao"),
    ("【每日】公积金", "core.gongjijin"),
    ("【每日】票据", "core.piaoju"),
    ("【每日】同业", "core.tongye"),
    ("【每日】国际结算", "core.guoji_js"),
    ("【每日】授信", "core.shouxin"),
    ("【每日】担保", "core.danbao"),
    ("【每日】反洗钱", "core.fanxiqian"),
]

QUERIES = [
    ("查今天",   "SELECT * FROM {t} WHERE rq = $jt;"),
    ("查昨天",   "SELECT * FROM {t} WHERE rq = $zt;"),
    ("查上月",   "SELECT * FROM {t} WHERE rq BETWEEN $sy AND $syz;"),
    ("查去年底", "SELECT * FROM {t} WHERE rq = $qnd;"),
    ("去年今天", "SELECT * FROM {t} WHERE rq = $qnt;"),
]

conn = sqlite3.connect(DB)
start = conn.execute('SELECT COALESCE(MAX("row"), -1) + 1 FROM cells').fetchone()[0]
cur = conn.cursor()
for i, (definition, table) in enumerate(TABLES):
    r = start + i
    cur.execute('INSERT INTO cells ("row", col, display, copy) VALUES (?, 0, ?, ?)', (r, definition, ""))
    cur.execute('INSERT INTO cells ("row", col, display, copy) VALUES (?, 1, ?, ?)', (r, table, table))
    for j, (label, sql) in enumerate(QUERIES):
        cur.execute('INSERT INTO cells ("row", col, display, copy) VALUES (?, ?, ?, ?)',
                    (r, 2 + j, label, sql.format(t=table)))
conn.commit()
total = conn.execute("SELECT COUNT(*) FROM cells").fetchone()[0]
print(f"已追加 {len(TABLES)} 行（行号 {start} ~ {start + len(TABLES) - 1}），库中共 {total} 个单元格")