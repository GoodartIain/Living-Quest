// Milestone 10 acceptance: a player undertakes a permitted independent side quest during downtime. The system resolves
// allowed events, queues consequential decisions and integrates approved outcomes into the campaign.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers.js');

async function setup(ok) {
  const user = async (name) => (await ok('POST', '/api/users', { name })).token;
  const gm = await user('Gm');
  const world = await ok('POST', '/api/worlds', { name: 'W', advancement: 'xp', npcAutonomy: 'reactive' }, gm);
  const camp = await ok('POST', `/api/worlds/${world.id}/campaigns`, { name: 'C' }, gm);
  const join = async (name, role = 'player') => {
    const tok = await user(name);
    await ok('POST', `/api/invites/${(await ok('POST', `/api/campaigns/${camp.id}/invites`, { role }, gm)).code}/accept`, {}, tok);
    return tok;
  };
  const [pat, ana, viv] = [await join('Pat'), await join('Ana'), await join('Viv', 'spectator')];
  const hero = (name, tok) => ok('POST', `/api/campaigns/${camp.id}/characters`, { name, species: 'Dwarf', className: 'Fighter', background: 'Soldier', abilityMethod: 'standard',
    baseScores: { str: 15, dex: 14, con: 13, int: 8, wis: 12, cha: 10 }, backgroundBonus: { str: 2, con: 1 }, classSkills: ['Perception', 'Survival'] }, tok);
  const brann = (await hero('Brann', pat)).character;
  const mira = (await hero('Mira', ana)).character;
  return { gm, world, camp, pat, ana, viv, brann, mira };
}

test('side quest in downtime: auto outcomes, GM-gated outcomes, escalation, publish integrates', async (t) => {
  const { call, ok, close } = await boot();
  t.after(close);
  const { gm, world, camp, pat, ana, viv, brann, mira } = await setup(ok);
  const place = (parent, name, extra = {}) => ok('POST', `/api/locations/${parent}/children`, { name, x: 5, y: 5, visibility: 'public', ...extra }, gm);
  const town = await place(world.rootLocationId, 'Greyhaven');
  const docks = await place(town.id, 'Docks');
  const cave = await place(town.id, 'Smugglers\' cave', { requiresDiscovery: true });
  const lore = await ok('POST', `/api/worlds/${world.id}/pages`, { title: 'The Black Sail', kind: 'faction', visibility: 'gm', body: 'A smuggling ring.' }, gm);
  await ok('POST', `/api/worlds/${world.id}/npcs`, { name: 'Harbourmaster', homeLocationId: town.id, visibility: 'party',
    schedule: [{ from: '00:00', locationId: docks.id, activity: 'Keeping watch' }], reactions: [{ on: 'raid', activity: 'Hiding in the office', locationId: 'stay', minutes: 600 }] }, gm);

  // Quest log: a personal quest only Pat sees, a hidden party quest.
  const personal = await ok('POST', `/api/campaigns/${camp.id}/quests`, { title: 'Clear my father\'s name', kind: 'personal', characterId: brann.id, objectives: [{ text: 'Find the ledger' }, { text: 'Confront the magistrate' }] }, gm);
  const ring = await ok('POST', `/api/campaigns/${camp.id}/quests`, { title: 'The smuggling ring', kind: 'main', visibility: 'gm', notes: 'GM-only plan' }, gm);
  assert.equal((await call('POST', `/api/campaigns/${camp.id}/quests`, { title: 'x' }, pat)).status, 403);
  assert.equal((await call('POST', `/api/campaigns/${camp.id}/quests`, { title: 'x', kind: 'personal' }, gm)).status, 400);
  const questsOf = async (tok) => (await ok('GET', `/api/campaigns/${camp.id}/quests`, null, tok)).map((q) => q.title);
  assert.deepEqual(await questsOf(pat), ['Clear my father\'s name']);
  assert.deepEqual(await questsOf(ana), []);
  assert.deepEqual(await questsOf(viv), []);

  // The adventure.
  const adv = {
    title: 'The missing ledger', summary: 'Find the ledger that proves your father innocent.', maxGp: 20, maxXp: 50,
    nodes: {
      start: { text: 'At dusk you reach the warehouse on the docks.', effects: [{ type: 'journal', text: 'I went looking for the ledger.' }],
        choices: [{ label: 'Sneak in', check: 'skill:Stealth', dc: 2, success: 'inside', failure: 'caught' }, { label: 'Bribe the guard', to: 'bribe' }] },
      inside: { text: 'INSIDE-TEXT: the ledger lies on a desk.',
        effects: [{ type: 'gp', amount: 15 }, { type: 'xp', amount: 30 }, { type: 'item', name: 'Smuggler\'s ledger', major: true },
          { type: 'quest', questId: personal.id, objectiveId: personal.objectives[0].id }, { type: 'discover', locationId: cave.id }],
        choices: [{ label: 'Search the crates', check: 'skill:Investigation', dc: 40, success: 'rich', failure: 'tunnel' }] },
      tunnel: { text: 'A tunnel leads to a cave full of contraband. You slip out and tip off the watch.',
        effects: [{ type: 'gp', amount: 10 }, { type: 'reveal', pageId: lore.id }, { type: 'event', kind: 'raid', locationId: docks.id }, { type: 'quest', questId: ring.id, reveal: true }, { type: 'item', name: 'Cursed idol', major: true }] },
      caught: { text: 'CAUGHT-TEXT', outcome: 'failure' },
      bribe: { text: 'BRIBE-TEXT: the guard lets you in, the ledger is gone.', outcome: 'failure' },
      rich: { text: 'RICH-TEXT' },
    },
  };
  assert.equal((await call('POST', `/api/worlds/${world.id}/adventures`, adv, pat)).status, 403);
  assert.equal((await call('POST', `/api/worlds/${world.id}/adventures`, { ...adv, nodes: { ...adv.nodes, rich: { text: 'x', choices: [{ label: 'go', to: 'nowhere' }] } } }, gm)).status, 400);
  assert.equal((await call('POST', `/api/worlds/${world.id}/adventures`, { ...adv, nodes: { ...adv.nodes, rich: { text: 'x', effects: [{ type: 'gp', amount: -5 }] } } }, gm)).status, 400);
  const a = await ok('POST', `/api/worlds/${world.id}/adventures`, adv, gm);
  assert.equal(a.start, 'start');
  assert.equal((await call('GET', `/api/worlds/${world.id}/adventures`, null, pat)).status, 403);

  // Downtime: the side quest is one permitted activity; Mira trains meanwhile.
  const w = await ok('POST', `/api/campaigns/${camp.id}/downtime`, { duration: 2, unit: 'weeks',
    activities: ['training', { key: 'ledger', name: 'Find the missing ledger', days: 3, adventureId: a.id }] }, gm);
  const book = (tok, b) => ok('POST', `/api/downtime/${w.id}/actions`, b, tok);
  const quest = await book(pat, { characterId: brann.id, activity: 'ledger', startDay: w.startDay });
  const train = await book(ana, { characterId: mira.id, activity: 'training', startDay: w.startDay });
  const runId = (await ok('GET', `/api/campaigns/${camp.id}/downtime`, null, pat)).windows[0].actions[0].runId;
  assert.ok(runId);

  // Players see only where they are; others cannot look in.
  let run = await ok('GET', `/api/quest-runs/${runId}`, null, pat);
  assert.equal(run.node.text, 'At dusk you reach the warehouse on the docks.');
  assert.deepEqual(run.node.choices.map((c) => c.label), ['Sneak in', 'Bribe the guard']);
  for (const secret of ['INSIDE-TEXT', 'CAUGHT-TEXT', 'BRIBE-TEXT', 'inside', 'tunnel']) assert.ok(!JSON.stringify(run).includes(secret), secret);
  assert.equal((await call('GET', `/api/quest-runs/${runId}`, null, ana)).status, 404);
  assert.equal((await call('GET', `/api/quest-runs/${runId}`, null, viv)).status, 404);
  assert.equal((await call('POST', `/api/quest-runs/${runId}/choose`, { index: 0 }, ana)).status, 404);
  assert.equal((await call('POST', `/api/quest-runs/${runId}/choose`, { index: 0 }, gm)).status, 403, 'the player plays, not the GM');

  // Play: the Stealth check (DC 2) succeeds, the Investigation check (DC 40) fails into the tunnel ending.
  run = await ok('POST', `/api/quest-runs/${runId}/choose`, { index: 0 }, pat);
  assert.ok(run.node.text.startsWith('INSIDE-TEXT'));
  assert.equal(run.path[0].roll.success, true);
  assert.ok(/^1d20[+-]\d+$/.test(run.path[0].roll.formula), 'rolled from the sheet');
  run = await ok('POST', `/api/quest-runs/${runId}/choose`, { index: 0 }, pat);
  assert.equal(run.status, 'finished');
  assert.equal(run.outcome, 'success');
  assert.equal((await call('POST', `/api/quest-runs/${runId}/choose`, { index: 0 }, pat)).status, 409);
  const byLabel = Object.fromEntries(run.effects.map((e) => [e.label, e.status]));
  assert.deepEqual(byLabel, {
    'Journal: I went looking for the ledger.': 'auto', '15 gp': 'auto', '30 XP': 'auto', 'Item: Smuggler\'s ledger': 'pending',
    'Quest "Clear my father\'s name": objective "Find the ledger" done': 'auto', 'Discover Smugglers\' cave': 'auto',
    '10 gp': 'pending', 'Reveal wiki page "The Black Sail" to players': 'pending', 'World event "raid" at Docks': 'pending',
    'Quest "The smuggling ring" (revealed)': 'auto', 'Item: Cursed idol': 'pending',
  }, 'within limits resolves itself; major loot, gold past the limit, canon and world events wait for the GM');

  // Nothing has touched the campaign yet.
  const gpBefore = (await ok('GET', `/api/characters/${brann.id}`, null, gm)).character.currency.gp;
  assert.equal((await call('GET', `/api/locations/${cave.id}`, null, pat)).status, 404);
  assert.equal((await call('GET', `/api/pages/${lore.id}`, null, pat)).status, 404);
  let action = (await ok('GET', `/api/campaigns/${camp.id}/downtime`, null, gm)).windows[0].actions.find((x) => x.id === quest.id);
  assert.equal(action.status, 'resolved');
  assert.deepEqual([action.outcome.rewardGp, action.outcome.rewardXp], [15, 30]);

  // The GM must decide the queued outcomes before approving the activity.
  assert.equal((await call('PATCH', `/api/downtime-actions/${quest.id}`, { status: 'approved' }, gm)).status, 409);
  assert.equal((await call('PATCH', `/api/quest-runs/${runId}/effects`, { decisions: { 1: 'approved' } }, gm)).status, 400, 'automatic ones need no decision');
  assert.equal((await call('PATCH', `/api/quest-runs/${runId}/effects`, { decisions: { 3: 'approved' } }, pat)).status, 403);
  const brannRun = run;
  const idx = (label) => brannRun.effects.find((e) => e.label === label).i;
  await ok('PATCH', `/api/quest-runs/${runId}/effects`, { decisions: { [idx('Item: Smuggler\'s ledger')]: 'approved', [idx('10 gp')]: 'rejected',
    [idx('Reveal wiki page "The Black Sail" to players')]: 'approved', [idx('World event "raid" at Docks')]: 'approved', [idx('Item: Cursed idol')]: 'rejected' } }, gm);
  action = (await ok('GET', `/api/campaigns/${camp.id}/downtime`, null, gm)).windows[0].actions.find((x) => x.id === quest.id);
  assert.equal(action.status, 'approved', 'all decided: the activity is approved');

  // Escalation: Ana's Mira tries the same adventure and asks for something it does not cover.
  await ok('PATCH', `/api/downtime-actions/${train.id}`, { status: 'rejected' }, gm);
  await book(ana, { characterId: mira.id, activity: 'ledger', startDay: w.startDay + 5 });
  const miraRun = (await ok('GET', `/api/campaigns/${camp.id}/downtime`, null, ana)).windows[0].actions.find((x) => x.runId).runId;
  assert.equal((await call('PATCH', `/api/adventures/${a.id}`, { title: 'Renamed' }, gm)).status, 409, 'not edited while someone plays');
  run = await ok('POST', `/api/quest-runs/${miraRun}/ask`, { text: 'Can I bribe the harbourmaster for the key instead?' }, ana);
  assert.equal(run.status, 'waiting');
  assert.equal((await call('POST', `/api/quest-runs/${miraRun}/choose`, { index: 1 }, ana)).status, 409);
  assert.equal((await call('POST', `/api/quest-runs/${miraRun}/answer`, { text: 'He takes the coin and sends you round the back.' }, gm)).status, 400);
  run = await ok('POST', `/api/quest-runs/${miraRun}/answer`, { text: 'He takes the coin and sends you round the back.', to: 'bribe' }, gm);
  assert.deepEqual([run.status, run.outcome], ['finished', 'failure']);
  const miraView = await ok('GET', `/api/quest-runs/${miraRun}`, null, ana);
  assert.equal(miraView.path.at(-1).answer, 'He takes the coin and sends you round the back.');
  assert.equal((await ok('GET', `/api/campaigns/${camp.id}/downtime`, null, ana)).windows[0].actions.find((x) => x.runId === miraRun).status, 'approved',
    'nothing consequential: it resolved itself');

  // Publish integrates the approved outcomes.
  const pub = await ok('POST', `/api/downtime/${w.id}/publish`, {}, gm);
  const sheet = await ok('GET', `/api/characters/${brann.id}`, null, pat);
  assert.equal(sheet.character.currency.gp, gpBefore + 15, 'the rejected 10 gp is not paid');
  assert.equal(sheet.xp, 30);
  assert.equal(sheet.character.inventory.filter((i) => i.name === 'Smuggler\'s ledger').length, 1);
  assert.ok(!sheet.character.inventory.some((i) => i.name === 'Cursed idol'), 'a rejected outcome never lands');
  assert.ok(sheet.character.journal.some((j) => j.text === 'I went looking for the ledger.'));
  assert.equal((await ok('GET', `/api/locations/${cave.id}`, null, pat)).location.name, 'Smugglers\' cave', 'discovered for this campaign');
  assert.equal((await ok('GET', `/api/pages/${lore.id}`, null, pat)).page.title, 'The Black Sail');
  const patQuests = await ok('GET', `/api/campaigns/${camp.id}/quests`, null, pat);
  assert.deepEqual(patQuests.find((q) => q.id === personal.id).objectives.map((o) => o.done), [true, false]);
  const ringSeen = patQuests.find((q) => q.id === ring.id);
  assert.ok(ringSeen && ringSeen.notes === undefined, 'revealed to players, GM notes still hidden');
  assert.deepEqual(await questsOf(ana), ['The smuggling ring'], 'Ana sees the revealed party quest but not Brann\'s personal one');
  const log = await ok('GET', `/api/campaigns/${camp.id}/npc-log`, null, gm);
  assert.ok(log.some((x) => x.kind === 'event' && /raid at Docks/.test(x.text) && /side quest/.test(x.text)));
  assert.ok(log.some((x) => x.kind === 'reacted' && /Harbourmaster reacts to the raid/.test(x.text)), 'NPCs react to the outcome');
  const line = pub.report.characters.find((x) => x.name === 'Brann').timeline[0];
  assert.ok(line.effects.includes('Item: Smuggler\'s ledger') && line.effects.includes('Discover Smugglers\' cave') && !line.effects.includes('10 gp'));
  assert.equal((await call('PATCH', `/api/quest-runs/${runId}/effects`, { decisions: { [idx('10 gp')]: 'approved' } }, gm)).status, 409, 'closed after publish');
});

test('side quest: cancelling the activity closes the run; unfinished runs block approval', async (t) => {
  const { call, ok, close } = await boot();
  t.after(close);
  const { gm, world, camp, pat, brann } = await setup(ok);
  const a = await ok('POST', `/api/worlds/${world.id}/adventures`, { title: 'Short', nodes: { start: { text: 'Go?', choices: [{ label: 'Yes', to: 'end' }] }, end: { text: 'Done', effects: [{ type: 'gp', amount: 5 }] } } }, gm);
  const w = await ok('POST', `/api/campaigns/${camp.id}/downtime`, { duration: 5, activities: [{ key: 'short', name: 'Short', days: 1, adventureId: a.id }] }, gm);
  const act = await ok('POST', `/api/downtime/${w.id}/actions`, { characterId: brann.id, activity: 'short', startDay: w.startDay }, pat);
  const runId = (await ok('GET', `/api/campaigns/${camp.id}/downtime`, null, pat)).windows[0].actions[0].runId;
  assert.equal((await call('PATCH', `/api/downtime-actions/${act.id}`, { status: 'approved', outcome: { success: true } }, gm)).status, 409, 'not finished');
  await ok('DELETE', `/api/downtime-actions/${act.id}`, null, pat);
  assert.equal((await call('POST', `/api/quest-runs/${runId}/choose`, { index: 0 }, pat)).status, 409);
  assert.equal((await ok('GET', `/api/quest-runs/${runId}`, null, gm)).status, 'abandoned');
});

test('interaction triggers: markers, adjacency, fog reveal, hidden token, NPC event, once', async (t) => {
  const { call, ok, close } = await boot();
  t.after(close);
  const { gm, world, camp, pat, viv, brann } = await setup(ok);
  const town = await ok('POST', `/api/locations/${world.rootLocationId}/children`, { name: 'Greyhaven', x: 1, y: 1, visibility: 'public' }, gm);
  await ok('POST', `/api/worlds/${world.id}/npcs`, { name: 'Guard', visibility: 'party', schedule: [{ from: '00:00', locationId: town.id, activity: 'Patrolling' }],
    reactions: [{ on: 'alarm', activity: 'Running to the bell', locationId: 'stay', minutes: 30 }] }, gm);
  const scene = await ok('POST', `/api/locations/${town.id}/scenes`, { name: 'Square', visibility: 'public', cols: 10, rows: 8 }, gm);
  const me = (await ok('GET', `/api/worlds/${world.id}`, null, gm)).members.find((m) => m.name === 'Pat').userId;
  const tok = await ok('POST', `/api/scenes/${scene.id}/tokens`, { name: 'x', x: 0, y: 0, characterId: brann.id, controlledBy: [me] }, gm);
  const thief = await ok('POST', `/api/scenes/${scene.id}/tokens`, { name: 'Thief', x: 8, y: 6, visibility: 'gm' }, gm);
  await ok('PATCH', `/api/scenes/${scene.id}`, { fogEnabled: true }, gm);
  await ok('POST', `/api/scenes/${scene.id}/fog`, { x0: 0, y0: 0, x1: 5, y1: 5, reveal: true }, gm);
  const bell = await ok('POST', `/api/scenes/${scene.id}/triggers`, { name: 'Alarm bell', x: 4, y: 4, text: 'The bell rings out over the square.', once: true,
    revealFog: { x0: 6, y0: 4, x1: 9, y1: 7 }, showTokenId: thief.id, event: { kind: 'alarm' } }, gm);
  await ok('POST', `/api/scenes/${scene.id}/triggers`, { name: 'Secret lever', x: 7, y: 7 }, gm); // under fog
  assert.equal((await call('POST', `/api/scenes/${scene.id}/triggers`, { name: 'x' }, pat)).status, 403);

  const view = async (who) => (await ok('GET', `/api/scenes/${scene.id}`, null, who)).triggers;
  assert.deepEqual(await view(pat), [{ id: bell.id, name: 'Alarm bell', x: 4, y: 4 }], 'name and place only; the fogged lever is hidden');
  assert.equal((await view(gm)).length, 2);
  assert.equal((await call('POST', `/api/triggers/${bell.id}/interact`, {}, pat)).status, 409, 'too far away');
  assert.equal((await call('POST', `/api/triggers/${bell.id}/interact`, {}, viv)).status, 403);
  await ok('PATCH', `/api/tokens/${tok.id}`, { x: 3, y: 3 }, pat);
  const out = await ok('POST', `/api/triggers/${bell.id}/interact`, {}, pat);
  assert.equal(out.text, 'The bell rings out over the square.');
  assert.equal(out.shown, 'Thief');
  assert.ok(out.revealed > 0);
  assert.deepEqual(out.event.reacted.map((x) => x.name), ['Guard']);
  const after = await ok('GET', `/api/scenes/${scene.id}`, null, pat);
  assert.ok(after.tokens.some((x) => x.name === 'Thief'), 'the hidden thief is revealed and the fog lifted around him');
  assert.equal((await call('POST', `/api/triggers/${bell.id}/interact`, {}, pat)).status, 409, 'once');
  assert.equal(after.triggers.find((x) => x.id === bell.id), undefined, 'a used one-off marker disappears');
  assert.ok(after.triggers.some((x) => x.name === 'Secret lever'), 'the lever is in the revealed area now');
  assert.ok(camp);
});
