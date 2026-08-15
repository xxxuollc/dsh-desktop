#!/bin/bash
# 验证 dsh 服务自动启动路径（隔离 DSH_HOME，不动线上 3080 服务）
set -u
DSH_BIN="/Users/xuquanke/.npm/_npx/1e7f6d9597241db0/node_modules/.bin/dsh"
TEST_HOME="/tmp/dsh-desktop-test-home"
PORT=3099
WS="/Users/xuquanke/Documents/Herness Space"

rm -rf "$TEST_HOME"

echo "[1/4] 启动 dsh --profile web --port $PORT (DSH_HOME=$TEST_HOME, cwd=$WS)"
DSH_HOME="$TEST_HOME" "$DSH_BIN" --profile web --port "$PORT" \
  > /tmp/dsh-desktop-test-server.log 2>&1 &
DPID=$!
echo "       dsh pid=$DPID"

echo "[2/4] 轮询等待端口 $PORT 就绪…"
OK=0
for i in $(seq 1 45); do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "http://127.0.0.1:$PORT" 2>/dev/null)
  if [ -n "$CODE" ] && [ "$CODE" != "000" ]; then OK=1; break; fi
  sleep 1
done

if [ "$OK" = "1" ]; then
  echo "       ✓ 端口 $PORT 就绪 (HTTP $CODE)"
  TITLE=$(curl -s --max-time 3 "http://127.0.0.1:$PORT" | grep -o "<title>[^<]*</title>" | head -1)
  echo "[3/4] 页面标题: ${TITLE:-<无>}"
  echo "[4/4] 终止进程 (kill -TERM -$DPID)"
  kill -TERM -"$DPID" 2>/dev/null || kill -TERM "$DPID" 2>/dev/null
  sleep 2
  if kill -0 "$DPID" 2>/dev/null; then
    echo "       ⚠ 进程仍在，强制 SIGKILL"
    kill -KILL -"$DPID" 2>/dev/null || kill -KILL "$DPID" 2>/dev/null
    sleep 1
  fi
  if kill -0 "$DPID" 2>/dev/null; then
    echo "       ✗ 进程未能回收"
    echo "RESULT: FAIL"
    exit 1
  else
    echo "       ✓ 进程已回收"
  fi
  echo "RESULT: PASS"
  exit 0
else
  echo "       ✗ 端口 $PORT 未就绪，日志如下："
  tail -20 /tmp/dsh-desktop-test-server.log
  kill -TERM -"$DPID" 2>/dev/null
  echo "RESULT: FAIL"
  exit 1
fi
