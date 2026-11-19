/**
 * Idarah platform - core: Supabase client, phone/password auth, data access.
 * platform-core.js
 *
 * Online-only (V1): every call goes to Supabase. Failures caused by a missing
 * connection are turned into a friendly message instead of a raw error.
 * Security lives in the database (RLS); nothing here is trusted for access control.
 */
(function () {
  'use strict';

  const P = (window.IdarahPlatform = window.IdarahPlatform || {});

  // ---- phone helpers (India only) ------------------------------------------
  P.PHONE_RE = /^[6-9]\d{9}$/;
  P.cleanPhoneDigits = function (raw) { return String(raw || '').replace(/\D/g, '').slice(-10); };
  P.toE164 = function (tenDigits) { return '+91' + tenDigits; };
  // Until SMS/OTP exists, the phone number is mapped to a hidden login address
  // (Supabase's Phone provider needs a paid SMS account). The database trigger
  // derives profiles.phone from this exact format.
  P.toLoginEmail = function (tenDigits) { return '91' + tenDigits + '@phone.idarah.example.com'; };
  P.MIN_PASSWORD = 8;

  // ---- toast ---------------------------------------------------------------
  P.toast = function (message, type) {
    let box = document.getElementById('toast-container');
    if (!box) {
      box = document.createElement('div');
      box.id = 'toast-container';
      box.className = 'toast-container';
      document.body.appendChild(box);
    }
    const el = document.createElement('div');
    el.className = 'toast toast-' + (type || 'info');
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    el.textContent = message;
    box.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.3s ease';
      setTimeout(() => el.remove(), 300);
    }, type === 'error' ? 6000 : 3500);
  };

  // ---- friendly errors -----------------------------------------------------
  P.isNetworkError = function (err) {
    const msg = String((err && (err.message || err)) || '').toLowerCase();
    return (typeof navigator !== 'undefined' && navigator.onLine === false) ||
      msg.includes('failed to fetch') || msg.includes('networkerror') ||
      msg.includes('network request failed') || msg.includes('load failed');
  };

  P.friendlyError = function (err) {
    if (P.isNetworkError(err)) {
      return 'No internet connection. Your changes were NOT saved. Please check your network and try again.';
    }
    const msg = String((err && err.message) || err || 'Something went wrong');
    if (/invalid login credentials/i.test(msg)) return 'Wrong mobile number or password.';
    if (/already registered|already been registered|user already exists/i.test(msg)) return 'This mobile number already has an account. Please log in.';
    if (/row-level security|permission denied|42501/i.test(msg)) return 'You do not have permission to do this.';
    if (/password should be at least/i.test(msg)) return 'Password must be at least ' + P.MIN_PASSWORD + ' characters.';
    if (/rate limit|too many requests/i.test(msg)) return 'Too many attempts. Please wait a minute and try again.';
    if (/database error saving new user/i.test(msg)) return 'Could not create the account. Please check the mobile number and try again.';
    if (/signups? not allowed|email.*(disabled|not allowed)/i.test(msg)) return 'New sign-ups are switched off on the server.';
    if (/email.*(invalid|not valid)/i.test(msg)) return 'The server rejected the sign-up address. Please contact support.';
    return msg;
  };

  // ---- client --------------------------------------------------------------
  P.config = function () {
    const c = window.IDARAH_SUPABASE || {};
    return (c.url && c.anonKey) ? c : null;
  };

  let _client = null;
  P.client = function () {
    if (_client) return _client;
    const cfg = P.config();
    if (!cfg || !window.supabase || !window.supabase.createClient) return null;
    _client = window.supabase.createClient(cfg.url, cfg.anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
    });
    return _client;
  };

  /** Throws a plain Error with a friendly message if Supabase returned an error. */
  function unwrap(res) {
    if (res && res.error) {
      const e = new Error(P.friendlyError(res.error));
      e.original = res.error;
      throw e;
    }
    return res.data;
  }

  async function guarded(fn) {
    try { return await fn(); }
    catch (err) {
      if (err && err.original) throw err;                       // already friendly
      const e = new Error(P.friendlyError(err)); e.original = err; throw e;
    }
  }

  // ---- auth ----------------------------------------------------------------
  P.auth = {
    async getSession() {
      return guarded(async () => unwrap(await P.client().auth.getSession()).session);
    },

    async signUp({ fullName, tenDigits, password, email }) {
      return guarded(async () => {
        const data = unwrap(await P.client().auth.signUp({
          email: P.toLoginEmail(tenDigits),
          password,
          options: { data: { full_name: fullName, contact_email: email || '' } }
        }));
        return { session: data.session, needsConfirmation: !data.session };
      });
    },

    async signIn({ tenDigits, password }) {
      return guarded(async () => unwrap(await P.client().auth.signInWithPassword({
        email: P.toLoginEmail(tenDigits), password
      })).session);
    },

    async signOut() {
      try { await P.client().auth.signOut(); } catch (e) { /* ignore: local session is cleared anyway */ }
    },

    onChange(cb) { return P.client().auth.onAuthStateChange((event, session) => cb(event, session)); }
  };

  // ---- data ----------------------------------------------------------------
  P.api = {
    /** Profile + every committee the user belongs to + the modules they may see. */
    async loadWorkspace(userId) {
      return guarded(async () => {
        const sb = P.client();
        const [profileRes, memRes] = await Promise.all([
          sb.from('profiles').select('id, full_name, phone, email').eq('id', userId).maybeSingle(),
          sb.from('committee_memberships')
            .select('id, roles, allowed_modules, status, committee:committees(id, name, city, state, country)')
            .eq('user_id', userId).eq('status', 'active')
        ]);
        const profile = unwrap(profileRes);
        const memberships = (unwrap(memRes) || []).filter(m => m.committee);

        let modules = [];
        if (memberships.length) {
          modules = unwrap(await sb.from('organization_modules')
            .select('id, committee_id, module_type, module_name, details, is_active, created_at')
            .in('committee_id', memberships.map(m => m.committee.id))
            .eq('is_active', true)
            .order('created_at', { ascending: true })) || [];
        }
        return { profile, memberships, modules };
      });
    },

    async createCommittee({ name, city, state, modules }) {
      return guarded(async () => unwrap(await P.client().rpc('create_committee_with_modules', {
        p_name: name, p_city: city || '', p_state: state || '', p_modules: modules
      })));
    },

    async addModules(committeeId, modules) {
      return guarded(async () => unwrap(await P.client().rpc('add_modules', {
        p_committee_id: committeeId, p_modules: modules
      })));
    },

    async updateModule(id, { module_name, details }) {
      return guarded(async () => {
        const rows = unwrap(await P.client().from('organization_modules')
          .update({ module_name, details }).eq('id', id).select('id, module_name, details'));
        if (!rows || !rows.length) throw new Error('You do not have permission to edit this module.');
        return rows[0];
      });
    },

    // ---- finance ----
    async listFunds(moduleId) {
      return guarded(async () => unwrap(await P.client().from('funds')
        .select('id, name, is_zakat_eligible').eq('module_id', moduleId).order('name')) || []);
    },

    async fundBalances(moduleId) {
      return guarded(async () => {
        const rows = unwrap(await P.client().rpc('module_fund_balances', { p_module_id: moduleId })) || [];
        return Object.fromEntries(rows.map(r => [r.fund_id, Number(r.balance)]));
      });
    },

    async listLedger(moduleId, limit) {
      return guarded(async () => unwrap(await P.client().from('ledger_entries')
        .select('id, seq, entry_date, type, amount, fund_id, method, category, note, donor_name, donor_phone, receipt_no, verify_code, reverses_entry_id, hash')
        .eq('module_id', moduleId).order('seq', { ascending: false }).limit(limit || 200)) || []);
    },

    /** The database assigns seq, date, receipt number, verification code and hash. */
    async addLedgerEntry(row) {
      return guarded(async () => unwrap(await P.client().from('ledger_entries').insert(row)
        .select('id, seq, entry_date, type, amount, fund_id, method, category, note, donor_name, donor_phone, receipt_no, verify_code, reverses_entry_id, hash')
        .single()));
    },

    async verifyLedger(committeeId) {
      return guarded(async () => unwrap(await P.client().rpc('verify_ledger', { p_committee_id: committeeId })));
    },

    async listMembers(committeeId) {
      return guarded(async () => {
        const sb = P.client();
        const members = unwrap(await sb.from('committee_memberships')
          .select('id, user_id, roles, allowed_modules, status')
          .eq('committee_id', committeeId).order('created_at', { ascending: true })) || [];
        let profiles = [];
        if (members.length) {
          profiles = unwrap(await sb.from('profiles')
            .select('id, full_name, phone').in('id', members.map(m => m.user_id))) || [];
        }
        const byId = Object.fromEntries(profiles.map(p => [p.id, p]));
        return members.map(m => ({ ...m, profile: byId[m.user_id] || null }));
      });
    },

    async addMember(committeeId, tenDigits, roles, allowedModules) {
      return guarded(async () => unwrap(await P.client().rpc('add_member_by_phone', {
        p_committee_id: committeeId,
        p_phone: P.toE164(tenDigits),
        p_roles: roles,
        p_allowed_modules: allowedModules && allowedModules.length ? allowedModules : null
      })));
    },

    async removeMember(membershipId) {
      return guarded(async () => {
        const rows = unwrap(await P.client().from('committee_memberships')
          .delete().eq('id', membershipId).select('id'));
        if (!rows || !rows.length) throw new Error('You do not have permission to remove this member.');
      });
    }
  };

  /** Runs an async action while a button shows a loading state; always re-enables it. */
  P.withLoading = async function (button, label, action) {
    const original = button ? button.innerHTML : '';
    if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); button.textContent = label || 'Please wait…'; }
    try { return await action(); }
    finally {
      if (button && button.isConnected) { button.disabled = false; button.removeAttribute('aria-busy'); button.innerHTML = original; }
    }
  };
})();
