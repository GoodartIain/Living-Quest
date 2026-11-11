// Milestone 5 UI: campaign voice and video through the self-hosted LiveKit server. Like the chat panel it lives
// outside #app, so a call continues while players move between maps, scenes, sheets and the wiki.
/* global h, api, run, state, chat, LivekitClient */
'use strict';

const voice = { settings: null, volumes: {}, room: null, info: null, status: 'idle', open: false, speaking: new Set(), focus: null, ptt: false, mutedByGm: false };
const $voice = document.getElementById('voice');
const $voiceToggle = document.getElementById('voice-toggle');

function showVoiceButton(on) { $voiceToggle.hidden = !on; if (!on) leaveVoice(); }

async function joinVoice(withCamera) {
  const { Room, RoomEvent } = LivekitClient;
  voice.info = await api('POST', `/api/campaigns/${chat.campaignId}/voice/token`);
  voice.status = 'connecting';
  drawVoice();
  const room = new Room({ adaptiveStream: true, dynacast: true });
  voice.room = room;
  const redraw = () => drawVoice();
  room.on(RoomEvent.ParticipantConnected, redraw).on(RoomEvent.ParticipantDisconnected, redraw)
    .on(RoomEvent.TrackSubscribed, (track, _pub, p) => { // keep each person's chosen volume across reconnects and re-publishes
      if (track.kind === 'audio') p.setVolume(voice.volumes[p.identity] ?? 1);
      redraw();
    }).on(RoomEvent.TrackUnsubscribed, redraw)
    .on(RoomEvent.TrackPublished, redraw).on(RoomEvent.TrackUnpublished, redraw)
    .on(RoomEvent.TrackMuted, redraw).on(RoomEvent.TrackUnmuted, redraw)
    .on(RoomEvent.LocalTrackPublished, redraw).on(RoomEvent.LocalTrackUnpublished, redraw)
    .on(RoomEvent.ActiveSpeakersChanged, (speakers) => { voice.speaking = new Set(speakers.map((p) => p.identity)); markSpeakers(); })
    .on(RoomEvent.Reconnecting, () => { voice.status = 'reconnecting'; redraw(); })
    .on(RoomEvent.Reconnected, () => { voice.status = 'connected'; redraw(); })
    .on(RoomEvent.Disconnected, () => { if (voice.room === room) { voice.room = null; voice.status = 'idle'; redraw(); } })
    .on(RoomEvent.ParticipantPermissionsChanged, (_prev, p) => { // the GM muted or unmuted us
      if (p === room.localParticipant) {
        const was = voice.mutedByGm;
        voice.mutedByGm = !p.permissions.canPublish; // LiveKit has already stopped our tracks when muted
        if (was && !voice.mutedByGm && !voice.ptt) p.setMicrophoneEnabled(true).catch(showVoiceError); // unmuted: microphone back on, camera stays off
      }
      redraw();
    });
  await room.connect(voice.info.url, voice.info.token);
  voice.status = 'connected';
  voice.mutedByGm = !voice.info.canPublish && voice.info.role !== 'spectator';
  if (voice.info.canPublish) {
    await room.localParticipant.setMicrophoneEnabled(!voice.ptt).catch((e) => showVoiceError(e));
    if (withCamera) await room.localParticipant.setCameraEnabled(true).catch((e) => showVoiceError(e));
  }
  drawVoice();
}
function leaveVoice() {
  if (voice.room) voice.room.disconnect();
  Object.assign(voice, { room: null, info: null, status: 'idle', speaking: new Set(), focus: null, mutedByGm: false });
  drawVoice();
}
const showVoiceError = (e) => { document.getElementById('err').textContent = `Voice: ${e.message}`; };

function markSpeakers() {
  for (const el of $voice.querySelectorAll('[data-identity]')) el.classList.toggle('speaking', voice.speaking.has(el.dataset.identity));
}

function tile(p, local) {
  const { Track } = LivekitClient;
  const cam = p.getTrackPublication(Track.Source.Camera);
  const screen = p.getTrackPublication(Track.Source.ScreenShare);
  const mic = p.getTrackPublication(Track.Source.Microphone);
  const meta = (() => { try { return JSON.parse(p.metadata || '{}'); } catch { return {}; } })();
  const videoPub = screen && screen.track ? screen : cam && cam.track && !cam.isMuted ? cam : null;
  const media = videoPub ? (videoPub.track.attachedElements[0] || videoPub.track.attach()) : h('div', { class: 'avatar', 'aria-hidden': 'true' }, (p.name || '?').slice(0, 1).toUpperCase());
  if (videoPub) { media.muted = true; media.playsInline = true; }
  const micOn = mic && mic.track && !mic.isMuted;
  const isGm = voice.info && voice.info.role === 'gm';
  return h('figure', { class: `tile${voice.focus === p.identity ? ' focus' : ''}`, 'data-identity': p.identity, tabindex: 0,
      'aria-label': `${p.name}${local ? ' (you)' : ''}${micOn ? '' : ', microphone off'}`,
      onclick: (e) => { if (e.target.closest('button,input')) return; voice.focus = voice.focus === p.identity ? null : p.identity; drawVoice(); } },
    media,
    h('figcaption', {}, `${p.name}${local ? ' (you)' : ''}${meta.role === 'gm' ? ' · GM' : ''}${micOn ? '' : ' · 🔇'}`),
    videoPub && document.pictureInPictureEnabled && h('button', { class: 'link', onclick: () => media.requestPictureInPicture().catch(showVoiceError) }, 'pop out'),
    !local && h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: voice.volumes[p.identity] ?? 1, 'aria-label': `Volume for ${p.name}`,
      oninput: (e) => { voice.volumes[p.identity] = Number(e.target.value); p.setVolume(voice.volumes[p.identity]); } }),
    !local && isGm && meta.role === 'player' && h('button', { class: 'link', onclick: () => run(async () => {
      const muted = (await api('GET', `/api/campaigns/${chat.campaignId}/voice`)).muted.includes(p.identity);
      await api('POST', `/api/campaigns/${chat.campaignId}/voice/mute`, { userId: p.identity, muted: !muted });
    }) }, 'mute/unmute'));
}

async function deviceSelect(kind, label) {
  const devices = await LivekitClient.Room.getLocalDevices(kind).catch(() => []);
  if (!devices.length) return null;
  return h('label', {}, label, h('select', { onchange: (e) => voice.room.switchActiveDevice(kind, e.target.value).catch(showVoiceError) },
    devices.map((d) => h('option', { value: d.deviceId, selected: voice.room.getActiveDevice(kind) === d.deviceId || false }, d.label || kind))));
}

async function drawVoice() {
  $voiceToggle.textContent = voice.status === 'connected' ? `Voice · ${voice.room ? voice.room.numParticipants : 0}` : 'Voice';
  $voiceToggle.classList.toggle('live', voice.status === 'connected');
  $voice.hidden = !voice.open;
  if (!voice.open) return;
  const head = [h('div', { class: 'chat-head' }, h('strong', {}, 'Voice & video'),
    h('span', { class: 'muted', role: 'status' }, voice.status === 'idle' ? '' : voice.status),
    h('button', { class: 'link', onclick: () => { voice.open = false; drawVoice(); }, 'aria-label': 'Hide voice panel' }, 'hide')),
    state.world && state.world.role === 'gm' && voice.settings && h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: voice.settings.spectators === 'listen' || false,
      onchange: (e) => run(async () => { voice.settings = { ...voice.settings, ...(await api('PATCH', `/api/campaigns/${chat.campaignId}/voice`, { spectators: e.target.checked ? 'listen' : 'none' })) }; }) }),
      'Spectators may listen (they cannot speak and are not shown)')];
  if (!voice.room) {
    return $voice.replaceChildren(h("div", { style: "display:flex;flex-direction:column;gap:8px" }, head,
      h('p', { class: 'muted' }, 'Join the campaign call. Your microphone and camera are only used while you are in the call.'),
      h('div', { style: 'display:flex;gap:8px' },
        h('button', { onclick: () => run(() => joinVoice(false)) }, 'Join with microphone'),
        h('button', { onclick: () => run(() => joinVoice(true)) }, 'Join with camera'))));
  }
  const room = voice.room, lp = room.localParticipant;
  const canPublish = voice.info.canPublish && !voice.mutedByGm;
  const toggle = (label, on, fn) => h('button', { 'aria-pressed': String(on), disabled: !canPublish || false, onclick: () => run(async () => { await fn(!on); drawVoice(); }) }, label);
  const talk = (on) => lp.setMicrophoneEnabled(on).catch(showVoiceError);
  const people = [lp, ...room.remoteParticipants.values()].filter((p) => p === lp ? voice.info.role !== 'spectator' : true);
  $voice.replaceChildren(h("div", { style: "display:flex;flex-direction:column;gap:8px" }, head, // h() drops false/null parts
    voice.mutedByGm && h('p', { class: 'note', role: 'alert' }, 'The GM has muted you. You can still listen.'),
    voice.info.role === 'spectator' && h('p', { class: 'muted' }, 'You are listening as a spectator.'),
    h('div', { class: 'tiles' }, people.map((p) => tile(p, p === lp))),
    h('div', { class: 'controls' },
      voice.ptt
        ? h('button', { disabled: !canPublish || false, onpointerdown: () => talk(true), onpointerup: () => talk(false), onpointerleave: () => talk(false) }, 'Hold to talk (or hold `)')
        : toggle(lp.isMicrophoneEnabled ? 'Mute mic' : 'Unmute mic', lp.isMicrophoneEnabled, (on) => talk(on)),
      toggle(lp.isCameraEnabled ? 'Camera off' : 'Camera on', lp.isCameraEnabled, (on) => lp.setCameraEnabled(on)),
      toggle(lp.isScreenShareEnabled ? 'Stop sharing' : 'Share screen', lp.isScreenShareEnabled, (on) => lp.setScreenShareEnabled(on)),
      canPublish && h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: voice.ptt || false,
        onchange: (e) => { voice.ptt = e.target.checked; talk(!voice.ptt); drawVoice(); } }), 'Push to talk'),
      h('button', { onclick: leaveVoice }, 'Leave')),
    h('div', { class: 'controls', id: 'devices' })));
  markSpeakers();
  // Remote audio must be attached to play; the elements live in the dock so they survive page redraws.
  for (const p of room.remoteParticipants.values()) {
    for (const pub of p.audioTrackPublications.values()) if (pub.track && !pub.track.attachedElements.length) document.getElementById('voice-audio').append(pub.track.attach());
  }
  if (canPublish) {
    const devs = (await Promise.all([deviceSelect('audioinput', 'Microphone'), deviceSelect('videoinput', 'Camera')])).filter(Boolean);
    const box = document.getElementById('devices');
    if (box) box.replaceChildren(...devs);
  }
}

// Push-to-talk key: hold ` (outside text fields).
const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
document.addEventListener('keydown', (e) => { if (voice.ptt && voice.room && e.key === '`' && !e.repeat && !typing(e)) voice.room.localParticipant.setMicrophoneEnabled(true); });
document.addEventListener('keyup', (e) => { if (voice.ptt && voice.room && e.key === '`' && !typing(e)) voice.room.localParticipant.setMicrophoneEnabled(false); });
$voiceToggle.addEventListener('click', () => { voice.open = !voice.open; drawVoice(); });
