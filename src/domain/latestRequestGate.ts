export class LatestRequestGate {
  private generation = 0;

  begin(): number {
    this.generation += 1;
    return this.generation;
  }

  invalidate(): void {
    this.generation += 1;
  }

  isCurrent(request: number): boolean {
    return request === this.generation;
  }
}

export class ShareFailureLatch {
  private failed = false;

  recordFailure(): void {
    this.failed = true;
  }

  clear(): void {
    this.failed = false;
  }

  allowsAutomaticRefresh(): boolean {
    return !this.failed;
  }
}

export async function runLatestRequest<T>(
  gate: LatestRequestGate,
  request: () => Promise<T>,
  onStart: () => void,
  onSuccess: (value: T) => void,
  onError: (error: unknown) => void,
): Promise<boolean> {
  const generation = gate.begin();
  onStart();
  try {
    const value = await request();
    if (gate.isCurrent(generation)) {
      onSuccess(value);
      return true;
    }
  } catch (error) {
    if (gate.isCurrent(generation)) {
      onError(error);
      return false;
    }
  }
  return false;
}
