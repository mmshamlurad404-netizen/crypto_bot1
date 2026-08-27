#!/bin/bash
# Example: POST a TradingView-style alert to the bot's webhook.
# In TradingView set the alert message to a JSON body like the one below,
# and configure "webhook URL" to point at /api/v1/tradingview with an
# Authorization: Bearer header matching SENTIMENT_WEBHOOK_TOKEN.
set -e

WEBHOOK_URL="${WEBHOOK_URL:-http://localhost:3001/api/v1/tradingview}"
WEBHOOK_TOKEN="${WEBHOOK_TOKEN:-change-me-to-a-long-random-string}"

# action values: buy|long|entry -> BUY, sell|close|exit|short -> SELL,
# hold|none -> no-op. symbol can be a bot key ("btc/rls") or a ticker
# (e.g. "BINANCE:BTCRLS", matched by stripping the exchange prefix).
curl -s -X POST "$WEBHOOK_URL" \
  -H "Authorization: Bearer $WEBHOOK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "ticker": "BINANCE:BTCRLS",
    "close": 300000000,
    "strategy": {
      "order": {
        "action": "buy"
      }
    }
  }'
echo
