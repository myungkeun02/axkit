import type { TripTexts } from './locale.js';
import type { TripStore } from './store.js';

export interface TripDeps {
  store: TripStore;
  texts: TripTexts;
  timeZone: string;
}

export interface TripToolDeps extends TripDeps {
  now: () => Date;
}
