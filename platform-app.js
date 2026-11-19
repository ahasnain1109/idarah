/**
 * Idarah platform - app shell: auth screens, committee switcher, module-gated workspace.
 * platform-app.js
 *
 * STRICT VISIBILITY RULE: the sidebar, overview and every route are built ONLY from
 * the organization_modules that belong to the ACTIVE committee. A module that was
 * not onboarded never appears in the workspace (only in the "+ Onboard Another
 * Module" page). Access itself is enforced by Row Level Security in the database.
 */
(function () {
  'use strict';

  const P = window.IdarahPlatform;
  const esc = window.escapeHtml;
  const root = () => document.getElementById('app-root');

  const App = {
    session: null,
    ws: null,                 // { profile, memberships, modules }
    activeCommitteeId: null,
    busy: false
  };

  const ACTIVE_KEY = 'idarah_active_committee';
  const roleName = Object.fromEntries(P.ROLES);

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked: ignore */ } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }

  // ---- derived state --------------------------------------------------------

  function membership() {
    return App.ws.memberships.find(m => m.committee.id === App.activeCommitteeId) || null;
  }
  function committee() { const m = membership(); return m ? m.committee : null; }
  function myRoles() { const m = membership(); return m ? m.roles : []; }
  function isManager() { return myRoles().some(r => r === 'admin' || r === 'mutawalli_trustee'); }
  /** ONLY modules of the active committee. */
  function modules() { return App.ws.modules.filter(m => m.committee_id === App.activeCommitteeId); }
  function moduleById(id) { return modules().find(m => m.id === id) || null; }

  // ---- routing (hash based, validated against onboarded modules) ------------

  function route() {
    const h = (location.hash || '#overview').replace(/^#/, '');
    const [name, arg, sub] = h.split('/');
    if (name === 'module' && arg && moduleById(arg)) {
      return { name: 'module', id: arg, tab: sub === 'finance' && P.canUseFinance(myRoles()) ? 'finance' : 'details' };
    }
    if (name === 'team' && isManager()) return { name: 'team' };
    if (name === 'add-module' && isManager()) return { name: 'add-module' };
    return { name: 'overview' };
  }
  function go(hash) {
    if (location.hash === hash) renderWorkspace(); else location.hash = hash;
  }

  // ---- boot -----------------------------------------------------------------

  async function boot() {
    const el = root();
    if (!P.config()) {
      el.innerHTML = screenMessage('Setup needed',
        'The Supabase connection is not configured. Add <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> ' +
        '(see <code>.env.example</code>) and redeploy.');
      return;
    }
    if (!P.client()) {
      el.innerHTML = screenMessage('Cannot load', 'The database library could not be loaded. Check your internet connection and refresh.');
      return;
    }
    el.innerHTML = loadingScreen('Loading…');
    try {
      App.session = await P.auth.getSession();
    } catch (err) {
      el.innerHTML = retryScreen(err.message); return;
    }
    P.auth.onChange((event, session) => {
      if (event === 'SIGNED_OUT') { App.session = null; App.ws = null; renderAuth(); }
      else if (event === 'TOKEN_REFRESHED') App.session = session;
    });
    if (App.session) await enterApp(); else renderAuth();
  }

  async function enterApp() {
    root().innerHTML = loadingScreen('Loading your committees…');
    try {
      App.ws = await P.api.loadWorkspace(App.session.user.id);
    } catch (err) {
      root().innerHTML = retryScreen(err.message); return;
    }
    const ids = App.ws.memberships.map(m => m.committee.id);
    const saved = lsGet(ACTIVE_KEY);
    App.activeCommitteeId = ids.includes(saved) ? saved : (ids[0] || null);
    if (!App.activeCommitteeId) { renderFirstCommittee(); return; }
    lsSet(ACTIVE_KEY, App.activeCommitteeId);
    renderWorkspace();
  }

  window.addEventListener('hashchange', () => { if (App.ws && App.activeCommitteeId) renderWorkspace(); });

  // ---- small screens --------------------------------------------------------

  function headerBar(inner) {
    return '<header class="app-header"><div class="header-container">' +
      '<div class="brand-wrapper"><div class="brand-icon">🕌</div><div class="brand-title-group"><h1>Idarah</h1>' +
      '<p>Islamic Institutional Management</p></div></div>' + (inner || '') + '</div></header>';
  }
  function loadingScreen(msg) {
    return headerBar() + '<main class="main-container"><div class="card pf-center" aria-busy="true"><div class="pf-spinner" aria-hidden="true"></div><p>' + esc(msg) + '</p></div></main>';
  }
  function screenMessage(title, htmlBody) {
    return headerBar() + '<main class="main-container" style="max-width:560px"><div class="card"><h2>' + esc(title) + '</h2><p style="margin-top:8px">' + htmlBody + '</p></div></main>';
  }
  function retryScreen(msg) {
    return headerBar() + '<main class="main-container" style="max-width:560px"><div class="card pf-center"><h2>Could not load</h2>' +
      '<p style="margin:8px 0 16px">' + esc(msg) + '</p><button class="btn btn-primary" id="pf-retry">Try again</button></div></main>';
  }
  document.addEventListener('click', e => {
    if (e.target && e.target.id === 'pf-retry') { App.session ? enterApp() : boot(); }
  });

  // ---- auth screens ---------------------------------------------------------

  function renderAuth(initialTab) {
    const tab = initialTab || 'login';
    root().innerHTML = headerBar() +
      '<main class="main-container" style="max-width:520px;margin-top:24px"><div class="card">' +
      '<div style="text-align:center;margin-bottom:18px"><div style="font-size:2.4rem">🕌</div>' +
      '<h2 style="font-size:1.35rem">Welcome to Idarah</h2>' +
      '<p class="card-subtitle">One account for every mosque, madarsa, dargah and trust you serve</p></div>' +
      '<div class="pf-tabs" role="tablist">' +
      '<button type="button" role="tab" id="tab-login" class="nav-tab-btn' + (tab === 'login' ? ' active' : '') + '" aria-selected="' + (tab === 'login') + '">Log In</button>' +
      '<button type="button" role="tab" id="tab-signup" class="nav-tab-btn' + (tab === 'signup' ? ' active' : '') + '" aria-selected="' + (tab === 'signup') + '">Sign Up</button></div>' +
      (tab === 'login' ? loginForm() : signupForm()) + '</div></main>';

    root().querySelector('#tab-login').addEventListener('click', () => renderAuth('login'));
    root().querySelector('#tab-signup').addEventListener('click', () => renderAuth('signup'));
    bindPhoneInputs(root());
    if (tab === 'login') root().querySelector('#login-form').addEventListener('submit', onLogin);
    else root().querySelector('#signup-form').addEventListener('submit', onSignup);
  }

  function phoneField(id, label) {
    return '<div class="form-group"><label class="form-label" for="' + id + '">' + label + ' <span aria-hidden="true">*</span></label>' +
      '<div class="pf-phone"><span class="pf-cc" aria-hidden="true">🇮🇳 +91</span>' +
      '<input id="' + id + '" class="form-control" type="tel" inputmode="numeric" autocomplete="tel-national" maxlength="10" ' +
      'placeholder="10-digit mobile number" required aria-describedby="' + id + '-hint" />' +
      '</div><div class="card-subtitle" id="' + id + '-hint">India only (+91). Numbers start with 6, 7, 8 or 9.</div></div>';
  }
  function loginForm() {
    return '<form id="login-form" novalidate>' + phoneField('login-phone', 'Mobile Number') +
      '<div class="form-group"><label class="form-label" for="login-pass">Password <span aria-hidden="true">*</span></label>' +
      '<input id="login-pass" class="form-control" type="password" autocomplete="current-password" required /></div>' +
      '<div id="auth-error" class="pf-form-error" role="alert"></div>' +
      '<button type="submit" class="btn btn-primary btn-block" id="login-btn">Log In</button></form>';
  }
  function signupForm() {
    return '<form id="signup-form" novalidate>' +
      '<div class="form-group"><label class="form-label" for="su-name">Full Name <span aria-hidden="true">*</span></label>' +
      '<input id="su-name" class="form-control" maxlength="100" autocomplete="name" required /></div>' +
      phoneField('su-phone', 'Mobile Number') +
      '<div class="form-group"><label class="form-label" for="su-email">Email <small>(optional)</small></label>' +
      '<input id="su-email" class="form-control" type="email" autocomplete="email" /></div>' +
      '<div class="form-group"><label class="form-label" for="su-pass">Password <span aria-hidden="true">*</span></label>' +
      '<input id="su-pass" class="form-control" type="password" autocomplete="new-password" minlength="' + P.MIN_PASSWORD + '" required />' +
      '<div class="card-subtitle">At least ' + P.MIN_PASSWORD + ' characters.</div></div>' +
      '<div class="form-group"><label class="form-label" for="su-pass2">Confirm Password <span aria-hidden="true">*</span></label>' +
      '<input id="su-pass2" class="form-control" type="password" autocomplete="new-password" required /></div>' +
      '<div id="auth-error" class="pf-form-error" role="alert"></div>' +
      '<button type="submit" class="btn btn-primary btn-block" id="signup-btn">Create Account</button></form>';
  }
  function bindPhoneInputs(scope) {
    scope.querySelectorAll('input[type="tel"]').forEach(inp => {
      inp.addEventListener('input', () => { inp.value = inp.value.replace(/\D/g, '').slice(0, 10); });
    });
  }
  function authError(msg) {
    const box = root().querySelector('#auth-error');
    if (box) box.textContent = msg;
  }

  async function onLogin(e) {
    e.preventDefault();
    const digits = P.cleanPhoneDigits(root().querySelector('#login-phone').value);
    const password = root().querySelector('#login-pass').value;
    if (!P.PHONE_RE.test(digits)) return authError('Enter a valid 10-digit Indian mobile number.');
    if (!password) return authError('Enter your password.');
    authError('');
    try {
      App.session = await P.withLoading(root().querySelector('#login-btn'), 'Logging in…', () => P.auth.signIn({ tenDigits: digits, password }));
      await enterApp();
    } catch (err) { authError(err.message); P.toast(err.message, 'error'); }
  }

  async function onSignup(e) {
    e.preventDefault();
    const fullName = root().querySelector('#su-name').value.trim();
    const digits = P.cleanPhoneDigits(root().querySelector('#su-phone').value);
    const email = root().querySelector('#su-email').value.trim();
    const pass = root().querySelector('#su-pass').value;
    const pass2 = root().querySelector('#su-pass2').value;
    if (fullName.length < 2) return authError('Enter your full name.');
    if (!P.PHONE_RE.test(digits)) return authError('Enter a valid 10-digit Indian mobile number.');
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return authError('Enter a valid email or leave it blank.');
    if (pass.length < P.MIN_PASSWORD) return authError('Password must be at least ' + P.MIN_PASSWORD + ' characters.');
    if (pass !== pass2) return authError('Passwords do not match.');
    authError('');
    try {
      const res = await P.withLoading(root().querySelector('#signup-btn'), 'Creating account…',
        () => P.auth.signUp({ fullName, tenDigits: digits, password: pass, email }));
      if (res.needsConfirmation) {
        authError('Account created, but the server still wants email confirmation. In Supabase: Authentication > Sign In / Providers > turn OFF "Confirm email" and save, then log in.');
        return;
      }
      App.session = res.session;
      await enterApp();
    } catch (err) { authError(err.message); P.toast(err.message, 'error'); }
  }

  async function logout() {
    await P.auth.signOut();
    lsDel(ACTIVE_KEY);
    App.session = null; App.ws = null; App.activeCommitteeId = null;
    renderAuth();
  }

  // ---- first committee (no memberships yet) ---------------------------------

  function renderFirstCommittee() {
    root().innerHTML = headerBar('<div class="header-controls"><button class="btn btn-outline btn-sm pf-hdr-btn" id="pf-logout">🚪 Log out</button></div>') +
      '<main class="main-container" style="max-width:720px"><div id="pf-wizard-host"></div></main>';
    root().querySelector('#pf-logout').addEventListener('click', logout);
    P.renderWizard(root().querySelector('#pf-wizard-host'), {
      mode: 'new',
      onDone: async (cid) => { lsSet(ACTIVE_KEY, cid); location.hash = '#overview'; await enterApp(); }
    });
  }

  // ---- workspace shell ------------------------------------------------------

  function renderWorkspace() {
    const m = membership();
    if (!m) { enterApp(); return; }
    const c = m.committee;
    const r = route();
    const mods = modules();
    const profile = App.ws.profile || {};

    const switcher = '<select id="pf-switcher" class="lang-selector pf-switcher" aria-label="Switch committee">' +
      App.ws.memberships.map(x => '<option value="' + esc(x.committee.id) + '"' + (x.committee.id === c.id ? ' selected' : '') + '>' + esc(x.committee.name) + '</option>').join('') +
      '<option value="__new">➕ New committee…</option></select>';

    const navItem = (hash, icon, label, active, sub) =>
      '<a class="pf-nav-item' + (active ? ' active' : '') + '" href="' + hash + '"' + (active ? ' aria-current="page"' : '') + '>' +
      '<span class="pf-nav-icon" aria-hidden="true">' + icon + '</span><span class="pf-nav-text">' + esc(label) +
      (sub ? '<small>' + esc(sub) + '</small>' : '') + '</span></a>';

    const nav =
      navItem('#overview', '📊', 'Overview', r.name === 'overview') +
      '<div class="pf-nav-group">Modules</div>' +
      (mods.length ? mods.map(mod => navItem('#module/' + mod.id, P.MODULE_DEFS[mod.module_type].icon, mod.module_name,
        r.name === 'module' && r.id === mod.id, P.MODULE_DEFS[mod.module_type].label)).join('')
        : '<div class="pf-nav-empty">No modules available to you yet</div>') +
      (isManager() ? '<div class="pf-nav-group">Manage</div>' +
        navItem('#team', '👥', 'Team & Roles', r.name === 'team') +
        '<a class="pf-nav-item pf-nav-add' + (r.name === 'add-module' ? ' active' : '') + '" href="#add-module"><span class="pf-nav-icon" aria-hidden="true">➕</span><span class="pf-nav-text">Onboard Another Module</span></a>' : '');

    root().innerHTML =
      headerBar('<div class="header-controls">' + switcher +
        '<span class="pf-user" title="' + esc(profile.phone || '') + '">👤 ' + esc(profile.full_name || profile.phone || 'Account') + '</span>' +
        '<button class="btn btn-outline btn-sm pf-hdr-btn" id="pf-logout">🚪 Log out</button></div>') +
      '<div class="pf-layout"><nav class="pf-sidebar" aria-label="Workspace">' + nav + '</nav>' +
      '<main class="pf-main" id="pf-main" tabindex="-1"></main></div>';

    root().querySelector('#pf-logout').addEventListener('click', logout);
    root().querySelector('#pf-switcher').addEventListener('change', onSwitch);

    const main = root().querySelector('#pf-main');
    if (r.name === 'module') renderModulePage(main, moduleById(r.id), false, r.tab);
    else if (r.name === 'team') renderTeamPage(main);
    else if (r.name === 'add-module') renderAddModulePage(main);
    else renderOverview(main);
  }

  function onSwitch(e) {
    const v = e.target.value;
    if (v === '__new') {
      e.target.value = App.activeCommitteeId;
      renderNewCommitteePage();
      return;
    }
    App.activeCommitteeId = v;
    lsSet(ACTIVE_KEY, v);
    if (location.hash && location.hash !== '#overview') location.hash = '#overview'; else renderWorkspace();
  }

  function renderNewCommitteePage() {
    root().innerHTML = headerBar('<div class="header-controls"></div>') +
      '<main class="main-container" style="max-width:720px"><div id="pf-wizard-host"></div></main>';
    P.renderWizard(root().querySelector('#pf-wizard-host'), {
      mode: 'new',
      onCancel: () => renderWorkspace(),
      onDone: async (cid) => { lsSet(ACTIVE_KEY, cid); location.hash = '#overview'; await enterApp(); }
    });
  }

  // ---- overview -------------------------------------------------------------

  function roleChips(roles) {
    return roles.map(x => '<span class="pf-chip">' + esc(roleName[x] || x) + '</span>').join(' ');
  }

  function renderOverview(main) {
    const c = committee();
    const mods = modules();
    main.innerHTML =
      '<div class="card"><h2 class="card-title">🏛️ ' + esc(c.name) + '</h2>' +
      '<p class="card-subtitle">' + esc([c.city, c.state, c.country].filter(Boolean).join(', ')) + '</p>' +
      '<p style="margin-top:10px">Your roles: ' + roleChips(myRoles()) + '</p></div>' +
      '<h3 style="margin:4px 0 12px">Modules (' + mods.length + ')</h3>' +
      (mods.length ? '<div class="pf-cards pf-cards-link">' + mods.map(mod => {
        const d = P.MODULE_DEFS[mod.module_type];
        return '<a class="pf-module-card pf-link-card" href="#module/' + esc(mod.id) + '">' +
          '<span class="pf-card-icon" aria-hidden="true">' + d.icon + '</span>' +
          '<span class="pf-card-text"><strong>' + esc(mod.module_name) + '</strong><small>' + esc(d.label) + '</small></span></a>';
      }).join('') + '</div>'
        : '<div class="card"><p>No modules are available to you in this committee.</p></div>') +
      (isManager() ? '<p style="margin-top:16px"><a class="btn btn-secondary" href="#add-module">➕ Onboard Another Module</a></p>' : '');
  }

  // ---- module page ----------------------------------------------------------

  function renderModulePage(main, mod, editing, tab) {
    const d = P.MODULE_DEFS[mod.module_type];
    const canEdit = isManager();
    const showFinance = P.canUseFinance(myRoles());
    const tabBar = showFinance
      ? '<div class="pf-subtabs"><a href="#module/' + esc(mod.id) + '" class="pf-subtab' + (tab !== 'finance' ? ' active' : '') + '">Details</a>' +
        '<a href="#module/' + esc(mod.id) + '/finance" class="pf-subtab' + (tab === 'finance' ? ' active' : '') + '">💰 Finance</a></div>'
      : '';
    if (tab === 'finance' && showFinance && !editing) {
      main.innerHTML = tabBar + '<h2 class="card-title" style="margin-bottom:12px">' + d.icon + ' ' + esc(mod.module_name) + '</h2><div id="pf-fin-host"></div>';
      P.renderFinance(main.querySelector('#pf-fin-host'), mod, { committee: committee(), canWrite: true });
      return;
    }

    if (editing) {
      const values = Object.assign({ module_name: mod.module_name }, mod.details || {});
      main.innerHTML = '<div class="card"><h2 class="card-title">' + d.icon + ' Edit ' + esc(d.label) + '</h2>' +
        '<form id="pf-edit-form" novalidate>' + P.renderFields(mod.module_type, values, {}, 'pf-edit') + '</form>' +
        '<div id="pf-wizard-error" class="pf-form-error" role="alert"></div>' +
        '<div class="pf-actions"><button class="btn btn-outline" id="pf-edit-cancel">Cancel</button>' +
        '<button class="btn btn-primary" id="pf-edit-save">💾 Save</button></div></div>';
      const form = main.querySelector('#pf-edit-form');
      const cur = Object.assign({}, values);
      form.addEventListener('change', () => {
        const before = JSON.stringify(d.fields.map(f => P.fieldVisible(f, cur)));
        Object.assign(cur, P.readFields(mod.module_type, form));
        if (before !== JSON.stringify(d.fields.map(f => P.fieldVisible(f, cur)))) {
          form.innerHTML = P.renderFields(mod.module_type, cur, {}, 'pf-edit');
        }
      });
      main.querySelector('#pf-edit-cancel').addEventListener('click', () => renderModulePage(main, mod));
      main.querySelector('#pf-edit-save').addEventListener('click', async (e) => {
        Object.assign(cur, P.readFields(mod.module_type, form));
        const res = P.validateModuleForm(mod.module_type, cur);
        if (!res.ok) {
          form.innerHTML = P.renderFields(mod.module_type, cur, res.errors, 'pf-edit');
          main.querySelector('#pf-wizard-error').textContent = 'Please fix the highlighted fields.';
          return;
        }
        try {
          const saved = await P.withLoading(e.currentTarget, 'Saving…', () => P.api.updateModule(mod.id, { module_name: res.clean.module_name, details: res.clean.details }));
          mod.module_name = saved.module_name; mod.details = saved.details;
          P.toast('Saved.', 'success');
          renderWorkspace();
        } catch (err) { main.querySelector('#pf-wizard-error').textContent = err.message; P.toast(err.message, 'error'); }
      });
      return;
    }

    const details = mod.details || {};
    const rows = d.fields.filter(f => f.key !== 'module_name').map(f =>
      '<tr><th scope="row">' + esc(f.label) + '</th><td>' + esc(P.formatFieldValue(f, details[f.key])) + '</td></tr>').join('');
    main.innerHTML = tabBar +
      '<div class="card"><div class="card-header"><div><h2 class="card-title">' + d.icon + ' ' + esc(mod.module_name) + '</h2>' +
      '<p class="card-subtitle">' + esc(d.label) + ' · part of ' + esc(committee().name) + '</p></div>' +
      (canEdit ? '<button class="btn btn-outline btn-sm" id="pf-edit-btn">✏️ Edit details</button>' : '') + '</div>' +
      '<div class="table-responsive"><table class="data-table pf-kv" style="min-width:0"><tbody>' + rows + '</tbody></table></div></div>' +
      '<div class="card"><h3 class="card-title">🛠️ Coming next in this module</h3><ul class="pf-list">' +
      d.next.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>' +
      '<p class="card-subtitle">The database tables and role permissions for these are already in place.</p></div>';
    const eb = main.querySelector('#pf-edit-btn');
    if (eb) eb.addEventListener('click', () => renderModulePage(main, mod, true));
  }

  // ---- add module -----------------------------------------------------------

  function renderAddModulePage(main) {
    const counts = {};
    modules().forEach(m => { counts[m.module_type] = (counts[m.module_type] || 0) + 1; });
    main.innerHTML = '<div id="pf-wizard-host"></div>';
    P.renderWizard(main.querySelector('#pf-wizard-host'), {
      mode: 'add',
      committee: committee(),
      existingCounts: counts,
      onCancel: () => go('#overview'),
      onDone: async () => { location.hash = '#overview'; await enterApp(); }
    });
  }

  // ---- team -----------------------------------------------------------------

  async function renderTeamPage(main) {
    main.innerHTML = '<div class="card pf-center" aria-busy="true"><div class="pf-spinner"></div><p>Loading team…</p></div>';
    let members;
    try { members = await P.api.listMembers(App.activeCommitteeId); }
    catch (err) { main.innerHTML = '<div class="card"><p class="pf-form-error">' + esc(err.message) + '</p></div>'; return; }

    const mods = modules();
    const myId = App.session.user.id;
    main.innerHTML =
      '<div class="card"><h2 class="card-title">👥 Team & Roles</h2><p class="card-subtitle">One person can hold several roles. They must create an Idarah account first.</p>' +
      '<div class="table-responsive"><table class="data-table" style="min-width:560px"><thead><tr><th>Name</th><th>Mobile</th><th>Roles</th><th>Modules</th><th></th></tr></thead><tbody>' +
      members.map(m => {
        const allowed = m.allowed_modules && m.allowed_modules.length
          ? m.allowed_modules.map(id => { const x = mods.find(y => y.id === id); return x ? x.module_name : '—'; }).join(', ') : 'All';
        return '<tr><td>' + esc(m.profile ? m.profile.full_name || '—' : '—') + (m.user_id === myId ? ' <small>(you)</small>' : '') + '</td>' +
          '<td>' + esc(m.profile ? m.profile.phone : '') + '</td><td>' + roleChips(m.roles) + '</td><td>' + esc(allowed) + '</td>' +
          '<td>' + (m.user_id === myId ? '' : '<button class="btn btn-danger btn-sm pf-remove" data-id="' + esc(m.id) + '">Remove</button>') + '</td></tr>';
      }).join('') + '</tbody></table></div></div>' +
      '<div class="card"><h3 class="card-title">➕ Add or update a member</h3>' +
      '<form id="pf-member-form" novalidate>' + phoneField('pf-m-phone', 'Mobile Number') +
      '<fieldset class="pf-fieldset"><legend class="form-label">Roles</legend><div class="pf-roles">' +
      P.ROLES.map(([k, label]) => '<label class="pf-role-opt"><input type="checkbox" name="role" value="' + k + '" /> <span><strong>' + esc(label) + '</strong><small>' + esc(P.ROLE_HELP[k]) + '</small></span></label>').join('') +
      '</div></fieldset>' +
      (mods.length > 1 ? '<fieldset class="pf-fieldset"><legend class="form-label">Limit to modules <small>(none ticked = all modules)</small></legend><div class="pf-roles">' +
        mods.map(x => '<label class="pf-role-opt"><input type="checkbox" name="mod" value="' + esc(x.id) + '" /> <span>' + esc(P.MODULE_DEFS[x.module_type].icon + ' ' + x.module_name) + '</span></label>').join('') +
        '</div></fieldset>' : '') +
      '<div id="pf-member-error" class="pf-form-error" role="alert"></div>' +
      '<button type="submit" class="btn btn-primary" id="pf-member-btn">Save member</button></form></div>';

    bindPhoneInputs(main);
    main.querySelectorAll('.pf-remove').forEach(b => b.addEventListener('click', async () => {
      if (!window.confirm('Remove this member from the committee?')) return;
      try { await P.withLoading(b, 'Removing…', () => P.api.removeMember(b.dataset.id)); P.toast('Member removed.', 'success'); renderTeamPage(main); }
      catch (err) { P.toast(err.message, 'error'); }
    }));
    main.querySelector('#pf-member-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const box = main.querySelector('#pf-member-error');
      const digits = P.cleanPhoneDigits(main.querySelector('#pf-m-phone').value);
      const roles = Array.from(main.querySelectorAll('input[name="role"]:checked')).map(x => x.value);
      const allowed = Array.from(main.querySelectorAll('input[name="mod"]:checked')).map(x => x.value);
      if (!P.PHONE_RE.test(digits)) { box.textContent = 'Enter a valid 10-digit Indian mobile number.'; return; }
      if (!roles.length) { box.textContent = 'Choose at least one role.'; return; }
      box.textContent = '';
      try {
        await P.withLoading(main.querySelector('#pf-member-btn'), 'Saving…', () => P.api.addMember(App.activeCommitteeId, digits, roles, allowed));
        P.toast('Member saved.', 'success');
        renderTeamPage(main);
      } catch (err) { box.textContent = err.message; P.toast(err.message, 'error'); }
    });
  }

  // ---- start ----------------------------------------------------------------

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
