// Living Quest — server for Milestones 1–4. Node stdlib plus `pg`.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const tabletop = require('./tabletop.js');
const { memoryStore, postgresStore } = require('./store.js');
const characters = require('./characters.js');
const chat = require('./chat.js');
const voice = require('./voice.js');
const broadcast = require('./broadcast.js');
const downtime = require('./downtime.js');
const npcModule = require('./npcs.js');
const questModule = require('./quests.js');
const triggerModule = require('./triggers.js');
const rules = require('./rulesets/srd-5.2.1.js');

const ADVANCEMENT = ['milestone', 'xp'];
const AUTONOMY = ['static', 'scheduled', 'reactive', 'simulated', 'ai-assisted'];
const VISIBILITY = ['gm', 'party', 'public']; // gm: GM only, party: players, public: players + spectators
const RANK = { none: 0, spectator: 1, player: 2, gm: 3 };
const SEES = { gm: VISIBILITY, player: ['party', 'public'], spectator: ['public'], none: [] };
const LINK = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g; // [[id]], [[id|label]] or [[Title]]

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const id = () => crypto.randomUUID();
const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');

function str(v, name, max = 200) {
  if (typeof v !== 'string' || !v.trim() || v.length > max) fail(400, `${name} must be a non-empty string up to ${max} chars`);
  return v.trim();
}
function oneOf(v, list, name) {
  if (!list.includes(v)) fail(400, `${name} must be one of: ${list.join(', ')}`);
  return v;
}
function coord(v, name) {
  if (typeof v !== 'number' || !(v >= 0 && v <= 100)) fail(400, `${name} must be a number 0..100`);
  return v;
}
function num(v, name, min, max, int = false) {
  if (typeof v !== 'number' || !(v >= min && v <= max) || (int && !Number.isInteger(v))) fail(400, `${name} must be ${int ? 'an integer' : 'a number'} ${min}..${max}`);
  return v;
}
function bool(v, name) {
  if (typeof v !== 'boolean') fail(400, `${name} must be true or false`);
  return v;
}
function text(v, name) {
  if (typeof v !== 'string' || v.length > 20000) fail(400, `${name} must be a string up to 20000 chars`);
  return v;
}
function safeUrl(v) {
  let u;
  try { u = new URL(v); } catch { fail(400, 'imageUrl must be an absolute URL'); }
  if (!['https:', 'http:'].includes(u.protocol)) fail(400, 'imageUrl must be http(s)');
  return u.href;
}

function createApp({ store = memoryStore(), env = process.env } = {}) {
  const { db } = store;
  const find = (c, key) => db[c].find((r) => r.id === key) || fail(404, `${c.slice(0, -1)} not found`);

  function record(actor, type, data) {
    db.events.push({ seq: db.events.length + 1, at: new Date().toISOString(), actor, type, data });
  }

  function roleIn(user, worldId) {
    const world = find('worlds', worldId);
    if (world.ownerId === user.id) return 'gm';
    return db.memberships
      .filter((m) => m.userId === user.id && m.worldId === worldId)
      .reduce((best, m) => (RANK[m.role] > RANK[best] ? m.role : best), 'none');
  }
  function need(user, worldId, min) {
    const role = roleIn(user, worldId);
    if (RANK[role] < RANK[min]) fail(role === 'none' ? 404 : 403, role === 'none' ? 'world not found' : 'not allowed');
    return role;
  }

  // A viewer bound to one world: every visibility decision goes through here.
  // `user.broadcast` is the livestream viewer: a spectator of exactly that campaign (see broadcast.js).
  function viewer(user, worldId) {
    if (user.broadcast && find('campaigns', user.broadcast).worldId !== worldId) fail(404, 'scene not found');
    const role = user.broadcast ? 'spectator' : need(user, worldId, 'spectator');
    const campaigns = user.broadcast ? new Set([user.broadcast])
      : new Set(db.memberships.filter((m) => m.userId === user.id && m.worldId === worldId).map((m) => m.campaignId));
    const seesLoc = (loc) => {
      if (!SEES[role].includes(loc.visibility)) return false;
      if (loc.requiresDiscovery && role !== 'gm' &&
        !db.discoveries.some((d) => d.locationId === loc.id && campaigns.has(d.campaignId))) return false;
      return !loc.parentId || seesLoc(find('locations', loc.parentId)); // a hidden ancestor hides the whole subtree
    };
    const seesPage = (p) => (p.locationId ? seesLoc(find('locations', p.locationId)) : SEES[role].includes(p.visibility));
    const seesRel = (r) => SEES[role].includes(r.visibility) && seesPage(find('pages', r.fromId)) && seesPage(find('pages', r.toId));
    // Links render with the target's current title, or as [unknown] so a hidden page's title never leaks.
    const renderLinks = (s) => s.replace(LINK, (m, key) => {
      const p = db.pages.find((x) => x.id === key);
      return p && seesPage(p) ? `[[${p.id}|${p.title}]]` : p ? '[unknown]' : m;
    });
    const brief = (p) => ({ id: p.id, title: p.title, kind: p.kind, locationId: p.locationId || null });
    function viewPage(page) {
      if (!seesPage(page)) fail(404, 'page not found');
      const out = { ...page, body: renderLinks(page.body) };
      if (role === 'gm') out.gmNotes = renderLinks(page.gmNotes); else delete out.gmNotes;
      const token = `[[${page.id}]]`;
      return {
        page: out,
        backlinks: db.pages.filter((p) => p.id !== page.id && seesPage(p) &&
          (p.body.includes(token) || (role === 'gm' && p.gmNotes.includes(token)))).map(brief),
        relationships: db.relationships.filter((r) => (r.fromId === page.id || r.toId === page.id) && seesRel(r))
          .map((r) => ({ id: r.id, kind: r.kind, visibility: r.visibility, outgoing: r.fromId === page.id,
            other: brief(find('pages', r.fromId === page.id ? r.toId : r.fromId)) })),
      };
    }
    return { role, seesLoc, seesPage, viewPage, brief };
  }

  // On save, [[Title]] and [[id|label]] become [[id]] so renames never break links.
  function normalizeLinks(worldId, s) {
    return s.replace(LINK, (m, key) => {
      key = key.trim();
      if (db.pages.some((p) => p.id === key && p.worldId === worldId)) return `[[${key}]]`;
      const hits = db.pages.filter((p) => p.worldId === worldId && p.title.toLowerCase() === key.toLowerCase());
      return hits.length === 1 ? `[[${hits[0].id}]]` : m; // unknown or ambiguous titles stay as typed
    });
  }

  function newPage(worldId, fields) {
    const page = { id: id(), worldId, locationId: null, kind: 'lore', visibility: 'party', body: '', gmNotes: '', ...fields };
    page.body = normalizeLinks(worldId, page.body);
    page.gmNotes = normalizeLinks(worldId, page.gmNotes);
    db.pages.push(page);
    return page;
  }

  function newLocation(worldId, parentId, { name, type, x, y, visibility, requiresDiscovery }) {
    const loc = { id: id(), worldId, parentId, name, type, x, y, visibility, requiresDiscovery, mapId: id(), pageId: null };
    db.maps.push({ id: loc.mapId, worldId, locationId: loc.id, name: `${name} map`, imageUrl: '' });
    db.locations.push(loc);
    loc.pageId = newPage(worldId, { locationId: loc.id, kind: 'location', title: name }).id;
    return loc;
  }

  function viewLocation(user, locId) {
    const loc = find('locations', locId);
    const v = viewer(user, loc.worldId);
    if (!v.seesLoc(loc)) fail(404, 'location not found');
    const trail = [];
    for (let p = loc; p; p = p.parentId && find('locations', p.parentId)) trail.unshift({ id: p.id, name: p.name, type: p.type });
    return {
      role: v.role,
      location: v.role === 'gm'
        ? { ...loc, discoveredIn: db.discoveries.filter((d) => d.locationId === loc.id).map((d) => d.campaignId) }
        : loc,
      breadcrumbs: trail,
      map: find('maps', loc.mapId),
      ...v.viewPage(find('pages', loc.pageId)),
      children: db.locations.filter((c) => c.parentId === loc.id && v.seesLoc(c)),
      scenes: table2d.scenesAt(v.role, loc.id),
      npcsHere: people.hereFor(user, loc),
    };
  }

  const routes = {
    'POST /api/users': (_u, b) => {
      const token = crypto.randomBytes(24).toString('hex');
      const user = { id: id(), name: str(b.name, 'name', 60), tokenHash: hash(token) };
      db.users.push(user);
      record(user.id, 'user.created', { userId: user.id });
      return { user: { id: user.id, name: user.name }, token };
    },
    'GET /api/me': (u) => ({
      user: { id: u.id, name: u.name },
      worlds: db.worlds
        .map((w) => ({ id: w.id, name: w.name, role: roleIn(u, w.id) }))
        .filter((w) => w.role !== 'none'),
    }),
    'POST /api/worlds': (u, b) => {
      const world = {
        id: id(),
        ownerId: u.id,
        name: str(b.name, 'name', 120),
        settings: {
          ruleset: 'srd-5.2.1',
          advancement: oneOf(b.advancement, ADVANCEMENT, 'advancement'),
          npcAutonomy: oneOf(b.npcAutonomy ?? 'scheduled', AUTONOMY, 'npcAutonomy'),
          calendar: { name: 'Standard', daysPerWeek: 7, monthsPerYear: 12, daysPerMonth: 30 },
          defaultVisibility: 'party',
        },
      };
      db.worlds.push(world);
      world.rootLocationId = newLocation(world.id, null,
        { name: world.name, type: 'world', x: 50, y: 50, visibility: 'public', requiresDiscovery: false }).id;
      record(u.id, 'world.created', { worldId: world.id, settings: world.settings });
      return world;
    },
    'GET /api/worlds/:id': (u, _b, p) => {
      const role = need(u, p.id, 'spectator');
      const world = find('worlds', p.id);
      const mine = new Set(db.memberships.filter((m) => m.userId === u.id).map((m) => m.campaignId));
      return {
        ...world,
        role,
        // Players never receive the GM's notes, beats or mute list; the live scene only if they can see it.
        campaigns: db.campaigns.filter((c) => c.worldId === p.id && (role === 'gm' || mine.has(c.id))).map((c) => (role === 'gm' ? c
          : { id: c.id, worldId: c.worldId, name: c.name, advancement: c.advancement, liveSceneId: liveFor(u, c) })),
        members: role === 'gm' ? db.memberships.filter((m) => m.worldId === p.id)
          .map((m) => ({ userId: m.userId, name: find('users', m.userId).name, role: m.role, campaignId: m.campaignId })) : undefined,
      };
    },
    // Empty q lists every page the viewer may see.
    'GET /api/worlds/:id/pages': (u, _b, p) => {
      const v = viewer(u, p.id);
      const q = (p.q || '').toLowerCase();
      return db.pages
        .filter((pg) => pg.worldId === p.id && v.seesPage(pg) &&
          (!q || [pg.title, pg.body, v.role === 'gm' ? pg.gmNotes : ''].some((s) => s.toLowerCase().includes(q))))
        .map(v.brief);
    },
    'POST /api/worlds/:id/pages': (u, b, p) => {
      need(u, p.id, 'gm');
      const page = newPage(p.id, {
        title: str(b.title, 'title', 120),
        kind: str(b.kind ?? 'lore', 'kind', 40),
        visibility: oneOf(b.visibility ?? find('worlds', p.id).settings.defaultVisibility, VISIBILITY, 'visibility'),
        body: text(b.body ?? '', 'body'),
        gmNotes: text(b.gmNotes ?? '', 'gmNotes'),
      });
      record(u.id, 'page.created', { pageId: page.id });
      return page;
    },
    'POST /api/worlds/:id/relationships': (u, b, p) => {
      need(u, p.id, 'gm');
      const [from, to] = [find('pages', b.fromId), find('pages', b.toId)];
      if (from.worldId !== p.id || to.worldId !== p.id) fail(400, 'both pages must belong to this world');
      if (from.id === to.id) fail(400, 'a page cannot relate to itself');
      const rel = { id: id(), worldId: p.id, fromId: from.id, toId: to.id, kind: str(b.kind, 'kind', 60),
        visibility: oneOf(b.visibility ?? 'party', VISIBILITY, 'visibility') };
      db.relationships.push(rel);
      record(u.id, 'relationship.created', rel);
      return rel;
    },
    'DELETE /api/relationships/:id': (u, _b, p) => {
      const rel = find('relationships', p.id);
      need(u, rel.worldId, 'gm');
      db.relationships.splice(db.relationships.indexOf(rel), 1);
      record(u.id, 'relationship.deleted', rel); // the event keeps the full row, so deletes stay auditable
      return { ok: true };
    },
    'POST /api/worlds/:id/campaigns': (u, b, p) => {
      need(u, p.id, 'gm');
      const world = find('worlds', p.id);
      const override = b.advancement !== undefined;
      const campaign = {
        id: id(),
        worldId: p.id,
        name: str(b.name, 'name', 120),
        // Copied, not referenced: changing the world default later must not retroactively change this campaign.
        advancement: {
          mode: override ? oneOf(b.advancement, ADVANCEMENT, 'advancement') : world.settings.advancement,
          source: override ? 'campaign' : 'world',
          levelUp: oneOf(b.levelUp ?? 'confirm', ['auto', 'confirm'], 'levelUp'),
          alignLevels: bool(b.alignLevels ?? false, 'alignLevels'),
        },
        voice: { spectators: 'none', muted: [] },
        director: { liveSceneId: null, notes: '', beats: [] },
        broadcast: { enabled: false, keyHash: null, sceneId: null, title: '', showInitiative: true, showRolls: true },
        clock: { day: 0, minute: 480 },
      };
      db.campaigns.push(campaign);
      record(u.id, 'campaign.created', { campaignId: campaign.id, advancement: campaign.advancement });
      return campaign;
    },
    // { mode?, levelUp?, confirm? }: switching mode needs confirm; levelUp ('auto' | 'confirm') applies to XP campaigns.
    'PATCH /api/campaigns/:id/advancement': (u, b, p) => {
      const campaign = find('campaigns', p.id);
      need(u, campaign.worldId, 'gm');
      const cur = campaign.advancement;
      const mode = b.mode === undefined ? cur.mode : oneOf(b.mode, ADVANCEMENT, 'mode');
      const levelUp = b.levelUp === undefined ? cur.levelUp || 'confirm' : oneOf(b.levelUp, ['auto', 'confirm'], 'levelUp');
      const alignLevels = b.alignLevels === undefined ? !!cur.alignLevels : bool(b.alignLevels, 'alignLevels');
      if (mode !== cur.mode && b.confirm !== true) {
        fail(409, `Switching ${cur.mode} → ${mode} keeps every character's current level and history; ` +
          'future awards use the new mode and no level is added or removed now. Resend with confirm: true.');
      }
      if (mode === cur.mode && levelUp === (cur.levelUp || 'confirm') && alignLevels === !!cur.alignLevels) return campaign;
      campaign.advancement = { mode, levelUp, alignLevels, source: mode === cur.mode ? cur.source : 'campaign' };
      record(u.id, 'campaign.advancement.changed', { campaignId: campaign.id, from: cur, to: campaign.advancement });
      return campaign;
    },
    'POST /api/campaigns/:id/invites': (u, b, p) => {
      const campaign = find('campaigns', p.id);
      need(u, campaign.worldId, 'gm');
      const invite = { id: crypto.randomBytes(9).toString('base64url'), campaignId: campaign.id, worldId: campaign.worldId,
        role: oneOf(b.role ?? 'player', ['player', 'spectator'], 'role'), createdBy: u.id, acceptedBy: null };
      db.invites.push(invite);
      record(u.id, 'invite.created', { campaignId: campaign.id, role: invite.role });
      return { code: invite.id, role: invite.role };
    },
    'POST /api/invites/:id/accept': (u, _b, p) => {
      const invite = find('invites', p.id);
      if (invite.acceptedBy) fail(410, 'invite already used');
      invite.acceptedBy = u.id;
      db.memberships.push({ id: id(), userId: u.id, worldId: invite.worldId, campaignId: invite.campaignId, role: invite.role });
      record(u.id, 'invite.accepted', { campaignId: invite.campaignId, role: invite.role });
      return { worldId: invite.worldId, campaignId: invite.campaignId, role: invite.role };
    },
    'GET /api/locations/:id': (u, _b, p) => viewLocation(u, p.id),
    'POST /api/locations/:id/children': (u, b, p) => {
      const parent = find('locations', p.id);
      need(u, parent.worldId, 'gm');
      const loc = newLocation(parent.worldId, parent.id, {
        name: str(b.name, 'name', 120),
        type: str(b.type ?? 'location', 'type', 40),
        x: coord(b.x, 'x'),
        y: coord(b.y, 'y'),
        visibility: oneOf(b.visibility ?? find('worlds', parent.worldId).settings.defaultVisibility, VISIBILITY, 'visibility'),
        requiresDiscovery: bool(b.requiresDiscovery ?? false, 'requiresDiscovery'),
      });
      record(u.id, 'location.created', { locationId: loc.id, parentId: parent.id });
      return loc;
    },
    'PUT /api/locations/:id/discovery': (u, b, p) => {
      const loc = find('locations', p.id);
      need(u, loc.worldId, 'gm');
      const campaign = find('campaigns', b.campaignId);
      if (campaign.worldId !== loc.worldId) fail(400, 'campaign belongs to another world');
      const discovered = bool(b.discovered, 'discovered');
      const at = db.discoveries.findIndex((d) => d.locationId === loc.id && d.campaignId === campaign.id);
      if (discovered && at < 0) db.discoveries.push({ id: id(), worldId: loc.worldId, locationId: loc.id, campaignId: campaign.id });
      if (!discovered && at >= 0) db.discoveries.splice(at, 1);
      record(u.id, 'location.discovery', { locationId: loc.id, campaignId: campaign.id, discovered });
      return { discovered };
    },
    'GET /api/pages/:id': (u, _b, p) => {
      const page = find('pages', p.id);
      const v = viewer(u, page.worldId);
      return { role: v.role, ...v.viewPage(page) };
    },
    'GET /api/pages/:id/history': (u, _b, p) => {
      const page = find('pages', p.id);
      need(u, page.worldId, 'gm');
      return db.revisions.filter((r) => r.pageId === page.id).reverse();
    },
    'PATCH /api/pages/:id': (u, b, p) => {
      const page = find('pages', p.id);
      need(u, page.worldId, 'gm');
      const changes = {};
      if (b.title !== undefined) changes.title = str(b.title, 'title', 120);
      if (b.body !== undefined) changes.body = normalizeLinks(page.worldId, text(b.body, 'body'));
      if (b.gmNotes !== undefined) changes.gmNotes = normalizeLinks(page.worldId, text(b.gmNotes, 'gmNotes'));
      if (!page.locationId) { // a location page follows its location's visibility
        if (b.kind !== undefined) changes.kind = str(b.kind, 'kind', 40);
        if (b.visibility !== undefined) changes.visibility = oneOf(b.visibility, VISIBILITY, 'visibility');
      }
      if (!Object.keys(changes).length) fail(400, 'nothing to change');
      const { title, body, gmNotes, kind, visibility } = page;
      db.revisions.push({ id: id(), pageId: page.id, worldId: page.worldId, at: new Date().toISOString(), actor: u.id,
        title, body, gmNotes, kind, visibility });
      Object.assign(page, changes);
      if (changes.title && page.locationId) find('locations', page.locationId).name = changes.title;
      record(u.id, 'page.updated', { id: page.id, fields: Object.keys(changes) });
      return page;
    },
  };

  const check = { str, oneOf, bool, num, safeUrl };
  const hooks = {};
  const table2d = tabletop({ db, find, fail, need, viewer, record, id, SEES, VISIBILITY, check, hooks });
  const chars = characters({ db, find, fail, need, record, id, check, publishScene: table2d.publish, canSeeScene: table2d.canSee });
  Object.assign(hooks, { tokenInfo: chars.tokenInfo, sceneRolls: chars.sceneRolls });
  const liveFor = (u, c) => {
    const s = c.director && c.director.liveSceneId && db.scenes.find((x) => x.id === c.director.liveSceneId);
    return s && table2d.canSee(u, s) ? s.id : null;
  };
  // GM Director Mode: the live scene everyone is pointed to, private notes and story beats.
  routes['PATCH /api/campaigns/:id/director'] = (u, b, p) => {
    const c = find('campaigns', p.id);
    need(u, c.worldId, 'gm');
    const d = { ...c.director };
    if (b.liveSceneId !== undefined) {
      if (b.liveSceneId !== null && find('scenes', b.liveSceneId).worldId !== c.worldId) fail(400, 'scene belongs to another world');
      d.liveSceneId = b.liveSceneId;
    }
    if (b.notes !== undefined) {
      if (typeof b.notes !== 'string' || b.notes.length > 20000) fail(400, 'notes must be text up to 20000 chars');
      d.notes = b.notes;
    }
    if (b.beats !== undefined) {
      if (!Array.isArray(b.beats) || b.beats.length > 100) fail(400, 'beats must be a list of up to 100');
      d.beats = b.beats.map((x) => ({ id: typeof x.id === 'string' && x.id.length <= 40 ? x.id : id(), text: str(x.text, 'beat', 200), done: x.done === true }));
    }
    c.director = d;
    record(u.id, 'director.updated', { campaignId: c.id, fields: Object.keys(b) });
    if (b.liveSceneId !== undefined) talk.broadcast(c.id, 'live', (viewer) => ({ campaignId: c.id, sceneId: liveFor(viewer, c) }));
    return c;
  };
  const talk = chat({ db, find, fail, need, record, id, check,
    characterOwner: (u, c) => c.ownerId === u.id || find('worlds', c.worldId).ownerId === u.id });
  const cast = broadcast({ db, find, fail, need, record, check, hash, sceneView: table2d.sceneView });
  hooks.onScene = cast.onScene;
  Object.assign(routes, cast.routes);
  const calls = voice({ db, find, fail, need, record, check, env });
  const people = npcModule({ db, find, fail, need, record, id, check, viewer, SEES, VISIBILITY, publishScene: table2d.publish });
  const scenery = triggerModule({ db, find, fail, need, record, id, check, VISIBILITY, SEES, publishScene: table2d.publish, people });
  hooks.sceneTriggers = scenery.forScene;
  const sideQuests = questModule({ db, find, fail, need, record, id, check, rules, chars, people });
  const later = downtime({ db, find, fail, need, record, id, check, rules, chars, onClock: people.onClock, adventures: sideQuests });
  Object.assign(routes, table2d.routes, chars.routes, talk.routes, calls.routes, later.routes, people.routes, sideQuests.routes, scenery.routes);

  // GM edits for locations and maps: field whitelist. Ids never change, so renames never break links.
  const EDITABLE = {
    locations: { name: (v) => str(v, 'name', 120), visibility: (v) => oneOf(v, VISIBILITY, 'visibility'),
      requiresDiscovery: (v) => bool(v, 'requiresDiscovery') },
    maps: { name: (v) => str(v, 'name', 120), imageUrl: (v) => (v === '' ? v : safeUrl(v)) },
  };
  for (const c of Object.keys(EDITABLE)) {
    routes[`PATCH /api/${c}/:id`] = (u, b, p) => {
      const row = find(c, p.id);
      need(u, row.worldId, 'gm');
      const changes = {};
      for (const [k, check] of Object.entries(EDITABLE[c])) if (b[k] !== undefined) changes[k] = check(b[k]);
      if (!Object.keys(changes).length) fail(400, `nothing to change; editable: ${Object.keys(EDITABLE[c]).join(', ')}`);
      Object.assign(row, changes);
      if (changes.name && c === 'locations') find('pages', row.pageId).title = changes.name;
      record(u.id, `${c.slice(0, -1)}.updated`, { id: row.id, fields: Object.keys(changes) });
      return row;
    };
  }

  const table = Object.entries(routes).map(([key, fn]) => {
    const [method, pattern] = key.split(' ');
    return { method, re: new RegExp('^' + pattern.replace(/:id/g, '([\\w-]+)') + '$'), fn };
  });

  const mod = (...p) => path.join(__dirname, 'node_modules', ...p);
  const VENDOR = {
    '/vendor/livekit-client.umd.js': mod('livekit-client', 'dist', 'livekit-client.umd.js'),
    '/vendor/three/three.module.js': mod('three', 'build', 'three.module.js'),
    '/vendor/three/three.core.js': mod('three', 'build', 'three.core.js'),
    '/vendor/three/addons/controls/OrbitControls.js': mod('three', 'examples', 'jsm', 'controls', 'OrbitControls.js'),
    '/vendor/three/addons/controls/PointerLockControls.js': mod('three', 'examples', 'jsm', 'controls', 'PointerLockControls.js'),
  };
  const STATIC = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && VENDOR[url.pathname]) { // browser libraries served straight from node_modules (whitelist only)
      const file = VENDOR[url.pathname];
      if (!fs.existsSync(file)) return send(res, 404, { error: `${url.pathname} is not installed (npm install)` });
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=86400' });
      return res.end(fs.readFileSync(file));
    }
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      const name = path.basename(url.pathname) || 'index.html'; // basename: no path traversal out of public/
      const file = path.join(__dirname, 'public', name);
      if (!STATIC[path.extname(name)] || !fs.existsSync(file)) return send(res, 404, { error: 'not found' });
      res.writeHead(200, { 'content-type': STATIC[path.extname(name)] });
      return res.end(fs.readFileSync(file));
    }
    try {
      const live = req.method === 'GET' && url.pathname.match(/^\/api\/scenes\/([\w-]+)\/stream$/);
      // EventSource cannot send headers, so the stream alone accepts the token as a query parameter.
      if (live) return table2d.stream(req, res, authenticate(req, url.searchParams.get('token')), live[1]);
      if (req.method === 'GET' && url.pathname === '/api/broadcast/stream') return cast.stream(req, res, url.searchParams.get('key'));
      const chatLive = req.method === 'GET' && url.pathname.match(/^\/api\/campaigns\/([\w-]+)\/chat\/stream$/);
      if (chatLive) return talk.stream(req, res, authenticate(req, url.searchParams.get('token')), chatLive[1]);
      const route = table.find((r) => r.method === req.method && r.re.test(url.pathname)) || fail(404, 'no such route');
      const params = { id: url.pathname.match(route.re)[1], q: url.searchParams.get('q'), query: Object.fromEntries(url.searchParams) };
      const body = req.method === 'GET' ? {} : await readJson(req);
      const anonymous = req.method === 'POST' && url.pathname === '/api/users';
      if (store.reloading) fail(503, 'recovering from a storage error, retry in a moment');
      const user = anonymous ? null : authenticate(req);
      const generation = store.generation;
      const out = await route.fn(user, body, params);
      if (req.method !== 'GET') {
        // Answer only once the change is stored; if storage failed (now or in a write that included it), say so.
        try { await store.persist(); } catch (e) { console.error('storage write failed:', e.message); }
        if (store.generation !== generation) fail(500, 'could not save that change, please retry');
      }
      send(res, 200, out);
    } catch (e) {
      if (!e.status) console.error(e);
      send(res, e.status || 500, { error: e.status ? e.message : 'internal error' });
    }
  }

  function authenticate(req, query) {
    const token = query || (req.headers.authorization || '').replace(/^Bearer /, '');
    const h = token && hash(token);
    return (h && db.users.find((u) => u.tokenHash === h)) || fail(401, 'sign in first');
  }

  // After a failed write memory is reloaded; drop live streams so browsers reconnect to the stored state.
  store.onReload(() => { for (const s of [...table2d.subscribers, ...talk.subscribers, ...cast.subscribers]) s.res.end(); });

  return { handle, db, store };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 64 * 1024) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); }
    });
    req.on('end', () => {
      try { const v = raw ? JSON.parse(raw) : {}; resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {}); }
      catch { reject(Object.assign(new Error('invalid JSON'), { status: 400 })); }
    });
  });
}
function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body, (k, v) => (k === 'tokenHash' || k === 'keyHash' ? undefined : v)));
}

if (require.main === module) {
  (async () => {
    const port = Number(process.env.PORT) || 3000;
    let store;
    if (process.env.DATABASE_URL) {
      store = await postgresStore({ databaseUrl: process.env.DATABASE_URL, importFile: process.env.DATA_FILE || path.join(__dirname, 'data.json') });
    } else {
      console.warn('DATABASE_URL is not set: running in memory, nothing will be saved.');
      store = memoryStore();
    }
    const { handle } = createApp({ store });
    http.createServer(handle).listen(port, () => console.log(`Living Quest on http://localhost:${port}`));
  })().catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { createApp };
