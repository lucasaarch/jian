export class GatewayError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * No model the profile could run on: none chosen, the chosen one gone, and none to pick
 * automatically. Only the owner can fix it, so whoever wrote in is told rather than kept waiting.
 */
export class NoModelAvailable extends GatewayError {
  constructor() {
    super(
      409,
      'No model is available. Connect a provider under Providers, or choose a model under Model defaults.',
    );
  }
}

export function assertFound<T>(value: T | null | undefined, label: string): T {
  if (value == null) {
    throw new GatewayError(404, `${label} not found`);
  }

  return value;
}
