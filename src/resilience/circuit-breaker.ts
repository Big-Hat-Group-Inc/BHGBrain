export type CircuitBreakerState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  failureThreshold: number;
  openWindowMs: number;
  halfOpenProbeCount: number;
}

export class CircuitOpenError extends Error {
  constructor(message = 'Circuit breaker is open') {
    super(message);
    this.name = 'CircuitOpenError';
  }
}

export class CircuitBreaker {
  private state: CircuitBreakerState = 'closed';
  private failures = 0;
  private lastOpenedAt: Date | null = null;
  private halfOpenSuccesses = 0;

  constructor(
    private readonly options: CircuitBreakerOptions,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.transitionToHalfOpenIfReady();

    if (this.state === 'open') {
      throw new CircuitOpenError();
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  getState(): CircuitBreakerState {
    this.transitionToHalfOpenIfReady();
    return this.state;
  }

  getStats(): { failures: number; lastOpenedAt: Date | null } {
    return {
      failures: this.failures,
      lastOpenedAt: this.lastOpenedAt,
    };
  }

  private onSuccess(): void {
    if (this.state === 'half-open') {
      this.halfOpenSuccesses += 1;
      if (this.halfOpenSuccesses >= this.options.halfOpenProbeCount) {
        this.close();
      }
      return;
    }

    this.failures = 0;
  }

  private onFailure(): void {
    if (this.state === 'half-open') {
      this.open();
      return;
    }

    this.failures += 1;
    if (this.failures >= this.options.failureThreshold) {
      this.open();
    }
  }

  private transitionToHalfOpenIfReady(): void {
    if (this.state !== 'open' || this.lastOpenedAt === null) {
      return;
    }

    if ((this.now() - this.lastOpenedAt.getTime()) >= this.options.openWindowMs) {
      this.state = 'half-open';
      this.halfOpenSuccesses = 0;
    }
  }

  private open(): void {
    this.state = 'open';
    this.failures = this.options.failureThreshold;
    this.halfOpenSuccesses = 0;
    this.lastOpenedAt = new Date(this.now());
  }

  private close(): void {
    this.state = 'closed';
    this.failures = 0;
    this.halfOpenSuccesses = 0;
  }
}
