"""
金钱剪刀 · 学员汇总刷新脚本
运行方式：双击「刷新汇总.command」，或在终端执行 python3 update_summary.py
"""

import json, subprocess, urllib.request, ssl
from collections import defaultdict

# ── 配置 ──────────────────────────────────────────────
APP_ID     = "cli_a9418569aaf8dbcb"
APP_SECRET = "rcQGwaS2orrHbD9JTqxyUgJKEKvu4Pn0"
SHEET_TOKEN   = "IGvxshnkKhr7NJt3gGaccScznCh"   # 金钱剪刀接单 表格
SOURCE_SHEET  = "8d3da7"   # 派单明细 sheet
SUMMARY_SHEET = "1M6gta"   # 学员汇总 sheet

# ── 工具函数 ──────────────────────────────────────────
ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

TOKEN = ""  # 获取 token 后赋值

def api(method, path, body=None):
    url = f"https://open.feishu.cn{path}"
    data = json.dumps(body, ensure_ascii=False).encode() if body else None
    req = urllib.request.Request(url, data=data, method=method,
          headers={"Authorization": f"Bearer {TOKEN}",
                   "Content-Type": "application/json"})
    with urllib.request.urlopen(req, context=ctx) as r:
        return json.loads(r.read())

def get_text(cell):
    if isinstance(cell, list):
        return "".join(c.get("text", "") for c in cell if isinstance(c, dict)).strip()
    return str(cell).strip() if cell is not None else ""

def get_num(cell):
    try: return float(get_text(cell)) if cell else 0
    except: return 0

# ── 1. 获取 Token ─────────────────────────────────────
print("正在获取飞书授权...")
resp = api("POST", "/open-apis/auth/v3/app_access_token/internal",
           {"app_id": APP_ID, "app_secret": APP_SECRET})
TOKEN = resp["app_access_token"]
print("✅ 授权成功")

# ── 2. 读取派单明细 ───────────────────────────────────
print("正在读取派单数据...")
resp = api("GET", f"/open-apis/sheets/v2/spreadsheets/{SHEET_TOKEN}/values/{SOURCE_SHEET}!A1:P200")
rows = resp.get("data", {}).get("valueRange", {}).get("values", [])
print(f"✅ 读取到 {len(rows)-1} 行数据")

# ── 3. 计算汇总 ───────────────────────────────────────
# 名字归一化：同一个人用不同名字填写时，统一合并
NAME_MAP = {
    "叶青(马克图布)": "叶青",
    "椰子(Ue)": "Ue椰子",
    "楠少师兄": "楠少",   # 如不是同一人请删掉这行
}

def normalize(name):
    return NAME_MAP.get(name, name)

students = defaultdict(lambda: {"orders": 0, "earnings": 0, "points": 0})
total_orders = 0
completed_orders = 0

for row in rows[1:]:
    if not row or not any(row):
        continue
    while len(row) < 16:
        row.append(None)

    price     = get_num(row[1])
    completed = get_num(row[4])
    title     = get_text(row[2])

    if not price and not title:
        continue  # 空行跳过

    total_orders += 1
    if completed == 1:
        completed_orders += 1

    # 第一位、第二位、第三位抢单：(名字列, 积分列)
    for name_col, pts_col in [(7, 9), (10, 12), (13, 15)]:
        name = normalize(get_text(row[name_col]).strip()) if name_col < len(row) else ""
        if name and name not in ("None", ""):
            pts = get_num(row[pts_col]) if pts_col < len(row) else 0
            students[name]["orders"]   += 1
            students[name]["earnings"] += price
            students[name]["points"]   += pts

completion_rate = f"{completed_orders / total_orders * 100:.1f}" if total_orders else "0"

# ── 4. 构建写入数据 ──────────────────────────────────
ranked = sorted(students.items(), key=lambda x: x[1]["earnings"], reverse=True)

values = [
    ["排名", "学员名", "接单数", "总收入(元)", "总积分"],
    ["", "", "", "", ""],
    ["概览", "总单数", "已完成", "完成率(%)", ""],
    ["", str(total_orders), str(completed_orders), completion_rate, ""],
    ["", "", "", "", ""],
]
for i, (name, s) in enumerate(ranked, 1):
    values.append([str(i), name, str(s["orders"]),
                   str(int(s["earnings"])), str(int(s["points"]))])

# ── 5. 写入飞书汇总表 ────────────────────────────────
print("正在写入飞书汇总表...")
end_row = len(values)
resp = api("PUT", f"/open-apis/sheets/v2/spreadsheets/{SHEET_TOKEN}/values", {
    "valueRange": {
        "range": f"{SUMMARY_SHEET}!A1:E{end_row}",
        "values": values
    }
})
if resp.get("code") != 0:
    print(f"❌ 飞书写入失败：{resp}")

# ── 6. 生成 data.json（排行榜网页读这个）────────────
import os, datetime
data_json = {
    "updated_at": datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
    "overview": {
        "total_orders": total_orders,
        "completed_orders": completed_orders,
        "completion_rate": float(completion_rate),
        "student_count": len(ranked),
    },
    "ranking": [
        {
            "rank": i,
            "name": name,
            "orders": s["orders"],
            "earnings": int(s["earnings"]),
            "points": int(s["points"]),
        }
        for i, (name, s) in enumerate(ranked, 1)
    ]
}
json_path = os.path.join(os.path.dirname(__file__), "data.json")
with open(json_path, "w", encoding="utf-8") as f:
    json.dump(data_json, f, ensure_ascii=False, indent=2)

print(f"\n✅ 汇总更新完成！")
print(f"   总单数：{total_orders}  已完成：{completed_orders}  完成率：{completion_rate}%")
print(f"   学员人数：{len(ranked)}")
print(f"\n排行榜 TOP5：")
for i, (name, s) in enumerate(ranked[:5], 1):
    print(f"   {i}. {name}  {int(s['earnings'])}元  {int(s['points'])}分")
print(f"\n📄 data.json 已生成：{json_path}")
print(f"🔗 飞书表格：https://hjlrkivx2z.feishu.cn/sheets/{SHEET_TOKEN}")
