#!/bin/zsh
cd "$(dirname "$0")"
pkill -f "$(pwd)/editor-server.js" 2>/dev/null || true
echo "课件编辑器已关闭。"
sleep 1
