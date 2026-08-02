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

export async function runLatestRequest<T>(
  gate: LatestRequestGate,
  request: () => Promise<T>,
  onStart: () => void,
  onSuccess: (value: T) => void,
  onError: () => void,
): Promise<void> {
  const generation = gate.begin();
  onStart();
  try {
    const value = await request();
    if (gate.isCurrent(generation)) onSuccess(value);
  } catch {
    if (gate.isCurrent(generation)) onError();
  }
}
