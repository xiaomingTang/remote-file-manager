export class LoadingManager<T> {
  private readonly loadingNodes = new Map<string, T>();
  private readonly loadingTimeouts = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly getKey: (item: T) => string,
    private readonly onChange: (item?: T) => void,
  ) {}

  set(item: T, delayMs = 200): void {
    const loadingKey = this.getKey(item);
    const previousTimeout = this.loadingTimeouts.get(loadingKey);
    if (previousTimeout) {
      clearTimeout(previousTimeout);
    }

    const loadingTimeout = setTimeout(() => {
      this.loadingTimeouts.delete(loadingKey);
      this.loadingNodes.set(loadingKey, item);
      this.onChange(item);
    }, delayMs);
    this.loadingTimeouts.set(loadingKey, loadingTimeout);
  }

  clear(item?: T, notify = true): void {
    if (item) {
      const loadingKey = this.getKey(item);
      const loadingTimeout = this.loadingTimeouts.get(loadingKey);
      if (loadingTimeout) {
        clearTimeout(loadingTimeout);
        this.loadingTimeouts.delete(loadingKey);
      }
      this.loadingNodes.delete(loadingKey);
      this.onChange(item);
      return;
    }

    for (const loadingTimeout of this.loadingTimeouts.values()) {
      clearTimeout(loadingTimeout);
    }
    this.loadingTimeouts.clear();
    this.loadingNodes.clear();
    if (notify) {
      this.onChange();
    }
  }

  has(item: T): boolean {
    return this.loadingNodes.has(this.getKey(item));
  }

  values(): IterableIterator<T> {
    return this.loadingNodes.values();
  }
}
