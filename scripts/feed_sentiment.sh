#!/bin/bash
# Example: feed sentiment for verified accounts into the bot.
# Each line is one JSON object. Post to the bot's webhook endpoint.
set -e

WEBHOOK_URL="${WEBHOOK_URL:-http://localhost:3001/api/v1/sentiment}"
WEBHOOK_TOKEN="${WEBHOOK_TOKEN:-change-me-to-a-long-random-string}"

curl -s -X POST "$WEBHOOK_URL" \
  -H "Authorization: Bearer $WEBHOOK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '[
    {"account":"@cryptoverified1","symbol":"btc","sentiment":0.8,"confidence":1.0,"note":"bullish on halving"},
    {"account":"@cryptoverified2","symbol":"btc","sentiment":0.5,"confidence":0.8,"note":"strong order flow"},
    {"account":"@cryptoverified3","symbol":"eth","sentiment":-0.6,"confidence":0.9,"note":"network congestion concerns"}
  ]'
echo
