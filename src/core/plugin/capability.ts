/**
 * A typed key for a service one plugin provides and others use (dependency inversion):
 * a skill asks for `CalendarReader`, never for the Google connector.
 */
export interface Capability<T> {
  readonly id: string;
  /** Phantom field that carries T; never read at runtime. */
  readonly __type?: T;
}

export function defineCapability<T>(id: string): Capability<T> {
  return { id };
}
