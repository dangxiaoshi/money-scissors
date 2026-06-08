#!/bin/bash
# 双击这个文件，就能刷新飞书「学员汇总」表
cd "$(dirname "$0")"
echo "==============================="
echo "  金钱剪刀 · 学员汇总刷新"
echo "==============================="
python3 update_summary.py
echo ""
echo "按任意键关闭窗口..."
read -n 1
