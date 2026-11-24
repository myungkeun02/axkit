/** Rolling-window counter. Keys are bounded by the caller (device ids, one global key). */
export class SlidingWindow {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly windowMs: number,
    private readonly limit: number,
  ) {}

  /** Records one hit at `now`; true means the window now holds more than `limit` hits. */
  over(key: string, now: Date): boolean {
    const time = now.getTime();
    const recent = (this.hits.get(key) ?? []).filter((hit) => time - hit < this.windowMs);
    recent.push(time);
    this.hits.set(key, recent);
    return recent.length > this.limit;
  }

  count(key: string, now: Date): number {
    const time = now.getTime();
    return (this.hits.get(key) ?? []).filter((hit) => time - hit < this.windowMs).length;
  }

  clear(key?: string): void {
    if (key === undefined) this.hits.clear();
    else this.hits.delete(key);
  }
}
