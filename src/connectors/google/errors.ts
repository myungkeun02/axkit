/** A Google credential problem the owner can fix by running `ax-kit connect google` again. */
export class GoogleAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleAuthError';
  }
}

/** A Google API call that failed after retries; `insufficientScope` means the sign-in lacks a permission. */
export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly insufficientScope: boolean,
  ) {
    super(message);
    this.name = 'GoogleApiError';
  }
}
