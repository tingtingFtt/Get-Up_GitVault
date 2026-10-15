import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseImportLinks } from '../src/utils/importLinks';

test('batch parsing normalizes repository links, discards refs and separates invalid and duplicate inputs', () => {
  const links = parseImportLinks('https://github.com/demo/one/tree/feature/demo\nDEMO/one.git，demo/two;https://example.com/demo/three\ninvalid');
  assert.deepEqual(links.map(link => link.status), ['pending', 'skipped', 'pending', 'error', 'error']);
  assert.equal(links[0].url, 'https://github.com/demo/one');
  assert.equal(links[2].url, 'https://github.com/demo/two');
  assert.deepEqual(parseImportLinks(' \n ,； '), []);
});
