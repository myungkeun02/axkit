import { z } from 'zod';
import type { OrgUnit } from '../../core/contracts/org.js';
import type { KeyValueStore } from '../../core/store/types.js';

const STORAGE_KEY = 'org-units';
const MAX_UNITS = 80;
const MAX_MEMBERS = 200;

const UnitSchema = z.object({
  org: z.string().min(1).max(80),
  name: z.string().min(1).max(60),
  parent: z.string().max(60).optional(),
  purpose: z.string().max(300).optional(),
  lead: z.string().max(60).optional(),
  members: z.array(z.string().max(60)).max(MAX_MEMBERS),
  sources: z.array(z.string().max(200)).max(10),
});

/** The departments and teams the first look found; each scan replaces the whole set. */
export class OrgUnitStore {
  private units: OrgUnit[] = [];

  constructor(private readonly kv: KeyValueStore) {}

  async load(): Promise<void> {
    const parsed = z.array(UnitSchema).safeParse(await this.kv.get<unknown>(STORAGE_KEY));
    this.units = parsed.success ? (parsed.data as OrgUnit[]) : [];
  }

  all(): readonly OrgUnit[] {
    return this.units;
  }

  async replace(units: readonly OrgUnit[]): Promise<void> {
    const valid: OrgUnit[] = [];
    for (const unit of units.slice(0, MAX_UNITS)) {
      const parsed = UnitSchema.safeParse({ ...unit, members: unit.members.slice(0, MAX_MEMBERS), sources: unit.sources.slice(0, 10) });
      if (parsed.success) valid.push(parsed.data as OrgUnit);
    }
    this.units = valid;
    await this.kv.set(STORAGE_KEY, valid);
  }
}
