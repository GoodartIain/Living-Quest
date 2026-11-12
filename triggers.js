// Milestone 10: interaction triggers. A GM places a marker on a scene cell (a lever, a strange altar, an alarm bell).
// A player whose token stands next to it can use it: the server shows its text and runs its actions (reveal a fog area,
// reveal a hidden token, fire a world event that NPCs react to). Players see only a marker's name, never its actions,
// and only when the cell is visible to them.
'use strict';

module.exports = function triggers({ db, find, fail, need, record, id, check, VISIBILITY, SEES, publishScene, people }) {
  const { str, oneOf, num, bool } = check;
  const cellOk = (s, x, y) => [num(x, 'x', 0, s.cols - 1, true), num(y, 'y', 0, s.rows - 1, true)];
  function fields(s, b) {
    const out = {};
    if (b.name !== undefined) out.name = str(b.name, 'name', 60);
    if (b.text !== undefined) out.text = typeof b.text === 'string' ? b.text.slice(0, 2000) : '';
    if (b.x !== undefined || b.y !== undefined) [out.x, out.y] = cellOk(s, b.x, b.y);
    if (b.visibility !== undefined) out.visibility = oneOf(b.visibility, VISIBILITY, 'visibility');
    if (b.once !== undefined) out.once = bool(b.once, 'once');
    if (b.revealFog !== undefined) {
      if (b.revealFog === null) out.revealFog = null;
      else { const [x0, y0] = cellOk(s, b.revealFog.x0, b.revealFog.y0); const [x1, y1] = cellOk(s, b.revealFog.x1, b.revealFog.y1); out.revealFog = { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) }; }
    }
    if (b.showTokenId !== undefined) {
      if (b.showTokenId !== null && find('tokens', b.showTokenId).sceneId !== s.id) fail(400, 'that token is on another scene');
      out.showTokenId = b.showTokenId;
    }
    if (b.event !== undefined) {
      if (b.event === null) out.event = null;
      else {
        const where = b.event.locationId ?? s.locationId; // default: the place the scene is at, and everything inside it
        if (find('locations', where).worldId !== s.worldId) fail(400, 'location belongs to another world');
        out.event = { kind: str(b.event.kind, 'event name', 40).toLowerCase(), locationId: where };
      }
    }
    return out;
  }

  // For sceneView: what of a scene's triggers this viewer may see. `visibleCell(x, y)` applies fog for non-GMs.
  function forScene(role, scene, visibleCell) {
    const list = db.triggers.filter((t) => t.sceneId === scene.id);
    if (role === 'gm') return list;
    return list.filter((t) => SEES[role].includes(t.visibility) && visibleCell(t.x, t.y) && !(t.once && t.usedAt)).map((t) => ({ id: t.id, name: t.name, x: t.x, y: t.y }));
  }

  const routes = {
    'POST /api/scenes/:id/triggers': (u, b, p) => {
      const s = find('scenes', p.id);
      need(u, s.worldId, 'gm');
      const t = { id: id(), worldId: s.worldId, sceneId: s.id, name: '', text: '', x: 0, y: 0, visibility: 'party', once: false, revealFog: null, showTokenId: null, event: null, usedAt: null,
        ...fields(s, { x: 0, y: 0, ...b }) };
      if (!t.name) fail(400, 'name must be a non-empty string up to 60 chars');
      db.triggers.push(t);
      record(u.id, 'trigger.created', { triggerId: t.id, sceneId: s.id });
      publishScene(s.id);
      return t;
    },
    'PATCH /api/triggers/:id': (u, b, p) => {
      const t = find('triggers', p.id);
      need(u, t.worldId, 'gm');
      const ch = fields(find('scenes', t.sceneId), b);
      if (b.reset === true) ch.usedAt = null;
      if (!Object.keys(ch).length) fail(400, 'nothing to change');
      Object.assign(t, ch);
      record(u.id, 'trigger.updated', { triggerId: t.id, fields: Object.keys(ch) });
      publishScene(t.sceneId);
      return t;
    },
    'DELETE /api/triggers/:id': (u, _b, p) => {
      const t = find('triggers', p.id);
      need(u, t.worldId, 'gm');
      db.triggers.splice(db.triggers.indexOf(t), 1);
      record(u.id, 'trigger.deleted', { triggerId: t.id });
      publishScene(t.sceneId);
      return { ok: true };
    },
    // Use a trigger. Players need a token they control on a cell next to it (or on it); the GM can always use it.
    'POST /api/triggers/:id/interact': (u, _b, p) => {
      const t = find('triggers', p.id);
      const s = find('scenes', t.sceneId);
      const role = need(u, t.worldId, 'player');
      const gm = role === 'gm';
      if (!gm) {
        const revealed = new Set(s.fog.revealed);
        const visible = SEES[role].includes(s.visibility) && SEES[role].includes(t.visibility) && (!s.fog.enabled || revealed.has(`${t.x},${t.y}`));
        if (!visible) fail(404, 'trigger not found');
        const near = db.tokens.some((k) => k.sceneId === s.id && k.controlledBy.includes(u.id) &&
          t.x >= k.x - 1 && t.x <= k.x + k.size && t.y >= k.y - 1 && t.y <= k.y + k.size);
        if (!near) fail(409, `move your token next to ${t.name} first`);
      }
      if (t.once && t.usedAt) fail(409, `${t.name} has already been used`);
      const out = { name: t.name, text: t.text, revealed: 0, shown: null, event: null };
      if (t.revealFog && s.fog.enabled) {
        const open = new Set(s.fog.revealed);
        for (let x = t.revealFog.x0; x <= t.revealFog.x1; x++) for (let y = t.revealFog.y0; y <= t.revealFog.y1; y++) if (!open.has(`${x},${y}`)) { open.add(`${x},${y}`); out.revealed++; }
        s.fog = { ...s.fog, revealed: [...open] };
      }
      if (t.showTokenId) {
        const k = db.tokens.find((x) => x.id === t.showTokenId);
        if (k && k.visibility === 'gm') { k.visibility = 'party'; out.shown = k.name; }
      }
      if (t.event) {
        const c = people.campaignFor(u, t.worldId, role);
        if (c) out.event = people.worldEvent(c, u.id, t.event.kind, t.event.locationId, `${t.name} used by ${u.name}`, 'scene trigger');
      }
      t.usedAt = new Date().toISOString();
      record(u.id, 'trigger.used', { triggerId: t.id, sceneId: s.id, revealed: out.revealed, shown: out.shown, event: t.event && t.event.kind });
      publishScene(s.id);
      return out;
    },
  };
  return { routes, forScene };
};
