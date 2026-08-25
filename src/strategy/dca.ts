export interface DcaLevel {
  belowPct: number;
  buyPct: number;
}

export interface DcaLadderConfig {
  enabled: boolean;
  levels: DcaLevel[];
  maxOrders: number;
}

export class DcaLadder {
  private config: DcaLadderConfig;
  private consumed: Map<number, number> = new Map();

  constructor(config: DcaLadderConfig) {
    this.config = {
      ...config,
      levels: [...config.levels].sort((a, b) => a.belowPct - b.belowPct),
    };
  }

  get enabled(): boolean {
    return this.config.enabled && this.config.levels.length > 0 && this.config.maxOrders > 0;
  }

  peek(positionId: number, entryPrice: number, price: number): DcaLevel | null {
    if (!this.enabled) return null;
    const cursor = this.consumed.get(positionId) ?? 0;
    const effectiveMax = Math.min(this.config.levels.length, this.config.maxOrders);
    if (cursor >= effectiveMax) return null;
    const level = this.config.levels[cursor]!;
    if (price <= entryPrice * (1 - level.belowPct / 100)) {
      return level;
    }
    return null;
  }

  consume(positionId: number): void {
    const cursor = this.consumed.get(positionId) ?? 0;
    const effectiveMax = Math.min(this.config.levels.length, this.config.maxOrders);
    this.consumed.set(positionId, Math.min(cursor + 1, effectiveMax));
    if (this.consumed.size > 64) {
      const oldest = this.consumed.keys().next().value;
      if (oldest !== undefined) this.consumed.delete(oldest);
    }
  }

  consumedCount(positionId: number): number {
    return this.consumed.get(positionId) ?? 0;
  }
}
