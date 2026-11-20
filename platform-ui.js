/**
 * Idarah platform - shared UI helpers: accessible modal + generic register screen.
 * platform-ui.js
 *
 * P.openModal(title, html)            -> { el, close }
 * P.renderCrud(host, cfg)             -> list / add / edit / delete screen for a simple table
 * Security is NOT decided here: every call goes through RLS in the database. `canWrite`
 * only hides buttons people could not use anyway.
 */
(function () {
  'use strict';

  const P = window.IdarahPlatform;
  const esc = window.escapeHtml;

  P.openModal = function (title, bodyHtml) {
    const previous = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay active';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', title);
    overlay.innerHTML = '<div class="modal-dialog"><div class="modal-header"><h3 class="modal-title">' + esc(title) +
      '</h3><button type="button" class="modal-close-btn pf-no-print" aria-label="Close">✕</button></div><div class="modal-body">' + bodyHtml + '</div></div>';
    document.body.appendChild(overlay);

    function close() {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      if (previous && previous.focus && previous.isConnected) previous.focus();
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    overlay.querySelector('.modal-close-btn').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    const first = overlay.querySelector('input, select, textarea, button.btn');
    if (first) first.focus();
    return { el: overlay, close };
  };

  // ---- module sections: each module type lists the screens it offers ----
  //   P.registerSections('madarsa', [{ key, label, icon, render(host, mod, ctx) }])
  //   ctx = { committee, roles, has(...allowedRoles) }  (admin / trustee always pass has())
  P.SECTIONS = P.SECTIONS || {};
  P.registerSections = function (type, list) { P.SECTIONS[type] = (P.SECTIONS[type] || []).concat(list); };
  P.hasRole = function (roles, allowed) {
    return (roles || []).some(r => r === 'admin' || r === 'mutawalli_trustee' || (allowed || []).includes(r));
  };

  /** Small spinner block used while a screen loads. */
  P.loadingHtml = function (msg) {
    return '<div class="card pf-center" aria-busy="true"><div class="pf-spinner"></div><p>' + esc(msg || 'Loading…') + '</p></div>';
  };

  P.errorHtml = function (msg, retryId) {
    return '<div class="card"><p class="pf-form-error">' + esc(msg) + '</p>' +
      (retryId ? '<button class="btn btn-primary" id="' + retryId + '">Try again</button>' : '') + '</div>';
  };

  /**
   * cfg: {
   *   title, table, committeeId, moduleId, canWrite,
   *   order, ascending, limit,
   *   columns: [{ label, html: row => '<safe html>' }],
   *   fields: [field specs],            // see P.validateFields
   *   toRow(clean, existing) -> object stored in the table   (default: clean)
   *   toValues(row) -> values shown in the edit form          (default: row)
   *   addLabel, emptyText, deleteText, intro,
   *   extraActions: [{ label, className, show(row), onClick(row, refresh) }]
   * }
   */
  P.renderCrud = async function (host, cfg) {
    host.innerHTML = P.loadingHtml('Loading…');
    let rows;
    try {
      rows = await P.api.listRows(cfg.table, {
        moduleId: cfg.moduleId, order: cfg.order, ascending: cfg.ascending, limit: cfg.limit || 500
      });
    } catch (err) {
      host.innerHTML = P.errorHtml(err.message, 'pf-crud-retry');
      host.querySelector('#pf-crud-retry').addEventListener('click', () => P.renderCrud(host, cfg));
      return;
    }
    // a screen showing data derived from this table (e.g. dues banner) passes onChange to redraw everything
    const refresh = cfg.onChange || (() => P.renderCrud(host, cfg));
    const extra = cfg.extraActions || [];

    host.innerHTML =
      '<div class="card"><div class="card-header"><div><h3 class="card-title">' + esc(cfg.title) + '</h3>' +
      (cfg.intro ? '<p class="card-subtitle">' + esc(cfg.intro) + '</p>' : '') + '</div>' +
      (cfg.canWrite ? '<button class="btn btn-primary btn-sm" id="pf-crud-add">➕ ' + esc(cfg.addLabel || 'Add') + '</button>' : '') + '</div>' +
      (rows.length === 0 ? '<p class="card-subtitle">' + esc(cfg.emptyText || 'Nothing recorded yet.') + '</p>' :
        '<div class="table-responsive"><table class="data-table" style="min-width:520px"><thead><tr>' +
        cfg.columns.map(c => '<th>' + esc(c.label) + '</th>').join('') + '<th></th></tr></thead><tbody>' +
        rows.map(r => '<tr>' + cfg.columns.map(c => '<td>' + c.html(r) + '</td>').join('') +
          '<td style="white-space:nowrap">' +
          extra.filter(a => !a.show || a.show(r)).map((a, i) => '<button class="btn ' + (a.className || 'btn-primary') + ' btn-sm pf-xa" data-row="' + esc(r.id) + '" data-act="' + cfg.extraActions.indexOf(a) + '">' + esc(a.label) + '</button> ').join('') +
          (cfg.canWrite ? '<button class="btn btn-outline btn-sm pf-edit" data-id="' + esc(r.id) + '">✏️ Edit</button> ' +
            '<button class="btn btn-danger btn-sm pf-del" data-id="' + esc(r.id) + '" aria-label="Delete">🗑️</button>' : '') +
          '</td></tr>').join('') + '</tbody></table></div>') + '</div>';

    function form(existing) {
      const values = existing ? (cfg.toValues ? cfg.toValues(existing) : existing) : (cfg.defaults ? cfg.defaults() : {});
      const m = P.openModal(existing ? 'Edit' : (cfg.addLabel || 'Add'),
        '<form id="pf-crud-form" novalidate>' + P.renderFieldList(cfg.fields, values, {}, 'pf-crud') +
        '<div id="pf-crud-err" class="pf-form-error" role="alert"></div>' +
        '<button type="submit" class="btn btn-primary btn-block" id="pf-crud-save">💾 Save</button></form>');
      const f = m.el.querySelector('#pf-crud-form');
      const cur = Object.assign({}, values);
      const redraw = (errors) => { f.innerHTML = P.renderFieldList(cfg.fields, cur, errors || {}, 'pf-crud') +
        '<div id="pf-crud-err" class="pf-form-error" role="alert">' + (errors ? 'Please fix the highlighted fields.' : '') + '</div>' +
        '<button type="submit" class="btn btn-primary btn-block" id="pf-crud-save">💾 Save</button>'; };
      f.addEventListener('change', () => {
        const before = JSON.stringify(cfg.fields.map(x => P.fieldVisible(x, cur)));
        Object.assign(cur, P.readFieldList(cfg.fields, f));
        if (before !== JSON.stringify(cfg.fields.map(x => P.fieldVisible(x, cur)))) redraw();
      });
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        Object.assign(cur, P.readFieldList(cfg.fields, f));
        const res = P.validateFields(cfg.fields, cur);
        if (!res.ok) { redraw(res.errors); return; }
        const body = cfg.toRow ? cfg.toRow(res.clean, existing) : res.clean;
        try {
          await P.withLoading(m.el.querySelector('#pf-crud-save'), 'Saving…', () => existing
            ? P.api.updateRow(cfg.table, existing.id, body)
            : P.api.insertRow(cfg.table, Object.assign({ committee_id: cfg.committeeId, module_id: cfg.moduleId }, body)));
          m.close(); P.toast('Saved.', 'success'); refresh();
        } catch (err) { m.el.querySelector('#pf-crud-err').textContent = err.message; P.toast(err.message, 'error'); }
      });
    }

    const add = host.querySelector('#pf-crud-add');
    if (add) add.addEventListener('click', () => form(null));
    host.querySelectorAll('.pf-edit').forEach(b => b.addEventListener('click', () => form(rows.find(r => r.id === b.dataset.id))));
    host.querySelectorAll('.pf-del').forEach(b => b.addEventListener('click', async () => {
      if (!window.confirm(cfg.deleteText || 'Delete this record?')) return;
      try { await P.withLoading(b, '…', () => P.api.deleteRow(cfg.table, b.dataset.id)); P.toast('Deleted.', 'success'); refresh(); }
      catch (err) { P.toast(err.message, 'error'); }
    }));
    host.querySelectorAll('.pf-xa').forEach(b => b.addEventListener('click', () => {
      const a = cfg.extraActions[Number(b.dataset.act)];
      const row = rows.find(r => r.id === b.dataset.row);
      if (a && row) a.onClick(row, refresh);
    }));
  };
})();
