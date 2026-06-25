#!/bin/zsh
cd "$(dirname "$0")"

PORT=8777
URL="http://127.0.0.1:$PORT"
LOG="/tmp/jinqian-editor.log"

if curl -fsS "$URL/api/course" >/dev/null 2>&1; then
  open "$URL"
  echo "课件编辑器已经在运行，已为你打开页面。"
  echo "如果看到 file:// 开头的旧页面，请关掉旧页面，只保留 http://127.0.0.1:8777/。"
  sleep 2
  exit 0
fi

echo "正在启动课件编辑器..."
echo "保存会同步 Obsidian 原稿，并重新生成 sop.html。"

NODE_BIN="$(command -v node)"
if [ -z "$NODE_BIN" ]; then
  echo "没有找到 node。请先安装 Node.js。"
  read -k 1 "?按任意键关闭窗口..."
  exit 1
fi

PORT=$PORT nohup "$NODE_BIN" editor-server.js > "$LOG" 2>&1 < /dev/null &

for i in {1..30}; do
  if curl -fsS "$URL/api/course" >/dev/null 2>&1; then
    open "$URL"
    echo "课件编辑器已打开。"
    echo "如果看到 file:// 开头的旧页面，请关掉旧页面，只保留 http://127.0.0.1:8777/。"
    sleep 2
    exit 0
  fi
  sleep 0.2
done

echo "课件编辑器启动失败。下面是错误信息："
echo "----------------------------------------"
cat "$LOG"
echo "----------------------------------------"
read -k 1 "?按任意键关闭窗口..."
