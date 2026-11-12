// Milestone 3: 2D scenes, tokens, fog of war, encounters, and realtime push over Server-Sent Events.
// Every push is projected per recipient, so hidden tokens never reach a player's browser.
'use strict';

// `hooks` is filled in by the characters module (tokenInfo, sceneRolls), which is created after this one.
module.exports = function tabletop({ db, find, fail, need, viewer, record, id, SEES, VISIBILITY, check, hooks }) {
  const { str, oneOf, bool, num } = check;
  const subscribers = new Set(); // { res, user, sceneId }
  const cell = (t) => `${Math.floor(t.x)},${Math.floor(t.y)}`; // shortcut: a large token counts as its top-left cell for fog; use its footprint when tokens >1 cell matter

  // Walls run along grid lines between cell corners (x 0..cols, y 0..rows), horizontal or vertical.
  function validWalls(list, cols, rows) {
    if (!Array.isArray(list) || list.length > 500) fail(400, 'walls must be a list of up to 500');
    return list.map((w) => {
      const [x1, y1, x2, y2] = [num(w.x1, 'x1', 0, cols, true), num(w.y1, 'y1', 0, rows, true), num(w.x2, 'x2', 0, cols, true), num(w.y2, 'y2', 0, rows, true)];
      if ((x1 === x2) === (y1 === y2)) fail(400, 'a wall runs along one grid line and has a length');
      return { x1, y1, x2, y2 };
    });
  }
  // Players under fog get only the unit wall pieces that border a revealed cell, so unexplored layout stays hidden.
  function visibleWalls(walls, revealed) {
    const out = [];
    for (const w of walls) {
      const horizontal = w.y1 === w.y2;
      const [a, b] = horizontal ? [Math.min(w.x1, w.x2), Math.max(w.x1, w.x2)] : [Math.min(w.y1, w.y2), Math.max(w.y1, w.y2)];
      for (let i = a; i < b; i++) {
        const near = horizontal ? [`${i},${w.y1 - 1}`, `${i},${w.y1}`] : [`${w.x1 - 1},${i}`, `${w.x1},${i}`];
        if (near.some((k) => revealed.has(k))) out.push(horizontal ? { x1: i, y1: w.y1, x2: i + 1, y2: w.y1 } : { x1: w.x1, y1: i, x2: w.x1, y2: i + 1 });
      }
    }
    return out;
  }

  function sceneView(user, scene) {
    const v = viewer(user, scene.worldId);
    if (!v.seesLoc(find('locations', scene.locationId)) || !SEES[v.role].includes(scene.visibility)) fail(404, 'scene not found');
    const gm = v.role === 'gm';
    const revealed = new Set(scene.fog.revealed);
    const sees = (t) => gm || (SEES[v.role].includes(t.visibility) &&
      (!scene.fog.enabled || revealed.has(cell(t)) || t.controlledBy.includes(user.id)));
    const tokens = db.tokens.filter((t) => t.sceneId === scene.id && sees(t)).map((t) => {
      const out = { ...t, mine: gm || t.controlledBy.includes(user.id) };
      if (t.pageId && !v.seesPage(find('pages', t.pageId))) out.pageId = null;
      if (t.characterId) {
        out.character = hooks.tokenInfo(t.characterId, out.mine);
        if (out.character) out.name = out.character.name; // the character sheet is the single source of the name
      }
      if (!gm) delete out.controlledBy;
      return out;
    });
    const ids = new Set(tokens.map((t) => t.id));
    const enc = scene.encounter;
    const current = enc && enc.combatants[enc.turn];
    return {
      role: v.role,
      scene: { ...scene, fog: { enabled: scene.fog.enabled, revealed: scene.fog.enabled || gm ? scene.fog.revealed : [] }, encounter: undefined,
        walls: gm || !scene.fog.enabled ? scene.walls : visibleWalls(scene.walls, revealed) },
      tokens,
      encounter: enc && {
        round: enc.round,
        turnTokenId: current && ids.has(current.tokenId) ? current.tokenId : null,
        combatants: enc.combatants.filter((c) => ids.has(c.tokenId)),
      },
      rolls: hooks.sceneRolls(user, v.role, scene.id),
    };
  }

  function publish(sceneId) {
    if (hooks.onScene) hooks.onScene(sceneId); // the livestream follows the same changes
    for (const s of subscribers) {
      if (s.sceneId !== sceneId) continue;
      try { s.res.write(`data: ${JSON.stringify(sceneView(s.user, find('scenes', sceneId)))}\n\n`); }
      catch { s.res.end('event: gone\ndata: {}\n\n'); } // access was revoked or the scene hidden: close the stream
    }
  }
  // Token moves are stored but not logged: the event log is for consequential changes, not every drag.
  function changed(scene, actor, type, data) {
    if (type) record(actor, type, data);
    publish(scene.id);
  }
  const gmScene = (u, sceneId) => { const s = find('scenes', sceneId); need(u, s.worldId, 'gm'); return s; };
  const inBounds = (s, x, y, size = 1) => {
    num(x, 'x', 0, s.cols - size); num(y, 'y', 0, s.rows - size);
    return s.grid === 'square' ? [Math.round(x), Math.round(y)] : [x, y];
  };
  function controllers(worldId, list) {
    if (!Array.isArray(list) || list.length > 20) fail(400, 'controlledBy must be a list of user ids');
    const members = new Set(db.memberships.filter((m) => m.worldId === worldId && m.role === 'player').map((m) => m.userId));
    for (const u of list) if (!members.has(u)) fail(400, 'controlledBy may only name players of this world');
    return [...new Set(list)];
  }
  function sortedCombatants(worldId, sceneId, list) {
    if (!Array.isArray(list) || !list.length || list.length > 100) fail(400, 'combatants must be a non-empty list');
    const seen = new Set();
    return list.map((c) => {
      const t = find('tokens', c.tokenId);
      if (t.sceneId !== sceneId || seen.has(t.id)) fail(400, 'combatants must be distinct tokens in this scene');
      seen.add(t.id);
      return { tokenId: t.id, initiative: num(c.initiative ?? 0, 'initiative', -100, 100) };
    }).sort((a, b) => b.initiative - a.initiative);
  }

  const routes = {
    'POST /api/locations/:id/scenes': (u, b, p) => {
      const loc = find('locations', p.id);
      need(u, loc.worldId, 'gm');
      const scene = { id: id(), worldId: loc.worldId, locationId: loc.id, name: str(b.name, 'name', 120),
        grid: oneOf(b.grid ?? 'square', ['square', 'none'], 'grid'),
        cols: num(b.cols ?? 20, 'cols', 1, 200, true), rows: num(b.rows ?? 15, 'rows', 1, 200, true),
        backgroundUrl: b.backgroundUrl ? check.safeUrl(b.backgroundUrl) : '',
        visibility: oneOf(b.visibility ?? 'gm', VISIBILITY, 'visibility'), // scenes start hidden until the GM shares them
        fog: { enabled: false, revealed: [] }, encounter: null, walls: [] };
      db.scenes.push(scene);
      record(u.id, 'scene.created', { sceneId: scene.id, locationId: loc.id });
      return scene;
    },
    'GET /api/scenes/:id': (u, _b, p) => sceneView(u, find('scenes', p.id)),
    'PATCH /api/scenes/:id': (u, b, p) => {
      const s = gmScene(u, p.id);
      const c = {};
      if (b.name !== undefined) c.name = str(b.name, 'name', 120);
      if (b.grid !== undefined) c.grid = oneOf(b.grid, ['square', 'none'], 'grid');
      if (b.cols !== undefined) c.cols = num(b.cols, 'cols', 1, 200, true);
      if (b.rows !== undefined) c.rows = num(b.rows, 'rows', 1, 200, true);
      if (b.backgroundUrl !== undefined) c.backgroundUrl = b.backgroundUrl ? check.safeUrl(b.backgroundUrl) : '';
      if (b.visibility !== undefined) c.visibility = oneOf(b.visibility, VISIBILITY, 'visibility');
      if (b.fogEnabled !== undefined) c.fog = { ...s.fog, enabled: bool(b.fogEnabled, 'fogEnabled') };
      if (b.walls !== undefined) c.walls = validWalls(b.walls, c.cols ?? s.cols, c.rows ?? s.rows);
      if (!Object.keys(c).length) fail(400, 'nothing to change');
      if ((c.cols ?? s.cols) < s.cols || (c.rows ?? s.rows) < s.rows) {
        const [cols, rows] = [c.cols ?? s.cols, c.rows ?? s.rows];
        if (db.tokens.some((t) => t.sceneId === s.id && (t.x + t.size > cols || t.y + t.size > rows))) fail(409, 'move tokens inside the new size first');
        if ((c.walls ?? s.walls).some((w) => Math.max(w.x1, w.x2) > cols || Math.max(w.y1, w.y2) > rows)) fail(409, 'remove walls outside the new size first');
      }
      Object.assign(s, c);
      changed(s, u.id, 'scene.updated', { sceneId: s.id, fields: Object.keys(c) });
      return s;
    },
    // Reveal or hide a rectangle of cells (inclusive).
    'POST /api/scenes/:id/fog': (u, b, p) => {
      const s = gmScene(u, p.id);
      const [x0, x1] = [num(b.x0, 'x0', 0, s.cols - 1, true), num(b.x1, 'x1', 0, s.cols - 1, true)].sort((a, c) => a - c);
      const [y0, y1] = [num(b.y0, 'y0', 0, s.rows - 1, true), num(b.y1, 'y1', 0, s.rows - 1, true)].sort((a, c) => a - c);
      const reveal = bool(b.reveal, 'reveal');
      const set = new Set(s.fog.revealed);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) set[reveal ? 'add' : 'delete'](`${x},${y}`);
      s.fog.revealed = [...set];
      changed(s, u.id, 'scene.fog', { sceneId: s.id, x0, y0, x1, y1, reveal });
      return { revealed: s.fog.revealed.length };
    },
    'POST /api/scenes/:id/tokens': (u, b, p) => {
      const s = gmScene(u, p.id);
      const size = num(b.size ?? 1, 'size', 1, 6, true);
      const [x, y] = inBounds(s, b.x, b.y, size);
      if (b.pageId != null && find('pages', b.pageId).worldId !== s.worldId) fail(400, 'page belongs to another world');
      const ch = b.characterId != null ? find('characters', b.characterId) : null;
      if (ch && ch.worldId !== s.worldId) fail(400, 'character belongs to another world');
      // A character's token is moved by its owner unless the GM says otherwise.
      const ownerPlays = ch && db.memberships.some((m) => m.userId === ch.ownerId && m.worldId === s.worldId && m.role === 'player');
      if (b.controlledBy === undefined && ownerPlays) b.controlledBy = [ch.ownerId];
      const t = { id: id(), worldId: s.worldId, sceneId: s.id, name: str(b.name, 'name', 60), x, y, size,
        color: /^#[0-9a-f]{6}$/i.test(b.color ?? '') ? b.color : '#7a4b1f',
        visibility: oneOf(b.visibility ?? 'party', VISIBILITY, 'visibility'),
        controlledBy: controllers(s.worldId, b.controlledBy ?? []), pageId: b.pageId ?? null, characterId: ch ? ch.id : null, npcId: null };
      db.tokens.push(t);
      changed(s, u.id, 'token.created', { tokenId: t.id, sceneId: s.id });
      return t;
    },
    // Controllers may move their tokens; everything else is GM-only.
    'PATCH /api/tokens/:id': (u, b, p) => {
      const t = find('tokens', p.id);
      const s = find('scenes', t.sceneId);
      const role = need(u, t.worldId, 'player');
      const gm = role === 'gm';
      if (!gm && !t.controlledBy.includes(u.id)) fail(403, 'not your token');
      if (!gm && Object.keys(b).some((k) => k !== 'x' && k !== 'y')) fail(403, 'players may only move their tokens');
      if (!gm && !sceneView(u, s).tokens.some((x) => x.id === t.id)) fail(404, 'token not found');
      const c = {};
      if (b.size !== undefined) c.size = num(b.size, 'size', 1, 6, true);
      if (b.x !== undefined || b.y !== undefined) [c.x, c.y] = inBounds(s, b.x ?? t.x, b.y ?? t.y, c.size ?? t.size);
      if (b.name !== undefined) c.name = str(b.name, 'name', 60);
      if (b.visibility !== undefined) c.visibility = oneOf(b.visibility, VISIBILITY, 'visibility');
      if (b.controlledBy !== undefined) c.controlledBy = controllers(t.worldId, b.controlledBy);
      if (!Object.keys(c).length) fail(400, 'nothing to change');
      Object.assign(t, c);
      const moveOnly = Object.keys(c).every((k) => k === 'x' || k === 'y');
      changed(s, u.id, moveOnly ? null : 'token.updated', { tokenId: t.id, fields: Object.keys(c) });
      return t;
    },
    'DELETE /api/tokens/:id': (u, _b, p) => {
      const t = find('tokens', p.id);
      const s = gmScene(u, t.sceneId);
      db.tokens.splice(db.tokens.indexOf(t), 1);
      if (s.encounter) {
        const cur = s.encounter.combatants[s.encounter.turn];
        s.encounter.combatants = s.encounter.combatants.filter((c) => c.tokenId !== t.id);
        if (!s.encounter.combatants.length) s.encounter = null;
        else s.encounter.turn = Math.max(0, s.encounter.combatants.findIndex((c) => c === cur));
      }
      changed(s, u.id, 'token.deleted', t);
      return { ok: true };
    },
    // Start or replace the initiative order (sorted high → low); the round and current turn reset.
    'PUT /api/scenes/:id/encounter': (u, b, p) => {
      const s = gmScene(u, p.id);
      const keep = s.encounter && s.encounter.combatants[s.encounter.turn];
      const combatants = sortedCombatants(s.worldId, s.id, b.combatants);
      const turn = keep ? Math.max(0, combatants.findIndex((c) => c.tokenId === keep.tokenId)) : 0;
      s.encounter = { round: s.encounter ? s.encounter.round : 1, turn, combatants };
      changed(s, u.id, 'encounter.set', { sceneId: s.id, combatants });
      return s.encounter;
    },
    'POST /api/scenes/:id/encounter/next': (u, _b, p) => {
      const s = gmScene(u, p.id);
      if (!s.encounter) fail(409, 'no encounter running');
      s.encounter.turn = (s.encounter.turn + 1) % s.encounter.combatants.length;
      if (s.encounter.turn === 0) s.encounter.round++;
      changed(s, u.id, 'encounter.turn', { sceneId: s.id, round: s.encounter.round, tokenId: s.encounter.combatants[s.encounter.turn].tokenId });
      return s.encounter;
    },
    'DELETE /api/scenes/:id/encounter': (u, _b, p) => {
      const s = gmScene(u, p.id);
      s.encounter = null;
      changed(s, u.id, 'encounter.ended', { sceneId: s.id });
      return { ok: true };
    },
  };

  function stream(req, res, user, sceneId) {
    const first = sceneView(user, find('scenes', sceneId)); // throws before headers if not allowed
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(first)}\n\n`);
    const sub = { res, user, sceneId };
    subscribers.add(sub);
    const beat = setInterval(() => res.write(': keep-alive\n\n'), 25000);
    req.on('close', () => { clearInterval(beat); subscribers.delete(sub); });
  }

  routes['GET /api/worlds/:id/scenes'] = (u, _b, p) => {
    need(u, p.id, 'spectator');
    return db.scenes.filter((s) => s.worldId === p.id && canSee(u, s))
      .map((s) => ({ id: s.id, name: s.name, visibility: s.visibility, locationId: s.locationId, location: find('locations', s.locationId).name }));
  };
  const scenesAt = (role, locId) => db.scenes.filter((s) => s.locationId === locId && SEES[role].includes(s.visibility))
    .map((s) => ({ id: s.id, name: s.name, visibility: s.visibility }));

  const canSee = (user, scene) => { try { sceneView(user, scene); return true; } catch { return false; } };
  return { routes, stream, scenesAt, subscribers, publish, canSee, sceneView };
};
