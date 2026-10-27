/** Each shuffle changes every position without retries, including with a fixed RNG. */
export class IconCycle<T> {
  private order: T[];
  constructor(items: readonly T[], private random = Math.random) {
    if (!items.length) throw new Error("An icon cycle needs at least one design.");
    this.order = [...items];
  }
  at(index: number): T { return this.order[index % this.order.length]; }
  shuffle(): void {
    // Sattolo's shuffle makes one cycle, so no design stays in its old position.
    for (let i = this.order.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * i);
      [this.order[i], this.order[j]] = [this.order[j], this.order[i]];
    }
  }
}
