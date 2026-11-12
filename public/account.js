// Milestone 13: sign-in, registration and the account page. The session token stays in this browser (localStorage);
// live streams get short-lived tickets instead, so the token never appears in a URL.
/* global h, api, run, state, render, field, onSubmit */
'use strict';

const setToken = (t) => { token = t; if (t) localStorage.setItem('lq-token', t); else localStorage.removeItem('lq-token'); };
async function streamUrl(path) {
  const { ticket } = await api('POST', '/api/stream-tickets');
  return `${path}?ticket=${encodeURIComponent(ticket)}`;
}

async function renderSignIn() {
  const cfg = await api('GET', '/api/auth/config').catch(() => ({ devSignIn: false }));
  const done = (r) => { setToken(r.token); render(); };
  $app.append(h('div', { class: 'row' },
    h('section', {}, h('h2', {}, 'Sign in'),
      h('form', { onsubmit: onSubmit(async (f) => done(await api('POST', '/api/auth/login', f))) },
        field('Email', h('input', { name: 'email', type: 'email', required: true, autocomplete: 'username' })),
        field('Password', h('input', { name: 'password', type: 'password', required: true, autocomplete: 'current-password' })),
        h('button', {}, 'Sign in'))),
    h('section', {}, h('h2', {}, 'Create an account'),
      h('form', { onsubmit: onSubmit(async (f) => done(await api('POST', '/api/auth/register', f))) },
        field('Display name', h('input', { name: 'name', required: true, maxlength: 60, autocomplete: 'nickname' })),
        field('Email', h('input', { name: 'email', type: 'email', required: true, autocomplete: 'email' })),
        field(`Password (at least ${cfg.passwordMin || 10} characters)`, h('input', { name: 'password', type: 'password', required: true, minlength: cfg.passwordMin || 10, autocomplete: 'new-password' })),
        h('button', {}, 'Create account'),
        h('p', { class: 'muted' }, 'Your email is used only to sign in. See "Account" for exporting or deleting your data.')))),
  cfg.devSignIn && h('section', {}, h('h2', {}, 'Quick sign-in (development)'),
    h('p', { class: 'muted' }, 'This server allows signing in with just a name. Add an email and password later under "Account" to keep the account.'),
    h('form', { onsubmit: onSubmit(async (f) => done(await api('POST', '/api/users', f))) },
      field('Name', h('input', { name: 'name', required: true })), h('button', {}, 'Continue'))));
}

async function renderAccount() {
  const a = await api('GET', '/api/account');
  const back = h('button', { class: 'link', onclick: () => { state.account = false; render(); } }, '‹ Back');
  $app.append(h('section', {}, back, h('h2', {}, 'Your account'),
    h('p', {}, a.email ? `Signed in as ${a.name} (${a.email}).` : `${a.name}: a quick (development) account. Add an email and password to keep it.`),
    h('form', { onsubmit: onSubmit(async (f, form) => {
        const body = { name: f.name, ...(f.email && { email: f.email }), ...(f.password && { password: f.password }), currentPassword: f.currentPassword };
        const r = await api('PATCH', '/api/account', body);
        if (r.token) setToken(r.token);
        form.reset(); render();
      }) },
      field('Display name', h('input', { name: 'name', value: a.name, required: true, maxlength: 60 })),
      field('Email', h('input', { name: 'email', type: 'email', value: a.email || '', autocomplete: 'email' })),
      field(a.hasPassword ? 'New password (optional)' : 'Password', h('input', { name: 'password', type: 'password', minlength: 10, autocomplete: 'new-password', required: !a.hasPassword && !a.email ? false : !a.hasPassword })),
      a.hasPassword && field('Current password', h('input', { name: 'currentPassword', type: 'password', required: true, autocomplete: 'current-password' })),
      h('button', {}, 'Save'))),
  h('section', {}, h('h3', {}, 'Your data'),
    h('button', { onclick: () => run(async () => {
      const data = await api('GET', '/api/account/export');
      const link = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })), download: 'living-quest-account.json' }, 'download');
      link.click();
    }) }, 'Download my data'), ' ',
    h('button', { onclick: () => run(async () => { await api('POST', '/api/auth/logout-everywhere'); setToken(null); state.world = null; render(); }) }, 'Sign out everywhere')),
  h('section', {}, h('h3', {}, 'Delete account'),
    h('p', { class: 'muted' }, 'Removes your name, email, password and campaign memberships. Characters stay in their campaigns as "Former player". GMs must delete or hand over their worlds first.'),
    h('form', { onsubmit: onSubmit(async (f) => {
        if (!confirm('Delete your account? This cannot be undone.')) return;
        await api('DELETE', '/api/account', { currentPassword: f.currentPassword });
        setToken(null); state.world = null; state.account = false; render();
      }) },
      a.hasPassword && field('Current password', h('input', { name: 'currentPassword', type: 'password', required: true, autocomplete: 'current-password' })),
      h('button', {}, 'Delete my account'))));
}

document.getElementById('account-btn').addEventListener('click', () => { state.account = true; state.world = null; render(); });
document.getElementById('signout').addEventListener('click', () => run(async () => {
  await api('POST', '/api/auth/logout').catch(() => {});
  setToken(null); state.world = null; state.account = false; stopChat(); render();
}));
