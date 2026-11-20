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
    const finance = P.canUseFinance(myRoles()) && modules().length > 0;
    if (name === 'module' && arg && moduleById(arg)) {
      if (sub === 'finance' && finance) return { name: 'finance', id: arg };           // old links
      return { name: 'module', id: arg, section: sub || '' };
    }
    if (name === 'finance' && finance) return { name: 'finance', id: arg && moduleById(arg) ? arg : modules()[0].id };
    if (name === 'reports' && finance) return { name: 'reports' };
    if (name === 'settings' && isManager()) return { name: 'settings', tab: ['team', 'modules', 'add-module'].includes(arg) ? arg : 'team' };
    if (name === 'team' && isManager()) return { name: 'settings', tab: 'team' };              // old links
    if (name === 'add-module' && isManager()) return { name: 'settings', tab: 'add-module' };  // old links
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
    // language dropdown sits in the top right, just before the Log out button (or alone on login screens)
    const lang = window.I18N ? window.I18N.selectHtml() : '';
    const ctl = '<div class="header-controls">';
    inner = inner && inner.indexOf(ctl) === 0 ? ctl + lang + inner.slice(ctl.length) : ctl + lang + '</div>';
    return '<header class="app-header"><div class="header-container">' +
      '<div class="brand-wrapper"><div class="brand-icon">🕌</div><div class="brand-title-group"><h1>Idarah</h1>' +
      '<p>Islamic Institutional Management</p></div></div>' + inner + '</div></header>';
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

  /** What the screens need to know about the current user. has() hides buttons only; the database decides. */
  function ctx() {
    const roles = myRoles();
    return { committee: committee(), roles, has: (...allowed) => P.hasRole(roles, allowed) };
  }

  function renderWorkspace() {
    const m = membership();
    if (!m) { enterApp(); return; }
    const c = m.committee;
    const r = route();
    const mods = modules();
    const profile = App.ws.profile || {};
    const finance = P.canUseFinance(myRoles()) && mods.length > 0;

    const switcher = '<select id="pf-switcher" class="form-control" style="width:auto;max-width:260px;min-height:36px;padding:2px 10px;font-weight:700" aria-label="Switch committee">' +
      App.ws.memberships.map(x => '<option value="' + esc(x.committee.id) + '"' + (x.committee.id === c.id ? ' selected' : '') + '>' + esc(x.committee.name) + '</option>').join('') +
      '<option value="__new">➕ New committee…</option></select>';

    const tab = (hash, icon, label, active) =>
      '<a class="nav-tab-btn' + (active ? ' active' : '') + '" href="' + hash + '"' + (active ? ' aria-current="page"' : '') + '>' + icon + ' ' + esc(label) + '</a>';

    const tabs =
      tab('#overview', '📊', 'Dashboard', r.name === 'overview') +
      (finance ? tab('#finance', '💰', 'Finance', r.name === 'finance') : '') +
      mods.map(mod => tab('#module/' + mod.id, P.MODULE_DEFS[mod.module_type].icon, mod.module_name, r.name === 'module' && r.id === mod.id)).join('') +
      (finance ? tab('#reports', '📑', 'Reports', r.name === 'reports') : '') +
      (isManager() ? tab('#settings', '⚙️', 'Settings', r.name === 'settings') : '');

    root().innerHTML =
      headerBar('<div class="header-controls"><button class="btn btn-outline btn-sm pf-hdr-btn" id="pf-logout">🚪 Log out</button></div>') +
      '<div class="mosque-bar"><div class="mosque-bar-container">' +
      '<div class="mosque-info-pill">' + switcher + '<span>📍 ' + esc([c.city, c.state].filter(Boolean).join(', ')) + '</span></div>' +
      '<div class="user-badge-group"><span style="font-weight:600">👤 ' + esc(profile.full_name || profile.phone || 'Account') + '</span>' + roleChips(myRoles()) + '</div>' +
      '</div></div>' +
      '<nav class="nav-tabs-bar" aria-label="Workspace"><div class="nav-tabs-container">' + tabs + '</div></nav>' +
      '<main class="main-container" id="pf-main" tabindex="-1"></main>';

    root().querySelector('#pf-logout').addEventListener('click', logout);
    root().querySelector('#pf-switcher').addEventListener('change', onSwitch);

    const main = root().querySelector('#pf-main');
    if (r.name === 'module') renderModulePage(main, moduleById(r.id), r.section);
    else if (r.name === 'finance') renderFinanceTab(main, r.id);
    else if (r.name === 'reports') P.renderReports(main, c, mods, ctx());
    else if (r.name === 'settings') renderSettings(main, r.tab);
    else renderDashboard(main);
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

  async function renderDashboard(main) {
    const c = committee();
    const mods = modules();
    const finance = P.canUseFinance(myRoles()) && mods.length > 0;
    const month = window.getISTMonth();
    main.innerHTML = P.loadingHtml('Loading dashboard…');

    const safe = p => p.catch(() => []);
    const hasMadarsa = mods.some(x => x.module_type === 'madarsa');
    const hasMosque = mods.some(x => x.module_type === 'mosque');
    const [funds, students, paid, times, notices] = await Promise.all([
      finance ? safe(P.api.listRows('funds', { committeeId: c.id, select: 'id, module_id, name, is_zakat_restricted, current_balance', order: 'created_at' })) : [],
      hasMadarsa ? safe(P.api.listRows('students', { committeeId: c.id, select: 'id, module_id, monthly_fee' })) : [],
      hasMadarsa ? safe(P.api.listRows('fee_payments', { committeeId: c.id, select: 'student_id', eq: { month } })) : [],
      hasMosque ? safe(P.api.listRows('prayer_times', { committeeId: c.id })) : [],
      safe(P.api.listRows('notices', { committeeId: c.id, order: 'published_on', ascending: false, limit: 3 }))
    ]);

    const money = window.formatCurrency;
    const total = funds.reduce((a, f) => a + Number(f.current_balance), 0);
    const paidIds = new Set(paid.map(p => p.student_id));
    const modName = Object.fromEntries(mods.map(x => [x.id, x]));

    const fundGrid = mods.map(mod => {
      const fs = funds.filter(f => f.module_id === mod.id);
      if (!fs.length) return '';
      return (mods.length > 1 ? '<h4 style="margin:10px 0 8px">' + P.MODULE_DEFS[mod.module_type].icon + ' ' + esc(mod.module_name) + '</h4>' : '') +
        '<div class="metrics-grid">' + fs.map(f =>
          '<div class="metric-card ' + (f.is_zakat_restricted ? 'zakat-restricted' : 'general-fund') + '"><div class="metric-card-title">' + esc(f.name) + '</div>' +
          '<div class="metric-card-amount">' + esc(money(f.current_balance)) + '</div><span class="metric-card-badge ' + (f.is_zakat_restricted ? 'badge-zakat' : 'badge-general') + '">' +
          (f.is_zakat_restricted ? '⚠️ Zakat Restricted' : '✅ General') + '</span></div>').join('') + '</div>';
    }).join('');

    const madarsaCards = mods.filter(x => x.module_type === 'madarsa').map(mod => {
      const st = students.filter(s => s.module_id === mod.id);
      const due = st.filter(s => !paidIds.has(s.id));
      return '<div class="card"><div class="card-title">📖 ' + esc(mod.module_name) + '</div>' +
        '<p style="margin:8px 0;color:var(--text-muted)">Enrolled Students: <strong>' + st.length + '</strong></p>' +
        '<p style="margin:8px 0;font-weight:600;color:' + (due.length ? 'var(--gold)' : 'var(--success)') + '">Pending Fees for ' + esc(month) + ': ' + due.length + ' students</p>' +
        '<a class="btn btn-secondary btn-sm" href="#module/' + esc(mod.id) + '">Open →</a></div>';
    }).join('');

    const prayerNames = [['fajr', 'Fajr'], ['dhuhr', 'Dhuhr'], ['asr', 'Asr'], ['maghrib', 'Maghrib'], ['isha', 'Isha'], ['jumuah', "Jumu'ah"]];
    const mosqueCards = mods.filter(x => x.module_type === 'mosque').map(mod => {
      const by = Object.fromEntries(times.filter(t => t.module_id === mod.id).map(t => [t.prayer, t]));
      return '<div class="card"><div class="card-title">⏰ ' + esc(mod.module_name) + ' — Salah Timings</div>' +
        '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:10px;font-size:.85rem">' +
        prayerNames.map(([k, n]) => '<div style="background:var(--bg-app);padding:6px;border-radius:8px;text-align:center"><div style="font-weight:700">' + n + '</div>' +
          '<div style="color:var(--primary);font-weight:600">' + esc(by[k] && by[k].iqamah_time ? String(by[k].iqamah_time).slice(0, 5) : '--:--') + '</div></div>').join('') + '</div></div>';
    }).join('');

    const noticeCard = notices.length
      ? '<div class="card"><div class="card-title">📢 Latest Notices</div>' + notices.map(n =>
        '<div style="background:var(--bg-app);padding:8px 12px;border-radius:8px;margin-top:8px"><div style="font-weight:700;color:var(--primary)">' + esc(n.title) + '</div>' +
        '<div style="font-size:.85rem;margin:4px 0;white-space:pre-wrap">' + esc(n.body || '') + '</div><div class="card-subtitle">📅 ' + esc(n.published_on) +
        (modName[n.module_id] ? ' · ' + esc(modName[n.module_id].module_name) : '') + '</div></div>').join('') + '</div>' : '';

    main.innerHTML =
      (finance ? '<div class="card" style="background:linear-gradient(135deg,#047857 0%,#065f46 100%);color:#fff"><div style="font-size:.9rem;opacity:.9;text-transform:uppercase;letter-spacing:.5px">Total Treasury Balance</div>' +
        '<div style="font-size:2.3rem;font-weight:800;margin:8px 0">' + esc(money(total)) + '</div>' +
        '<div style="font-size:.85rem;opacity:.85">🛡️ Tamper-evident ledger secured with SHA-256 cryptography</div></div>' +
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-bottom:20px">' +
        '<a class="btn btn-primary" href="#finance">➕ New Donation</a><a class="btn btn-secondary" href="#finance">➖ New Expense</a><a class="btn btn-outline" href="#finance">🔍 Verify Ledger</a></div>' : '') +
      (finance ? '<h3 style="margin-bottom:12px;font-weight:700">Fund Balances</h3>' + (fundGrid || '<p class="card-subtitle">No funds yet.</p>') : '') +
      (madarsaCards || mosqueCards || noticeCard ? '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px">' + madarsaCards + mosqueCards + noticeCard + '</div>' : '') +
      '<h3 style="margin:8px 0 12px">Your Modules (' + mods.length + ')</h3>' +
      (mods.length ? '<div class="pf-cards pf-cards-link">' + mods.map(mod => {
        const d = P.MODULE_DEFS[mod.module_type];
        return '<a class="pf-module-card pf-link-card" href="#module/' + esc(mod.id) + '"><span class="pf-card-icon" aria-hidden="true">' + d.icon + '</span>' +
          '<span class="pf-card-text"><strong>' + esc(mod.module_name) + '</strong><small>' + esc(d.label) + '</small></span></a>';
      }).join('') + '</div>' : '<div class="card"><p>No modules are available to you in this committee.</p></div>') +
      (isManager() ? '<p style="margin-top:16px"><a class="btn btn-secondary" href="#settings/add-module">➕ Onboard Another Module</a></p>' : '');
  }

  // ---- finance tab (pick a module, then the ledger of that module) -----------

  function renderFinanceTab(main, modId) {
    const mods = modules();
    const mod = moduleById(modId);
    main.innerHTML = (mods.length > 1
      ? '<div class="card" style="padding:12px 16px"><label class="form-label" for="pf-fin-mod">Module</label><select id="pf-fin-mod" class="form-control">' +
        mods.map(x => '<option value="' + esc(x.id) + '"' + (x.id === mod.id ? ' selected' : '') + '>' + esc(P.MODULE_DEFS[x.module_type].icon + ' ' + x.module_name) + '</option>').join('') + '</select></div>'
      : '') + '<div id="pf-fin-host"></div>';
    const sel = main.querySelector('#pf-fin-mod');
    if (sel) sel.addEventListener('change', e => { location.hash = '#finance/' + e.target.value; });
    P.renderFinance(main.querySelector('#pf-fin-host'), mod, { committee: committee(), canWrite: true });
  }

  // ---- module page: one button per screen the module offers ------------------

  function renderModulePage(main, mod, sectionKey) {
    const d = P.MODULE_DEFS[mod.module_type];
    const sections = (P.SECTIONS[mod.module_type] || []).concat([{ key: 'details', label: 'Details', icon: 'ℹ️', render: (host, m) => renderModuleDetails(host, m, false) }]);
    const cur = sections.find(s => s.key === sectionKey) || sections[0];
    main.innerHTML =
      '<div class="card-header"><div><h2 class="card-title">' + d.icon + ' ' + esc(mod.module_name) + '</h2>' +
      '<p class="card-subtitle">' + esc(d.label) + ' · ' + esc(committee().name) + '</p></div>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap">' + sections.map(s =>
        '<a class="btn ' + (s === cur ? 'btn-primary' : 'btn-outline') + ' btn-sm" href="#module/' + esc(mod.id) + '/' + esc(s.key) + '"' + (s === cur ? ' aria-current="page"' : '') + '>' +
        s.icon + ' ' + esc(s.label) + '</a>').join('') + '</div></div><div id="pf-sec"></div>';
    cur.render(main.querySelector('#pf-sec'), mod, ctx());
  }

  /** Module information (from onboarding) with an Edit form for admins / trustees. */
  function renderModuleDetails(host, mod, editing) {
    const d = P.MODULE_DEFS[mod.module_type];
    const canEdit = isManager();

    if (editing) {
      const values = Object.assign({ module_name: mod.module_name }, mod.details || {});
      host.innerHTML = '<div class="card"><h3 class="card-title">' + d.icon + ' Edit ' + esc(d.label) + '</h3>' +
        '<form id="pf-edit-form" novalidate>' + P.renderFields(mod.module_type, values, {}, 'pf-edit') + '</form>' +
        '<div id="pf-wizard-error" class="pf-form-error" role="alert"></div>' +
        '<div class="pf-actions"><button class="btn btn-outline" id="pf-edit-cancel">Cancel</button>' +
        '<button class="btn btn-primary" id="pf-edit-save">💾 Save</button></div></div>';
      const form = host.querySelector('#pf-edit-form');
      const cur = Object.assign({}, values);
      form.addEventListener('change', () => {
        const before = JSON.stringify(d.fields.map(f => P.fieldVisible(f, cur)));
        Object.assign(cur, P.readFields(mod.module_type, form));
        if (before !== JSON.stringify(d.fields.map(f => P.fieldVisible(f, cur)))) form.innerHTML = P.renderFields(mod.module_type, cur, {}, 'pf-edit');
      });
      host.querySelector('#pf-edit-cancel').addEventListener('click', () => renderModuleDetails(host, mod, false));
      host.querySelector('#pf-edit-save').addEventListener('click', async (e) => {
        Object.assign(cur, P.readFields(mod.module_type, form));
        const res = P.validateModuleForm(mod.module_type, cur);
        if (!res.ok) {
          form.innerHTML = P.renderFields(mod.module_type, cur, res.errors, 'pf-edit');
          host.querySelector('#pf-wizard-error').textContent = 'Please fix the highlighted fields.';
          return;
        }
        try {
          const saved = await P.withLoading(e.currentTarget, 'Saving…', () => P.api.updateModule(mod.id, { module_name: res.clean.module_name, details: res.clean.details }));
          mod.module_name = saved.module_name; mod.details = saved.details;
          P.toast('Saved.', 'success');
          renderWorkspace();
        } catch (err) { host.querySelector('#pf-wizard-error').textContent = err.message; P.toast(err.message, 'error'); }
      });
      return;
    }

    const details = mod.details || {};
    const rows = d.fields.filter(f => f.key !== 'module_name').map(f =>
      '<tr><th scope="row">' + esc(f.label) + '</th><td>' + esc(P.formatFieldValue(f, details[f.key])) + '</td></tr>').join('');
    host.innerHTML = '<div class="card"><div class="card-header"><div><h3 class="card-title">ℹ️ ' + esc(mod.module_name) + '</h3>' +
      '<p class="card-subtitle">Information entered when this module was onboarded</p></div>' +
      (canEdit ? '<button class="btn btn-outline btn-sm" id="pf-edit-btn">✏️ Edit details</button>' : '') + '</div>' +
      '<div class="table-responsive"><table class="data-table pf-kv" style="min-width:0"><tbody>' + rows + '</tbody></table></div></div>';
    const eb = host.querySelector('#pf-edit-btn');
    if (eb) eb.addEventListener('click', () => renderModuleDetails(host, mod, true));
  }

  // ---- settings: team, module details, onboard another module -------------------

  function renderSettings(main, tab) {
    const mods = modules();
    const btn = (key, label) => '<a class="btn ' + (tab === key ? 'btn-primary' : 'btn-outline') + ' btn-sm" href="#settings/' + key + '"' + (tab === key ? ' aria-current="page"' : '') + '>' + label + '</a>';
    main.innerHTML =
      '<div class="card-header"><div><h2 class="card-title">⚙️ Settings</h2><p class="card-subtitle">' + esc(committee().name) + '</p></div>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap">' + btn('team', '👥 Team &amp; Roles') + btn('modules', '🏛️ Modules &amp; Details') + btn('add-module', '➕ Onboard Another Module') + '</div></div>' +
      '<div id="pf-set"></div>';
    const host = main.querySelector('#pf-set');
    if (tab === 'add-module') renderAddModulePage(host);
    else if (tab === 'modules') {
      host.innerHTML = mods.map(mod => '<div class="card"><div class="card-title">' + P.MODULE_DEFS[mod.module_type].icon + ' ' + esc(mod.module_name) +
        ' <small style="font-weight:500;color:var(--text-muted)">' + esc(P.MODULE_DEFS[mod.module_type].label) + '</small></div><div data-mod="' + esc(mod.id) + '" style="margin-top:8px"></div></div>').join('') || '<div class="card"><p>No modules yet.</p></div>';
      mods.forEach(mod => renderModuleDetails(host.querySelector('[data-mod="' + mod.id + '"]'), mod, false));
    } else renderTeamPage(host);
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
