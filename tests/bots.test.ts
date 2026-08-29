import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, loadConfigs } from "../src/config.js";

const baseEnv = {
  SYMBOLS: "btc/rls",
  NODE_ENV: "test",
  LOG_LEVEL: "warn",
};

test("loadConfigs returns a single config when BOTS_JSON is unset", () => {
  const configs = loadConfigs({ ...baseEnv });
  assert.equal(configs.length, 1);
  assert.equal(configs[0]!.botName, "default");
  assert.equal(configs[0]!.symbols.length, 1);
  assert.equal(configs[0]!.symbols[0]!.key, "btc/rls");
});

test("loadConfigs runs one config per BOTS_JSON entry, merged over base env", () => {
  const configs = loadConfigs({
    ...baseEnv,
    SENTIMENT_WEBHOOK_PORT: "3001",
    BOTS_JSON: JSON.stringify([
      { SYMBOLS: "btc/rls", BOT_NAME: "btc-bot", SENTIMENT_WEBHOOK_PORT: "0", DB_PATH: ":memory:" },
      { SYMBOLS: "eth/rls", BOT_NAME: "eth-bot", SENTIMENT_WEBHOOK_PORT: "3002", DB_PATH: ":memory:" },
    ]),
  });
  assert.equal(configs.length, 2);
  assert.equal(configs[0]!.botName, "btc-bot");
  assert.equal(configs[0]!.symbols[0]!.key, "btc/rls");
  assert.equal(configs[0]!.sentimentWebhookPort, 0, "port 0 disables the webhook");
  assert.equal(configs[1]!.botName, "eth-bot");
  assert.equal(configs[1]!.symbols[0]!.key, "eth/rls");
  assert.equal(configs[1]!.sentimentWebhookPort, 3002);
  assert.equal(configs[1]!.maxPositionSizePct, 10, "unset knobs inherit the base env defaults");
});

test("BOTS_JSON entries inherit base SYMBOLS when omitted", () => {
  const configs = loadConfigs({
    ...baseEnv,
    BOTS_JSON: JSON.stringify([{ BOT_NAME: "inherit-bot", DB_PATH: ":memory:" }]),
  });
  assert.equal(configs[0]!.symbols[0]!.key, "btc/rls");
});

test("loadConfigs rejects malformed BOTS_JSON", () => {
  assert.throws(() => loadConfigs({ ...baseEnv, BOTS_JSON: "nope" }), /JSON array/);
  assert.throws(() => loadConfigs({ ...baseEnv, BOTS_JSON: "{}" }), /non-empty JSON array/);
  assert.throws(() => loadConfigs({ ...baseEnv, BOTS_JSON: "[]" }), /non-empty JSON array/);
  assert.throws(() => loadConfigs({ ...baseEnv, BOTS_JSON: '["x"]' }), /object of env overrides/);
  assert.throws(() => loadConfigs({ ...baseEnv, BOTS_JSON: '[{"SYMBOLS":"btc/usdt"}]' }), /quote currency/);
});

test("SENTIMENT_WEBHOOK_PORT=0 disables the webhook, BOT_NAME is surfaced", () => {
  const config = loadConfig({ ...baseEnv, SENTIMENT_WEBHOOK_PORT: "0", BOT_NAME: "edge" });
  assert.equal(config.sentimentWebhookPort, 0);
  assert.equal(config.botName, "edge");
});
