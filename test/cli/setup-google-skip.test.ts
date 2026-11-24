import { describe, expect, it } from 'vitest';
import { createScriptedPrompter } from '../../src/cli/prompter.js';
import { askClientJson } from '../../src/cli/setup-google.js';

describe('the Google file question has a way out', () => {
  it('"나중에" or three paths that find nothing leave Google for later instead of looping', async () => {
    const deps = (answers: string[]) => ({ prompter: createScriptedPrompter(answers), fileExists: async () => false, readFile: async () => '' }) as never;
    expect(await askClientJson(deps(['나중에']))).toBeUndefined();
    expect(await askClientJson(deps(['/x', '/y', '/z']))).toBeUndefined();
  });
});

import { driveFolderIds } from '../../src/cli/setup-google.js';

describe('Drive folders from a pasted link', () => {
  it('takes folder links or bare ids, ignores anything else', () => {
    expect(driveFolderIds('https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp?usp=sharing, 1QrStUvWxYz0123456789abcd 아무말')).toEqual(['1AbCdEfGhIjKlMnOp', '1QrStUvWxYz0123456789abcd']);
    expect(driveFolderIds('')).toEqual([]);
  });
});
