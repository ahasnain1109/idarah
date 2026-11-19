/**
 * Idarah platform - module definitions (data only).
 * platform-modules.js
 *
 * Every module type, its onboarding form and its detail labels are described here.
 * The onboarding wizard, the "+ Onboard Another Module" flow and the module
 * settings editor all render from this single source, so a field added here
 * appears everywhere.
 *
 * Field types: text | select | time | number | yesno
 * `key: 'module_name'` is stored in organization_modules.module_name;
 * every other key is stored inside organization_modules.details (JSONB).
 */
(function () {
  'use strict';

  const P = (window.IdarahPlatform = window.IdarahPlatform || {});

  P.MODULE_TYPES = ['mosque', 'madarsa', 'dargah', 'imambargah', 'waqf_charity'];

  P.MODULE_DEFS = {
    mosque: {
      label: 'Mosque',
      icon: '🕌',
      blurb: 'Salah timings, Jumu\'ah, registers, notices',
      next: ['Salah & Jumu\'ah timings', 'Nikah and Janazah registers', 'Notices & announcements'],
      fields: [
        { key: 'module_name', label: 'Mosque Name', type: 'text', required: true, maxLength: 150, placeholder: 'e.g. Jamia Masjid' },
        { key: 'locality', label: 'Locality / Address', type: 'text', required: true, maxLength: 200, placeholder: 'Mohalla, area, city' },
        { key: 'calc_method', label: 'Prayer Calculation Method', type: 'select', required: true,
          options: [['hanafi', 'Hanafi'], ['shafii', "Shafi'i"]] },
        { key: 'jummah_khutbah_time', label: 'Jummah Khutbah Time', type: 'time', required: true },
        { key: 'jummah_jamaat_time', label: 'Jummah Jamaat Time', type: 'time', required: true },
        { key: 'capacity', label: 'Approximate Capacity', type: 'number', min: 1, max: 1000000, placeholder: 'e.g. 500' }
      ]
    },

    madarsa: {
      label: 'Madarsa',
      icon: '📖',
      blurb: 'Students, fees, attendance, Hifz progress',
      next: ['Students & classes', 'Monthly fees', 'Daily attendance & Hifz/Sabaq logs'],
      fields: [
        { key: 'module_name', label: 'Madarsa Name', type: 'text', required: true, maxLength: 150, placeholder: 'e.g. Madarsa Faiz-ul-Uloom' },
        { key: 'madarsa_type', label: 'Type', type: 'select', required: true,
          options: [['maktab_morning', 'Morning Maktab'], ['maktab_evening', 'Evening Maktab'], ['full_time', 'Full-Time Academy']] },
        { key: 'shift_timings', label: 'Shift Timings', type: 'text', required: true, maxLength: 100, placeholder: 'e.g. 7:00 AM - 9:00 AM' },
        { key: 'medium', label: 'Medium of Instruction', type: 'select', required: true,
          options: [['urdu', 'Urdu'], ['hindi', 'Hindi'], ['english', 'English'], ['bengali', 'Bengali'], ['arabic', 'Arabic']] },
        { key: 'fee_structure', label: 'Fee Structure', type: 'select', required: true,
          options: [['free', 'Free'], ['monthly_fee', 'Monthly Fee']] },
        { key: 'default_monthly_fee', label: 'Default Monthly Fee (₹)', type: 'number', min: 1, max: 1000000,
          showIf: { key: 'fee_structure', equals: 'monthly_fee' }, required: true, placeholder: 'e.g. 300' }
      ]
    },

    dargah: {
      label: 'Dargah',
      icon: '🌙',
      blurb: 'Urs, Langar, Zaireen services',
      next: ['Urs & event calendar', 'Langar & Niyaz tracking', 'Zaireen lodging'],
      fields: [
        { key: 'module_name', label: 'Dargah Name', type: 'text', required: true, maxLength: 150, placeholder: 'e.g. Dargah Hazrat ...' },
        { key: 'locality', label: 'Locality / Address', type: 'text', required: true, maxLength: 200 },
        { key: 'urs_calendar', label: 'Urs Date Calendar', type: 'select', required: true,
          options: [['hijri', 'Hijri'], ['gregorian', 'Gregorian']] },
        { key: 'urs_date', label: 'Annual Urs Date', type: 'text', required: true, maxLength: 60,
          placeholder: 'Hijri: 6 Rajab  |  Gregorian: 14 March' },
        { key: 'langar_active', label: 'Daily Langar Active', type: 'yesno', required: true },
        { key: 'lodging_available', label: 'Zaireen Lodging Available', type: 'yesno', required: true }
      ]
    },

    imambargah: {
      label: 'Imambargah',
      icon: '🏛️',
      blurb: 'Majlis schedule, Niyaz & Sabeel kitchen',
      next: ['Majlis schedule', 'Niyaz / Sabeel kitchen', 'Muharram & Safar programmes'],
      fields: [
        { key: 'module_name', label: 'Imambargah Name', type: 'text', required: true, maxLength: 150 },
        { key: 'locality', label: 'Locality / Address', type: 'text', required: true, maxLength: 200 },
        { key: 'majlis_schedule', label: 'Primary Majlis Schedule', type: 'select', required: true,
          options: [['weekly', 'Weekly'], ['muharram_safar', 'Muharram-Safar'], ['both', 'Both']] },
        { key: 'capacity', label: 'Seating Capacity', type: 'number', min: 1, max: 1000000, placeholder: 'e.g. 800' },
        { key: 'kitchen_active', label: 'Niyaz / Sabeel Kitchen Active', type: 'yesno', required: true }
      ]
    },

    waqf_charity: {
      label: 'Charitable Organization / Waqf',
      icon: '🤲',
      blurb: 'Zakat & Sadaqah, Waqf properties, beneficiaries',
      next: ['Zakat / Sadaqah funds', 'Waqf assets & rent', 'Beneficiaries'],
      fields: [
        { key: 'module_name', label: 'Trust / Waqf Name', type: 'text', required: true, maxLength: 150 },
        { key: 'registration_no', label: 'State Waqf Board / Trust Registration No.', type: 'text', required: true, maxLength: 80 },
        { key: 'primary_focus', label: 'Primary Focus', type: 'select', required: true,
          options: [['zakat_sadaqah', 'Zakat & Sadaqah'], ['medical_education', 'Medical & Education Aid'], ['waqf_property', 'Waqf Property Management']] },
        { key: 'zakat_tracking', label: 'Zakat Eligibility Tracking Enabled', type: 'yesno', required: true },
        { key: 'receipt_prefix', label: 'Receipt Number Prefix', type: 'text', required: true, maxLength: 6,
          pattern: '^[A-Z0-9]{2,6}$', patternHint: '2 to 6 capital letters or digits, e.g. WQF', transform: 'upper', placeholder: 'e.g. WQF' }
      ]
    }
  };

  P.ROLES = [
    ['admin', 'Admin'],
    ['mutawalli_trustee', 'Mutawalli / Trustee'],
    ['imam_zakir', 'Imam / Zakir'],
    ['teacher', 'Teacher'],
    ['accountant', 'Accountant'],
    ['volunteer', 'Volunteer'],
    ['parent', 'Parent']
  ];

  P.ROLE_HELP = {
    admin: 'Full access to every module',
    mutawalli_trustee: 'Full access to every module',
    imam_zakir: 'Prayer / Majlis / Urs schedules, notices, Nikah & gathering logs',
    teacher: 'Classes, daily attendance, Hifz / Sabaq logs',
    accountant: 'Fees, donations, Zakat / Sadaqah funds, Waqf assets & expenses',
    volunteer: 'Event, Langar, Niyaz and Zaireen operations',
    parent: 'Read-only: their own linked children'
  };

  P.INDIAN_STATES = [
    'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana',
    'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur',
    'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana',
    'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
    'Andaman and Nicobar Islands', 'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi',
    'Jammu and Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry'
  ];

  /** Human readable value for a stored detail (used on module pages). */
  P.formatFieldValue = function (field, value) {
    if (value === undefined || value === null || value === '') return '—';
    if (field.type === 'yesno') return value === true || value === 'yes' ? 'Yes' : 'No';
    if (field.type === 'select') {
      const hit = (field.options || []).find(o => o[0] === value);
      return hit ? hit[1] : String(value);
    }
    return String(value);
  };

  /** Is a conditional field currently visible, given the form values? */
  P.fieldVisible = function (field, values) {
    if (!field.showIf) return true;
    return values[field.showIf.key] === field.showIf.equals;
  };

  /**
   * Validates one module form. Returns { ok, errors: {key: message}, clean: {module_name, details} }.
   */
  P.validateModuleForm = function (type, values) {
    const def = P.MODULE_DEFS[type];
    const errors = {};
    const clean = { module_name: '', details: {} };

    def.fields.forEach(f => {
      if (!P.fieldVisible(f, values)) return;
      let v = values[f.key];
      if (typeof v === 'string') v = v.trim();
      if (f.transform === 'upper' && typeof v === 'string') v = v.toUpperCase();

      const empty = v === undefined || v === null || v === '';
      if (empty) {
        if (f.required) errors[f.key] = 'This field is required';
        return;
      }
      if (f.type === 'text') {
        if (f.key === 'module_name' && v.length < 2) { errors[f.key] = 'Enter at least 2 characters'; return; }
        if (f.maxLength && v.length > f.maxLength) { errors[f.key] = 'Too long (max ' + f.maxLength + ')'; return; }
        if (f.pattern && !new RegExp(f.pattern).test(v)) { errors[f.key] = f.patternHint || 'Invalid format'; return; }
      }
      if (f.type === 'number') {
        const n = Number(v);
        if (!Number.isFinite(n) || (f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) {
          errors[f.key] = 'Enter a number between ' + (f.min ?? 0) + ' and ' + (f.max ?? 'any'); return;
        }
        v = n;
      }
      if (f.type === 'select' && !(f.options || []).some(o => o[0] === v)) { errors[f.key] = 'Choose an option'; return; }
      if (f.type === 'yesno') {
        if (v !== 'yes' && v !== 'no' && typeof v !== 'boolean') { errors[f.key] = 'Choose Yes or No'; return; }
        v = v === true || v === 'yes';
      }
      if (f.type === 'time' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) { errors[f.key] = 'Enter a valid time'; return; }

      if (f.key === 'module_name') clean.module_name = v;
      else clean.details[f.key] = v;
    });

    return { ok: Object.keys(errors).length === 0, errors, clean };
  };
})();
