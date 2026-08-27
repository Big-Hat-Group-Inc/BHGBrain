export type CircuitBreakerState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerLogger {
  warn(obj: Record<string, unknown>): void;
  info(obj: Record<string, unknown>): void;
}

export interface CircuitBreakerOptions {
  failureThreshold: number;
  openWindowMs: number;
  halfOpenProbeCount: number;
  /** Identifier included in transition log events (e.g. "qdrant", "openai_embedding"). */
  key?: string;
  /** Optional structured logger; when omitted, transitions are not logged. */
  logger?: CircuitBreakerLogger;
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
  private probeInFlight = false;

  constructor(
    private readonly options: CircuitBreakerOptions,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.transitionToHalfOpenIfReady();

    if (this.state === 'open') {
      throw new CircuitOpenError();
    }

    const isProbe = this.state === 'half-open';
    if (isProbe) {
      if (this.probeInFlight) {
        throw new CircuitOpenError();
      }
      this.probeInFlight = true;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    } finally {
      if (isProbe) {
        this.probeInFlight = false;
      }
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
      const from = this.state;
      this.state = 'half-open';
      this.halfOpenSuccesses = 0;
      this.probeInFlight = false;
      this.logTransition('info', from, this.state);
    }
  }

  private open(): void {
    const from = this.state;
    this.state = 'open';
    this.failures = this.options.failureThreshold;
    this.halfOpenSuccesses = 0;
    this.probeInFlight = false;
    this.lastOpenedAt = new Date(this.now());
    this.logTransition(from === 'closed' ? 'warn' : 'info', from, this.state, { failures: this.failures });
  }

  private close(): void {
    const from = this.state;
    this.state = 'closed';
    this.failures = 0;
    this.halfOpenSuccesses = 0;
    this.probeInFlight = false;
    this.logTransition('info', from, this.state);
  }

  private logTransition(
    level: 'warn' | 'info',
    from: CircuitBreakerState,
    to: CircuitBreakerState,
    extra?: Record<string, unknown>,
  ): void {
    if (!this.options.logger) {
      return;
    }

    const payload = {
      event: 'circuit_breaker_transition',
      breaker: this.options.key ?? 'unknown',
      from,
      to,
      ...extra,
    };

    if (level === 'warn') {
      this.options.logger.warn(payload);
    } else {
      this.options.logger.info(payload);
    }
  }
}
