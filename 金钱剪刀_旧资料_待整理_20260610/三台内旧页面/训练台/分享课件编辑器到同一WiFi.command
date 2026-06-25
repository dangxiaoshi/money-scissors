#!/bin/zsh
cd "$(dirname "$0")"
PORT=8777
LOG="/tmp/jinqian-editor.log"
IP="$(ipconfig getifaddr en0 2>/dev/null)"
if [ -z "$IP" ]; then
  IP="$(ipconfig getifaddr en1 2>/dev/null)"
fi

if [ -z "$IP" ]; then
  echo "没有拿到这台电脑的 Wi-Fi 地址。"
  echo "请确认电脑已经连上 Wi-Fi。"
  read -k 1 "?按任意键关闭窗口..."
  exit 1
fi

pkill -f "$(pwd)/editor-server.js" 2>/dev/null || true
sleep 0.5

echo "课件编辑器 Wi-Fi 分享模式"
echo "----------------------------------------"
echo "在另一台电脑浏览器打开这个地址："
echo "http://$IP:$PORT"
echo "----------------------------------------"
echo "注意：两台电脑必须在同一个 Wi-Fi。"
echo "这个窗口不要关，关掉后另一台电脑就打不开了。"
echo "编辑保存后，会写回这台电脑的 Obsidian，并重新生成 sop.html。"
echo "多人共创时，尽量分配不同讲次；不要两个人同时改同一讲，避免后保存的人覆盖前面的修改。"
echo

HOST=0.0.0.0 PORT=$PORT node editor-server.js 2>&1 | tee "$LOG"
