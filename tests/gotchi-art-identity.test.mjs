import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectCartridgeHero } from '../scripts/gotchi-art.mjs';

const link = { id: 'owned-7', sourceTokenId: '7', active: true, collateral: 'link' };
const roster = [link, { id: 'starter-dai-h1-1', collateral: 'dai' }];

test('missing explicit starter does not render the active gotchi', () => {
  assert.equal(selectCartridgeHero(roster, 'starter-wbtc-h1-1', link.id), null);
  assert.equal(selectCartridgeHero([{ id: 'other', sourceTokenId: '' }], 'starter-wbtc-h1-1'), null);
});

test('explicit identity matches only its ID or owned token, while no selection may use active', () => {
  assert.equal(selectCartridgeHero(roster, 'starter-dai-h1-1'), roster[1]);
  assert.equal(selectCartridgeHero([{ ...link, id: 'cartridge-7' }], 'owned-7').sourceTokenId, '7');
  assert.equal(selectCartridgeHero(roster, null, link.id), link);
  assert.equal(selectCartridgeHero([], null), null);
});
