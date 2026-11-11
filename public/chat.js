// Milestone 5 UI: campaign chat panel. It lives outside #app, so it stays open and connected while the
// rest of the page is redrawn (maps, scenes, sheets, wiki). Shares the page's globals (h, api, run, state, token).
/* global h, api, run, state, token, options */
'use strict';

const chat = { campaignId: null, es: null, role: null, members: [], messages: [], open: false, unread: 0, filter: 'all' };
const $chat = document.getElementById('chat');
const $chatToggle = document.getElementById('chat-toggle');

function stopChat() {
  if (chat.es) chat.es.close();
  Object.assign(chat, { campaignId: null, es: null, messages: [], members: [], unread: 0 });
  $chat.hidden = true;
  $chatToggle.hidden = true;
  document.body.classList.remove('chat-open');
}

function startChat(campaignId) {
  if (!campaignId) return stopChat();
  if (chat.campaignId === campaignId && chat.es) return;
  if (chat.es) chat.es.close();
  Object.assign(chat, { campaignId, messages: [], unread: 0 });
  const es = new EventSource(`/api/campaigns/${campaignId}/chat/stream?token=${encodeURIComponent(token)}`);
  chat.es = es;
  es.addEventListener('snapshot', (e) => { const d = JSON.parse(e.data); Object.assign(chat, { role: d.role, members: d.members, messages: d.messages }); drawChat(true); });
  es.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (chat.messages.some((x) => x.id === m.id)) return;
    chat.messages.push(m);
    if (!chat.open) chat.unread++;
    drawChat(false);
  });
  es.addEventListener('deleted', (e) => { const { id } = JSON.parse(e.data); chat.messages = chat.messages.filter((x) => x.id !== id); drawChat(false); });
  $chatToggle.hidden = false;
  drawChat(true);
}

const CHANNEL_LABEL = { table: 'Table', whisper: 'Whisper', gm: 'GM', audience: 'Audience' };
function line(m) {
  const me = state.me && m.fromUserId === state.me.id;
  const who = m.asCharacter ? `${m.asCharacter} (${m.fromName})` : m.fromName;
  const to = m.channel === 'whisper' ? ` → ${m.toNames.join(', ')}` : '';
  return h('li', { class: `msg ch-${m.channel}` },
    h('div', { class: 'muted' }, h('strong', {}, who), to, ` · ${CHANNEL_LABEL[m.channel]} · ${new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
      chat.role === 'gm' && [' ', h('button', { class: 'link', 'aria-label': `Delete message from ${who}`, onclick: () => run(() => api('DELETE', `/api/messages/${m.id}`)) }, 'delete')]),
    h('div', { style: 'white-space:pre-wrap;overflow-wrap:anywhere' + (me ? ';font-weight:500' : '') }, m.text));
}

function drawChat(full) {
  $chatToggle.textContent = chat.unread ? `Chat (${chat.unread})` : 'Chat';
  $chat.hidden = !chat.open;
  document.body.classList.toggle('chat-open', chat.open);
  if (!chat.open) return;
  const list = $chat.querySelector('ol');
  const shown = chat.messages.filter((m) => chat.filter === 'all' || m.channel === chat.filter);
  if (!full && list) { // keep the composer (and anything being typed) untouched; only redraw the messages
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    list.replaceChildren(...shown.map(line));
    if (atBottom) list.scrollTop = list.scrollHeight;
    return;
  }
  const channels = chat.role === 'spectator' ? ['audience'] : chat.role === 'gm' ? ['table', 'whisper', 'gm', 'audience'] : ['table', 'whisper', 'audience'];
  const others = chat.members.filter((m) => m.role !== 'spectator' && (!state.me || m.userId !== state.me.id));
  const mine = (state.chars || []).filter((c) => c.campaignId === chat.campaignId && (c.mine || chat.role === 'gm'));
  const campaigns = state.world ? state.world.campaigns : [];
  const recipients = h('fieldset', { class: 'recipients', hidden: true }, h('legend', {}, 'Whisper to'),
    others.map((m) => h('label', { class: 'inline' }, h('input', { type: 'checkbox', name: 'to', value: m.userId }), `${m.name}${m.role === 'gm' ? ' (GM)' : ''}`)));
  const form = h('form', { onsubmit: (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = { channel: f.get('channel'), text: f.get('text'), characterId: f.get('as') || undefined, toUserIds: f.getAll('to') };
    run(async () => { await api('POST', `/api/campaigns/${chat.campaignId}/chat`, body); e.target.elements.text.value = ''; e.target.elements.text.focus(); });
  } },
    h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' },
      h('select', { name: 'channel', 'aria-label': 'Channel', onchange: (e) => { recipients.hidden = e.target.value !== 'whisper'; } }, channels.map((c) => h('option', { value: c }, CHANNEL_LABEL[c]))),
      mine.length > 0 && h('select', { name: 'as', 'aria-label': 'Speak as' }, h('option', { value: '' }, 'as myself'), mine.map((c) => h('option', { value: c.id }, `as ${c.name}`)))),
    recipients,
    h('textarea', { name: 'text', rows: 2, maxlength: 2000, required: true, 'aria-label': 'Message', placeholder: 'Message…',
      onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.target.form.requestSubmit(); } } }),
    h('button', {}, 'Send'));
  $chat.replaceChildren(
    h('div', { class: 'chat-head' },
      campaigns.length > 1 ? h('select', { 'aria-label': 'Campaign', onchange: (e) => startChat(e.target.value) }, campaigns.map((c) => h('option', { value: c.id, selected: c.id === chat.campaignId || false }, c.name)))
        : h('strong', {}, (campaigns[0] || {}).name || 'Chat'),
      h('button', { class: 'link', onclick: () => { chat.open = false; drawChat(true); }, 'aria-label': 'Close chat' }, 'close')),
    h('div', { class: 'chat-tabs', role: 'tablist' }, ['all', ...channels].map((c) => h('button', { role: 'tab', 'aria-selected': String(chat.filter === c),
      onclick: () => { chat.filter = c; drawChat(true); } }, c === 'all' ? 'All' : CHANNEL_LABEL[c]))),
    h('ol', { 'aria-live': 'polite', 'aria-label': 'Messages' }, chat.messages.filter((m) => chat.filter === 'all' || m.channel === chat.filter).map(line)),
    form);
  const ol = $chat.querySelector('ol');
  ol.scrollTop = ol.scrollHeight;
}

$chatToggle.addEventListener('click', () => { chat.open = !chat.open; chat.unread = 0; drawChat(true); });
