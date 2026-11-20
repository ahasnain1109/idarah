/**
 * Idarah platform - onboarding wizard (new committee) and "+ Onboard Another Module".
 * platform-onboarding.js
 *
 * Step 1 : committee details (new mode only) + 5 module cards (tick 1 or more)
 * Step 2…: one dedicated form per ticked module, in canonical order
 * Submit : ONE database call (create_committee_with_modules / add_modules) so a
 *          committee is never left half-created.
 */
(function () {
  'use strict';

  const P = (window.IdarahPlatform = window.IdarahPlatform || {});
  const esc = window.escapeHtml;

  // ---- shared field rendering (also used by the module settings editor) ------

  P.renderFields = function (type, values, errors, prefix) {
    return P.renderFieldList(P.MODULE_DEFS[type].fields, values, errors, prefix);
  };

  /** Renders any list of field specs (see P.validateFields for the types). */
  P.renderFieldList = function (fields, values, errors, prefix) {
    return fields.filter(f => P.fieldVisible(f, values)).map(f => {
      const id = prefix + '-' + f.key;
      const err = errors && errors[f.key];
      const val = values[f.key];
      const star = f.required ? ' <span aria-hidden="true">*</span>' : '';
      let control = '';

      if (f.type === 'select') {
        control = '<select id="' + id + '" class="form-control" data-key="' + f.key + '"' + (f.required ? ' required' : '') + '>' +
          '<option value="">Select…</option>' +
          f.options.map(o => '<option value="' + esc(o[0]) + '"' + (val === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>').join('') +
          '</select>';
      } else if (f.type === 'yesno') {
        const yes = val === true || val === 'yes';
        const no = val === false || val === 'no';
        control = '<div class="pf-yesno" role="radiogroup" aria-labelledby="' + id + '-label">' +
          '<label><input type="radio" name="' + id + '" value="yes" data-key="' + f.key + '"' + (yes ? ' checked' : '') + ' /> Yes</label>' +
          '<label><input type="radio" name="' + id + '" value="no" data-key="' + f.key + '"' + (no ? ' checked' : '') + ' /> No</label>' +
          '</div>';
      } else if (f.type === 'textarea') {
        control = '<textarea id="' + id + '" class="form-control" data-key="' + f.key + '"' +
          (f.maxLength ? ' maxlength="' + f.maxLength + '"' : '') + (f.placeholder ? ' placeholder="' + esc(f.placeholder) + '"' : '') +
          (f.required ? ' required' : '') + '>' + esc(val === undefined || val === null ? '' : val) + '</textarea>';
      } else {
        const t = f.type === 'number' ? 'number' : f.type === 'time' ? 'time' : f.type === 'date' ? 'date' : f.type === 'phone' ? 'tel' : 'text';
        control = '<input id="' + id + '" class="form-control" data-key="' + f.key + '" type="' + t + '"' +
          (f.type === 'phone' ? ' inputmode="numeric" maxlength="10"' : '') +
          (f.type === 'number' ? ' inputmode="numeric"' + (f.min !== undefined ? ' min="' + f.min + '"' : '') + (f.max !== undefined ? ' max="' + f.max + '"' : '') : '') +
          (f.maxLength ? ' maxlength="' + f.maxLength + '"' : '') +
          (f.placeholder ? ' placeholder="' + esc(f.placeholder) + '"' : '') +
          (f.transform === 'upper' ? ' style="text-transform:uppercase"' : '') +
          ' value="' + esc(val === undefined || val === null ? '' : val) + '"' + (f.required ? ' required' : '') + ' />';
      }

      return '<div class="form-group' + (err ? ' pf-has-error' : '') + '">' +
        '<label class="form-label" id="' + id + '-label" for="' + id + '">' + esc(f.label) + star + '</label>' +
        control +
        (err ? '<div class="pf-field-error" role="alert">' + esc(err) + '</div>' : '') +
        '</div>';
    }).join('');
  };

  P.readFields = function (type, root) {
    return P.readFieldList(P.MODULE_DEFS[type].fields, root);
  };

  P.readFieldList = function (fields, root) {
    const values = {};
    fields.forEach(f => {
      if (f.type === 'yesno') {
        const checked = root.querySelector('input[type="radio"][data-key="' + f.key + '"]:checked');
        if (checked) values[f.key] = checked.value;
      } else {
        const el = root.querySelector('[data-key="' + f.key + '"]');
        if (el) values[f.key] = el.value;
      }
    });
    return values;
  };

  // ---- wizard ---------------------------------------------------------------

  /**
   * opts: { mode: 'new' | 'add', committee?: {id,name}, existingCounts?: {type: n},
   *         onDone(committeeId), onCancel?() }
   */
  P.renderWizard = function (container, opts) {
    const isNew = opts.mode === 'new';
    const S = { step: 0, name: '', city: '', stateName: '', selected: [], values: {}, busy: false, topError: '' };

    const ordered = () => P.MODULE_TYPES.filter(t => S.selected.includes(t));
    const totalSteps = () => 1 + S.selected.length;

    function stepHeader(current, label) {
      const total = S.selected.length ? String(totalSteps()) : '…';
      const pct = S.selected.length ? Math.round((current / totalSteps()) * 100) : 0;
      return '<div class="pf-stepper" aria-live="polite">' +
        '<div class="pf-step-label">Step ' + current + ' of ' + total + ': ' + esc(label) + '</div>' +
        '<div class="pf-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '"><span style="width:' + pct + '%"></span></div>' +
        '</div>';
    }

    function renderStep0() {
      const counts = opts.existingCounts || {};
      container.innerHTML =
        '<div class="card pf-wizard">' +
        '<div id="pf-wizard-head">' + stepHeader(1, isNew ? 'Committee & Modules' : 'Choose Modules to Add') + '</div>' +
        (isNew ? (
          '<p class="card-subtitle" style="margin-bottom:14px">Create your committee / trust. You can run several modules (mosque, madarsa…) under it.</p>' +
          '<div class="form-group"><label class="form-label" for="pf-c-name">Committee / Trust Name <span aria-hidden="true">*</span></label>' +
          '<input id="pf-c-name" class="form-control" maxlength="150" required placeholder="e.g. Anjuman-e-Islamia Committee" value="' + esc(S.name) + '" /></div>' +
          '<div class="pf-row"><div class="form-group"><label class="form-label" for="pf-c-city">City <span aria-hidden="true">*</span></label>' +
          '<input id="pf-c-city" class="form-control" maxlength="80" required value="' + esc(S.city) + '" /></div>' +
          '<div class="form-group"><label class="form-label" for="pf-c-state">State <span aria-hidden="true">*</span></label>' +
          '<select id="pf-c-state" class="form-control" required><option value="">Select state…</option>' +
          P.INDIAN_STATES.map(s => '<option' + (S.stateName === s ? ' selected' : '') + '>' + esc(s) + '</option>').join('') +
          '</select></div></div>'
        ) : '<p class="card-subtitle" style="margin-bottom:14px">Adding to <strong>' + esc(opts.committee.name) + '</strong>. New modules connect to this committee automatically.</p>') +
        '<fieldset class="pf-fieldset"><legend class="form-label">Select modules to onboard (at least one)</legend>' +
        '<div class="pf-cards">' +
        P.MODULE_TYPES.map(t => {
          const d = P.MODULE_DEFS[t];
          const have = counts[t] || 0;
          return '<label class="pf-module-card' + (S.selected.includes(t) ? ' selected' : '') + '">' +
            '<input type="checkbox" value="' + t + '"' + (S.selected.includes(t) ? ' checked' : '') + ' />' +
            '<span class="pf-card-icon" aria-hidden="true">' + d.icon + '</span>' +
            '<span class="pf-card-text"><strong>' + esc(d.label) + '</strong><small>' + esc(d.blurb) + '</small>' +
            (have ? '<small class="pf-have">Already onboarded: ' + have + ' — you can add another</small>' : '') + '</span>' +
            '</label>';
        }).join('') +
        '</div></fieldset>' +
        '<div id="pf-wizard-error" class="pf-form-error" role="alert">' + esc(S.topError) + '</div>' +
        '<div class="pf-actions">' +
        (opts.onCancel ? '<button type="button" class="btn btn-outline" id="pf-cancel">Cancel</button>' : '<span></span>') +
        '<button type="button" class="btn btn-primary" id="pf-next">Next →</button></div>' +
        '</div>';

      container.querySelectorAll('.pf-module-card input').forEach(cb => {
        cb.addEventListener('change', () => {
          const t = cb.value;
          S.selected = cb.checked ? S.selected.concat(t) : S.selected.filter(x => x !== t);
          cb.closest('.pf-module-card').classList.toggle('selected', cb.checked);
          container.querySelector('#pf-wizard-head').innerHTML = stepHeader(1, isNew ? 'Committee & Modules' : 'Choose Modules to Add');
        });
      });
      const cancel = container.querySelector('#pf-cancel');
      if (cancel) cancel.addEventListener('click', opts.onCancel);
      container.querySelector('#pf-next').addEventListener('click', nextFromStep0);
    }

    function nextFromStep0() {
      if (isNew) {
        S.name = container.querySelector('#pf-c-name').value.trim();
        S.city = container.querySelector('#pf-c-city').value.trim();
        S.stateName = container.querySelector('#pf-c-state').value;
        if (S.name.length < 2) return fail('Enter the committee / trust name.', '#pf-c-name');
        if (!S.city) return fail('Enter the city.', '#pf-c-city');
        if (!S.stateName) return fail('Select the state.', '#pf-c-state');
      }
      if (!S.selected.length) return fail('Tick at least one module to continue.');
      S.topError = '';
      S.step = 1;
      render();
    }

    function fail(msg, focusSel) {
      S.topError = msg;
      const box = container.querySelector('#pf-wizard-error');
      if (box) box.textContent = msg;
      if (focusSel) { const el = container.querySelector(focusSel); if (el) el.focus(); }
    }

    function renderModuleStep() {
      const type = ordered()[S.step - 1];
      const def = P.MODULE_DEFS[type];
      const values = S.values[type] || (S.values[type] = {});
      const errors = S.errors || {};
      const isLast = S.step === S.selected.length;

      container.innerHTML =
        '<div class="card pf-wizard">' +
        stepHeader(S.step + 1, def.label + ' Details') +
        '<p class="card-subtitle" style="margin-bottom:14px">' + def.icon + ' Just the essentials. You can add deeper settings later from the dashboard.</p>' +
        '<form id="pf-module-form" novalidate>' + P.renderFields(type, values, errors, 'pf-' + type) + '</form>' +
        '<div id="pf-wizard-error" class="pf-form-error" role="alert">' + esc(S.topError) + '</div>' +
        '<div class="pf-actions">' +
        '<button type="button" class="btn btn-outline" id="pf-back">← Back</button>' +
        '<button type="button" class="btn btn-primary" id="pf-next">' + (isLast ? (isNew ? '✅ Create Committee' : '✅ Add Modules') : 'Next →') + '</button></div>' +
        '</div>';

      const form = container.querySelector('#pf-module-form');
      form.addEventListener('submit', e => e.preventDefault());
      // keep typed values; re-render when a conditional field's controlling value changes
      form.addEventListener('change', () => {
        const before = JSON.stringify(P.MODULE_DEFS[type].fields.map(f => P.fieldVisible(f, values)));
        Object.assign(values, P.readFields(type, form));
        const after = JSON.stringify(P.MODULE_DEFS[type].fields.map(f => P.fieldVisible(f, values)));
        if (before !== after) { S.errors = {}; render(); }
      });
      container.querySelector('#pf-back').addEventListener('click', () => {
        Object.assign(values, P.readFields(type, form));
        S.errors = {}; S.topError = ''; S.step -= 1; render();
      });
      container.querySelector('#pf-next').addEventListener('click', async (e) => {
        Object.assign(values, P.readFields(type, form));
        const res = P.validateModuleForm(type, values);
        if (!res.ok) {
          S.errors = res.errors; S.topError = 'Please fix the highlighted fields.'; render();
          const first = container.querySelector('.pf-has-error .form-control, .pf-has-error input');
          if (first) first.focus();
          return;
        }
        S.errors = {}; S.topError = '';
        if (!isLast) { S.step += 1; render(); return; }
        await submit(e.currentTarget);
      });
    }

    async function submit(btn) {
      if (S.busy) return;
      const modules = [];
      for (const type of ordered()) {
        const res = P.validateModuleForm(type, S.values[type] || {});
        if (!res.ok) { S.topError = 'A module form is incomplete: ' + P.MODULE_DEFS[type].label; render(); return; }
        modules.push({ module_type: type, module_name: res.clean.module_name, details: res.clean.details });
      }
      S.busy = true;
      try {
        const committeeId = await P.withLoading(btn, 'Saving…', () => isNew
          ? P.api.createCommittee({ name: S.name, city: S.city, state: S.stateName, modules })
          : P.api.addModules(opts.committee.id, modules).then(() => opts.committee.id));
        P.toast(isNew ? 'Committee created.' : 'Modules added.', 'success');
        opts.onDone(committeeId);
      } catch (err) {
        S.topError = err.message;
        const box = container.querySelector('#pf-wizard-error');
        if (box) box.textContent = err.message;
        P.toast(err.message, 'error');
      } finally { S.busy = false; }
    }

    function render() {
      if (S.step === 0) renderStep0(); else renderModuleStep();
      window.scrollTo(0, 0);
    }

    render();
  };
})();
