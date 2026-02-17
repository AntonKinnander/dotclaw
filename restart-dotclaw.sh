#!/bin/bash
# Restart dotclaw script

echo "Killing existing dotclaw processes..."
pkill -f "node.*dist/index" 2>/dev/null || true
pkill -f "tsx.*index" 2>/dev/null || true
sleep 2

echo "Starting dotclaw..."
cd "C:\Users\Fiznik\Development\DISCLAWD\dotclaw"
npm start 2>&1 | tee ~/dotclaw-startup.log &
DOTCLAW_PID=$!

echo "DotClaw started with PID: $DOTCLAW_PID"
echo "Check startup log with: tail -f ~/dotclaw-startup.log"
echo ""
echo "Verifying DISCORD_OWNER_ID is set:"
grep "DISCORD_OWNER_ID" ~/.dotclaw/.env
echo ""
echo "Bot should now respond to ANY message from Discord ID: 622332026141409281"
