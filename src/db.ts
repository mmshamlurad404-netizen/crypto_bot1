import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Position, OrderRecord, TradeRecord, MarginPosition } from "./types.js";

function mapPosition(row: Record<string, unknown>): Position {
  return {
    id: Number(row.id),
    symbol: String(row.symbol),
    openTs: String(row.open_ts),
    entryPrice: Number(row.entry_price),
    amount: Number(row.amount),
    status: row.status === "closed" ? "closed" : "open",
    closeTs: row.close_ts != null ? String(row.close_ts) : null,
    closePrice: row.close_price != null ? Number(row.close_price) : null,
    realizedPnl: row.realized_pnl != null ? Number(row.realized_pnl) : null,
    exitReason: row.exit_reason != null ? String(row.exit_reason) : null,
    orderId: row.order_id != null ? Number(row.order_id) : null,
  };
}

function mapOrder(row: Record<string, unknown>): OrderRecord {
  return {
    id: Number(row.id),
    ts: String(row.ts),
    clientOrderId: String(row.client_order_id),
    symbol: String(row.symbol),
    side: row.side === "sell" ? "sell" : "buy",
    execution: row.execution === "limit" ? "limit" : "market",
    kind: String(row.kind ?? "entry"),
    amount: Number(row.amount),
    price: row.price != null ? Number(row.price) : null,
    status: ["new", "filled", "canceled", "failed"].includes(String(row.status)) ? (String(row.status) as OrderRecord["status"]) : "failed",
    dryRun: Boolean(Number(row.dry_run)),
    nobitexOrderId: row.nobitex_order_id != null ? String(row.nobitex_order_id) : null,
    error: row.error != null ? String(row.error) : null,
  };
}

function mapMarginPosition(row: Record<string, unknown>): MarginPosition {
  return {
    id: Number(row.id),
    symbol: String(row.symbol),
    leverage: Number(row.leverage),
    openTs: String(row.open_ts),
    entryPrice: Number(row.entry_price),
    amount: Number(row.amount),
    status: row.status === "closed" ? "closed" : "open",
    closeTs: row.close_ts != null ? String(row.close_ts) : null,
    closePrice: row.close_price != null ? Number(row.close_price) : null,
    realizedPnl: row.realized_pnl != null ? Number(row.realized_pnl) : null,
    exitReason: row.exit_reason != null ? String(row.exit_reason) : null,
    orderId: row.order_id != null ? Number(row.order_id) : null,
  };
}

export class AuditDb {
  private db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        symbol TEXT NOT NULL,
        action TEXT NOT NULL,
        rsi REAL,
        sentiment REAL,
        price REAL,
        series_len INTEGER,
        reason TEXT,
        details TEXT
      );

      CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        client_order_id TEXT UNIQUE,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        execution TEXT NOT NULL,
        amount REAL NOT NULL,
        price REAL,
        status TEXT NOT NULL,
        dry_run INTEGER NOT NULL,
        nobitex_order_id TEXT,
        error TEXT,
        kind TEXT NOT NULL DEFAULT 'entry'
      );

      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        order_id INTEGER,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        amount REAL NOT NULL,
        price REAL NOT NULL,
        total REAL NOT NULL,
        fee REAL NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        open_ts TEXT NOT NULL,
        entry_price REAL NOT NULL,
        amount REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        close_ts TEXT,
        close_price REAL,
        realized_pnl REAL,
        exit_reason TEXT,
        order_id INTEGER
      );

      CREATE TABLE IF NOT EXISTS margin_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        leverage INTEGER NOT NULL DEFAULT 1,
        open_ts TEXT NOT NULL,
        entry_price REAL NOT NULL,
        amount REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        close_ts TEXT,
        close_price REAL,
        realized_pnl REAL,
        exit_reason TEXT,
        order_id INTEGER
      );

      CREATE TABLE IF NOT EXISTS risk_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        symbol TEXT,
        kind TEXT NOT NULL,
        message TEXT NOT NULL,
        data TEXT
      );

      CREATE TABLE IF NOT EXISTS sentiment_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        account TEXT NOT NULL,
        symbol TEXT NOT NULL,
        sentiment REAL NOT NULL,
        confidence REAL NOT NULL DEFAULT 1,
        note TEXT
      );

      CREATE TABLE IF NOT EXISTS portfolio_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        equity REAL NOT NULL,
        cash REAL NOT NULL,
        positions_value REAL NOT NULL,
        unrealized_pnl REAL NOT NULL,
        realized_pnl_day REAL NOT NULL DEFAULT 0,
        data TEXT
      );

      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        type TEXT NOT NULL,
        channel TEXT NOT NULL,
        message TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tradingview_signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        symbol TEXT NOT NULL,
        action TEXT NOT NULL,
        price REAL,
        ticker TEXT,
        raw TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_signals_ts ON signals(ts);
      CREATE INDEX IF NOT EXISTS idx_orders_ts ON orders(ts);
      CREATE INDEX IF NOT EXISTS idx_trades_ts ON trades(ts);
      CREATE INDEX IF NOT EXISTS idx_positions_symbol ON positions(symbol);
      CREATE INDEX IF NOT EXISTS idx_positions_close_ts ON positions(close_ts);
      CREATE INDEX IF NOT EXISTS idx_margin_positions_symbol ON margin_positions(symbol);
      CREATE INDEX IF NOT EXISTS idx_margin_positions_close_ts ON margin_positions(close_ts);
      CREATE INDEX IF NOT EXISTS idx_risk_ts ON risk_events(ts);
      CREATE INDEX IF NOT EXISTS idx_sentiment_ts ON sentiment_events(ts);
      CREATE INDEX IF NOT EXISTS idx_snapshots_ts ON portfolio_snapshots(ts);
      CREATE INDEX IF NOT EXISTS idx_tradingview_ts ON tradingview_signals(ts);
    `);
    this.migrateOrderKind();
  }

  private migrateOrderKind(): void {
    const cols = this.db.prepare("PRAGMA table_info(orders)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "kind")) {
      this.db.exec("ALTER TABLE orders ADD COLUMN kind TEXT NOT NULL DEFAULT 'entry'");
    }
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  getMetaJSON<T>(key: string): T | null {
    const raw = this.getMeta(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  setMetaJSON(key: string, value: unknown): void {
    this.setMeta(key, JSON.stringify(value));
  }

  insertSignal(signal: { ts: string; symbol: string; action: string; rsi: number | null; sentiment: number | null; price: number | null; seriesLen: number | null; reason: string; details: string | null }): number {
    const res = this.db
      .prepare(
        "INSERT INTO signals (ts, symbol, action, rsi, sentiment, price, series_len, reason, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(signal.ts, signal.symbol, signal.action, signal.rsi, signal.sentiment, signal.price, signal.seriesLen, signal.reason, signal.details);
    return Number(res.lastInsertRowid);
  }

  insertTradingViewSignal(row: { ts: string; symbol: string; action: string; price: number | null; ticker: string | null; raw: string | null }): number {
    const res = this.db
      .prepare("INSERT INTO tradingview_signals (ts, symbol, action, price, ticker, raw) VALUES (?, ?, ?, ?, ?, ?)")
      .run(row.ts, row.symbol, row.action, row.price, row.ticker, row.raw);
    return Number(res.lastInsertRowid);
  }

  countTradingViewSignals(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM tradingview_signals").get() as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  insertOrder(order: {
    ts: string;
    clientOrderId: string;
    symbol: string;
    side: string;
    execution: string;
    amount: number;
    price: number | null;
    status: string;
    dryRun: boolean;
    nobitexOrderId: string | null;
    error: string | null;
    kind?: string;
  }): number {
    const res = this.db
      .prepare(
        "INSERT INTO orders (ts, client_order_id, symbol, side, execution, amount, price, status, dry_run, nobitex_order_id, error, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        order.ts,
        order.clientOrderId,
        order.symbol,
        order.side,
        order.execution,
        order.amount,
        order.price,
        order.status,
        order.dryRun ? 1 : 0,
        order.nobitexOrderId,
        order.error,
        order.kind ?? "entry"
      );
    return Number(res.lastInsertRowid);
  }

  updateOrderStatus(id: number, status: string, nobitexOrderId: string | null, error: string | null): void {
    this.db
      .prepare("UPDATE orders SET status = ?, nobitex_order_id = COALESCE(?, nobitex_order_id), error = ? WHERE id = ?")
      .run(status, nobitexOrderId, error, id);
  }

  getOrder(id: number): OrderRecord | null {
    const row = this.db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? mapOrder(row) : null;
  }

  openOrders(symbol?: string): OrderRecord[] {
    const rows = symbol
      ? this.db.prepare("SELECT * FROM orders WHERE status = 'new' AND symbol = ? ORDER BY id ASC").all(symbol)
      : this.db.prepare("SELECT * FROM orders WHERE status = 'new' ORDER BY id ASC").all();
    return (rows as Record<string, unknown>[]).map(mapOrder);
  }

  insertTrade(trade: { ts: string; orderId: number | null; symbol: string; side: string; amount: number; price: number; total: number; fee: number }): number {
    const res = this.db
      .prepare("INSERT INTO trades (ts, order_id, symbol, side, amount, price, total, fee) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(trade.ts, trade.orderId, trade.symbol, trade.side, trade.amount, trade.price, trade.total, trade.fee);
    return Number(res.lastInsertRowid);
  }

  tradesBetween(fromTs: string, toTs: string): TradeRecord[] {
    return this.db.prepare("SELECT * FROM trades WHERE ts >= ? AND ts < ? ORDER BY ts ASC").all(fromTs, toTs) as TradeRecord[];
  }

  insertPosition(pos: { symbol: string; openTs: string; entryPrice: number; amount: number; orderId: number | null }): number {
    const res = this.db
      .prepare("INSERT INTO positions (symbol, open_ts, entry_price, amount, status, order_id) VALUES (?, ?, ?, ?, 'open', ?)")
      .run(pos.symbol, pos.openTs, pos.entryPrice, pos.amount, pos.orderId);
    return Number(res.lastInsertRowid);
  }

  openPositions(): Position[] {
    return (this.db.prepare("SELECT * FROM positions WHERE status = 'open'").all() as Record<string, unknown>[]).map(mapPosition);
  }

  getOpenPosition(symbol: string): Position | null {
    const row = this.db.prepare("SELECT * FROM positions WHERE status = 'open' AND symbol = ?").get(symbol) as Record<string, unknown> | undefined;
    return row ? mapPosition(row) : null;
  }

  closedPositionsBetween(fromTs: string, toTs: string): Position[] {
    return (
      this.db
        .prepare("SELECT * FROM positions WHERE status = 'closed' AND close_ts >= ? AND close_ts < ? ORDER BY close_ts ASC")
        .all(fromTs, toTs) as Record<string, unknown>[]
    ).map(mapPosition);
  }

  updatePositionAmount(id: number, amount: number, entryPrice: number): void {
    this.db.prepare("UPDATE positions SET amount = ?, entry_price = ? WHERE id = ?").run(amount, entryPrice, id);
  }

  insertMarginPosition(pos: { symbol: string; openTs: string; entryPrice: number; amount: number; leverage: number; orderId: number | null }): number {
    const res = this.db
      .prepare("INSERT INTO margin_positions (symbol, leverage, open_ts, entry_price, amount, status, order_id) VALUES (?, ?, ?, ?, ?, 'open', ?)")
      .run(pos.symbol, pos.leverage, pos.openTs, pos.entryPrice, pos.amount, pos.orderId);
    return Number(res.lastInsertRowid);
  }

  openMarginPositions(): MarginPosition[] {
    return (this.db.prepare("SELECT * FROM margin_positions WHERE status = 'open'").all() as Record<string, unknown>[]).map(mapMarginPosition);
  }

  getOpenMarginPosition(symbol: string): MarginPosition | null {
    const row = this.db.prepare("SELECT * FROM margin_positions WHERE status = 'open' AND symbol = ?").get(symbol) as Record<string, unknown> | undefined;
    return row ? mapMarginPosition(row) : null;
  }

  closedMarginPositionsBetween(fromTs: string, toTs: string): MarginPosition[] {
    return (
      this.db
        .prepare("SELECT * FROM margin_positions WHERE status = 'closed' AND close_ts >= ? AND close_ts < ? ORDER BY close_ts ASC")
        .all(fromTs, toTs) as Record<string, unknown>[]
    ).map(mapMarginPosition);
  }

  closeMarginPosition(id: number, closeTs: string, closePrice: number, realizedPnl: number, exitReason: string): void {
    this.db
      .prepare("UPDATE margin_positions SET status = 'closed', close_ts = ?, close_price = ?, realized_pnl = ?, exit_reason = ? WHERE id = ?")
      .run(closeTs, closePrice, realizedPnl, exitReason, id);
  }

  closePosition(id: number, closeTs: string, closePrice: number, realizedPnl: number, exitReason: string): void {
    this.db
      .prepare("UPDATE positions SET status = 'closed', close_ts = ?, close_price = ?, realized_pnl = ?, exit_reason = ? WHERE id = ?")
      .run(closeTs, closePrice, realizedPnl, exitReason, id);
  }

  insertRiskEvent(event: { ts: string; symbol: string | null; kind: string; message: string; data: string | null }): number {
    const res = this.db
      .prepare("INSERT INTO risk_events (ts, symbol, kind, message, data) VALUES (?, ?, ?, ?, ?)")
      .run(event.ts, event.symbol, event.kind, event.message, event.data);
    return Number(res.lastInsertRowid);
  }

  insertSentimentEvent(event: { ts: string; account: string; symbol: string; sentiment: number; confidence: number; note: string | null }): number {
    const res = this.db
      .prepare("INSERT INTO sentiment_events (ts, account, symbol, sentiment, confidence, note) VALUES (?, ?, ?, ?, ?, ?)")
      .run(event.ts, event.account, event.symbol, event.sentiment, event.confidence, event.note);
    return Number(res.lastInsertRowid);
  }

  getSentimentEvents(windowMs: number): { ts: string; account: string; symbol: string; sentiment: number; confidence: number; note: string | null }[] {
    const from = new Date(Date.now() - windowMs).toISOString();
    return this.db
      .prepare("SELECT ts, account, symbol, sentiment, confidence, note FROM sentiment_events WHERE ts >= ? ORDER BY ts ASC")
      .all(from) as { ts: string; account: string; symbol: string; sentiment: number; confidence: number; note: string | null }[];
  }

  insertPortfolioSnapshot(snapshot: {
    ts: string;
    equity: number;
    cash: number;
    positionsValue: number;
    unrealizedPnl: number;
    realizedPnlDay: number;
    data: string;
  }): number {
    const res = this.db
      .prepare("INSERT INTO portfolio_snapshots (ts, equity, cash, positions_value, unrealized_pnl, realized_pnl_day, data) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(snapshot.ts, snapshot.equity, snapshot.cash, snapshot.positionsValue, snapshot.unrealizedPnl, snapshot.realizedPnlDay, snapshot.data);
    return Number(res.lastInsertRowid);
  }

  latestSnapshot(): { equity: number; ts: string } | null {
    const row = this.db.prepare("SELECT equity, ts FROM portfolio_snapshots ORDER BY ts DESC LIMIT 1").get() as { equity: number; ts: string } | undefined;
    return row ?? null;
  }

  snapshotsBetween(fromTs: string, toTs: string): { ts: string; equity: number; positionsValue: number }[] {
    return this.db
      .prepare("SELECT ts, equity, positions_value AS positionsValue FROM portfolio_snapshots WHERE ts >= ? AND ts < ? ORDER BY ts ASC")
      .all(fromTs, toTs) as { ts: string; equity: number; positionsValue: number }[];
  }

  insertAlert(alert: { ts: string; type: string; channel: string; message: string }): number {
    const res = this.db
      .prepare("INSERT INTO alerts (ts, type, channel, message) VALUES (?, ?, ?, ?)")
      .run(alert.ts, alert.type, alert.channel, alert.message);
    return Number(res.lastInsertRowid);
  }

  countTradesToday(dayStartTs: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM trades WHERE ts >= ?")
      .get(dayStartTs) as { n: number };
    return row.n;
  }

  close(): void {
    this.db.close();
  }
}
