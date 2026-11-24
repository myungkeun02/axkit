import { describe, expect, it } from 'vitest';
import { ownerStep } from '../../../src/skills/errands/run.js';
import { errandTexts } from '../../../src/skills/errands/locale.js';

describe('ownerStep on a site that blocks automated browsers', () => {
  it('says the site blocked it instead of asking for an option', () => {
    const decision = ownerStep({ status: 'needs_human', summary: "coupang.com shows 'Access Denied' (Reference #18.5), so the site is blocking the browser", url: 'https://www.coupang.com/' }, errandTexts);
    expect(decision?.notice).toBe(errandTexts.blocked);
    expect(ownerStep({ status: 'done', summary: 'Access Denied was a product name' }, errandTexts)).toBeUndefined();
  });
});
