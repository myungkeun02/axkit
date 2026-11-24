/**
 * Bounded record lists, newest first: past `max`, the oldest finished records go. Unfinished ones are never
 * dropped (a running or queued task would lose its record and its callbacks would find nothing), so the list can
 * briefly sit over `max` while that many are unfinished; callers cap new work before that.
 */
export function trimFinished<T>(items: T[], max: number, unfinished: (item: T) => boolean): void {
  for (let index = items.length - 1; items.length > max && index >= 0; index -= 1) {
    const item = items[index];
    if (item !== undefined && !unfinished(item)) items.splice(index, 1);
  }
}
