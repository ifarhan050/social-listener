import type { SourceAdapter, Target } from './types.js';

/** Maps `${platform}_${kind}` (e.g. facebook_group) to an adapter. New platforms register here. */
export class AdapterRegistry {
  private adapters = new Map<string, SourceAdapter>();

  register(adapter: SourceAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  forTarget(target: Pick<Target, 'platform' | 'kind'>): SourceAdapter | undefined {
    return this.adapters.get(`${target.platform}_${target.kind}`);
  }

  ids(): string[] {
    return [...this.adapters.keys()];
  }

  forPlatform(platform: string): SourceAdapter[] {
    return [...this.adapters.values()].filter((a) => a.platform === platform);
  }

  platforms(): string[] {
    return [...new Set([...this.adapters.values()].map((a) => a.platform))];
  }
}

export class SimpleBudget {
  private _used = 0;
  constructor(private limit: number) {}
  get remaining() {
    return Math.max(0, this.limit - this._used);
  }
  get used() {
    return this._used;
  }
  tryConsume(): boolean {
    if (this._used >= this.limit) return false;
    this._used++;
    return true;
  }
}
