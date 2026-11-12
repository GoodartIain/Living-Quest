// Milestone 12: the audience side of a livestream, on the scene page for players and spectators: the GM's poll and
// reactions. Votes and reactions never change the game; the stream shows counts and anonymous emoji only.
/* global h, api, run, state */
'use strict';

function audienceBox() {
  const c = state.world.campaigns[0]; // players and spectators only receive their own campaign
  const box = h('div', { id: 'audience' });
  if (!c) return box;
  const draw = async () => {
    if (!box.isConnected && box.dataset.drawn) return clearInterval(timer); // the page moved on
    box.dataset.drawn = '1';
    const a = await api('GET', `/api/campaigns/${c.id}/audience`);
    const p = a.poll;
    box.replaceChildren(h('div', {}, (a.live || p) && h('h3', {}, 'Livestream audience'),
      p && h('div', { class: 'audience-poll' }, h('p', {}, h('strong', {}, p.question), p.open ? '' : ' (closed)'),
        p.options.map((o, i) => h('div', {}, p.open && p.mine === null
          ? h('button', { onclick: () => run(async () => { await api('POST', `/api/campaigns/${c.id}/poll/vote`, { option: i }); await draw(); }) }, o.text)
          : `${p.mine === i ? '✔ ' : ''}${o.text}: ${o.votes}`))),
      a.reactions && h('div', { class: 'audience-react', style: 'display:flex;gap:4px' }, a.emoji.map((e) => h('button', { 'aria-label': `React ${e}`,
        onclick: () => run(() => api('POST', `/api/campaigns/${c.id}/react`, { emoji: e })) }, e)))));
  };
  const timer = setInterval(() => { if (!document.hidden) draw().catch(() => {}); }, 5000);
  draw().catch(() => {});
  return box;
}
