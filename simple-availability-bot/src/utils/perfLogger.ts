export class PerfLogger {
  static start(label: string) {
    const start = performance.now();
    console.log(`[PERF] [START] ${label} at ${new Date().toISOString()}`);
    return () => {
      const end = performance.now();
      const duration = (end - start).toFixed(2);
      console.log(`[PERF] [END]   ${label} took ${duration}ms`);
    };
  }

  static async measure<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const end = PerfLogger.start(label);
    try {
      return await fn();
    } finally {
      end();
    }
  }

  static measureSync<T>(label: string, fn: () => T): T {
    const end = PerfLogger.start(label);
    try {
      return fn();
    } finally {
      end();
    }
  }
}
