// Milestone 5 GM Director Mode: live scene, private notes and beats, party status for the GM only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers.js');

test('director: GM-only notes and beats, live scene pushed per viewer', async (t) => {
  const { call, ok, listenTo, close } = await boot();
  const streams = [];
  t.after(() => { streams.forEach((s) => s.close()); return close(); });
  const user = async (name) => (await ok('POST', '/api/users', { name })).token;
  const gm = await user('Gm');
  const world = await ok('POST', '/api/worlds', { name: 'W', advancement: 'xp' }, gm);
  const camp = await ok('POST', `/api/worlds/${world.id}/campaigns`, { name: 'C' }, gm);
  const join = async (name, role = 'player') => {
    const tok = await user(name);
    await ok('POST', `/api/invites/${(await ok('POST', `/api/campaigns/${camp.id}/invites`, { role }, gm)).code}/accept`, {}, tok);
    return tok;
  };
  const [pat, viv] = [await join('Pat'), await join('Viv', 'spectator')];
  const town = await ok('POST', `/api/locations/${world.rootLocationId}/children`, { name: 'T', x: 1, y: 1, visibility: 'public' }, gm);
  const scene = await ok('POST', `/api/locations/${town.id}/scenes`, { name: 'Market', visibility: 'party' }, gm);
  const other = await ok('POST', '/api/worlds', { name: 'Other', advancement: 'xp' }, gm);
  const foreign = await ok('POST', `/api/locations/${other.rootLocationId}/scenes`, { name: 'X' }, gm);
  const director = (b, tok = gm) => call('PATCH', `/api/campaigns/${camp.id}/director`, b, tok);

  const [pL, vL] = await Promise.all([pat, viv].map((tok) => listenTo(`/api/campaigns/${camp.id}/chat/stream`, tok)));
  streams.push(pL, vL);
  assert.equal((await director({ notes: 'x' }, pat)).status, 403);
  assert.equal((await director({ liveSceneId: foreign.id })).status, 400);
  assert.equal((await director({ beats: [{ text: '' }] })).status, 400);
  await ok('PATCH', `/api/campaigns/${camp.id}/director`, { notes: 'The innkeeper is the cult leader.', beats: [{ text: 'Ambush at the bridge' }], liveSceneId: scene.id }, gm);
  assert.equal((await pL.until((m) => m.event === 'live')).data.sceneId, scene.id);
  assert.equal((await vL.until((m) => m.event === 'live')).data.sceneId, null, 'a party scene is not announced to spectators');

  const seen = async (tok) => (await ok('GET', `/api/worlds/${world.id}`, null, tok)).campaigns[0];
  const pc = await seen(pat);
  assert.deepEqual([pc.liveSceneId, pc.director, pc.voice], [scene.id, undefined, undefined]);
  assert.equal((await seen(viv)).liveSceneId, null);
  assert.ok(!JSON.stringify(await ok('GET', `/api/worlds/${world.id}`, null, pat)).includes('cult leader'));
  assert.equal((await seen(gm)).director.beats[0].text, 'Ambush at the bridge');
  assert.deepEqual((await ok('GET', `/api/worlds/${world.id}/scenes`, null, pat)).map((s) => s.name), ['Market']);
  assert.deepEqual((await ok('GET', `/api/worlds/${world.id}/scenes`, null, viv)), []);

  // Party status: HP and pending choices for the GM only.
  await ok('POST', `/api/campaigns/${camp.id}/characters`, { name: 'Brann', species: 'Dwarf', className: 'Fighter', background: 'Soldier', abilityMethod: 'standard',
    baseScores: { str: 15, dex: 14, con: 13, int: 8, wis: 12, cha: 10 }, backgroundBonus: { str: 2, con: 1 }, classSkills: ['Perception', 'Survival'] }, pat);
  const [g] = await ok('GET', `/api/campaigns/${camp.id}/characters`, null, gm);
  assert.deepEqual([g.hp.current, g.maxHp, g.armorClass, g.pendingChoices], [13, 13, 12, 1]);
  const [p] = await ok('GET', `/api/campaigns/${camp.id}/characters`, null, pat);
  assert.equal(p.hp, undefined);
  await ok('PATCH', `/api/campaigns/${camp.id}/director`, { liveSceneId: null }, gm);
  await pL.until((m) => m.event === 'live' && m.data.sceneId === null);
});
