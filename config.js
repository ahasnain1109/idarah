/**
 * Idarah - Mosque & Madrasa Management System
 * config.js
 * 
 * Plain-English Purpose:
 * This file contains ALL configuration settings, default lists, business rules,
 * India time zone helpers, and validation patterns for the entire application.
 * Centralizing everything here prevents hardcoded constants across the app.
 */

// Global configuration object accessible everywhere via window.IDARAH_CONFIG
window.IDARAH_CONFIG = {
  // Application details
  APP_NAME: 'Idarah',
  APP_VERSION: '1.0.0',
  APP_TAGLINE: 'Transparent Mosque & Madrasa Management for India',

  // Currency & Financial Rules
  CURRENCY: {
    symbol: '₹',
    code: 'INR',
    name: 'Indian Rupee'
  },

  // Mandatory India Timezone for all dates, timestamps, fee cycles and reports
  TIMEZONE: 'Asia/Kolkata',

  // Supported Languages
  LANGUAGES: [
    { code: 'en', name: 'English', dir: 'ltr' },
    { code: 'ur', name: 'اردو (Urdu)', dir: 'rtl' },
    { code: 'hi', name: 'हिन्दी (Hindi)', dir: 'ltr' },
    { code: 'bn', name: 'বাংলা (Bengali)', dir: 'ltr' }
  ],
  DEFAULT_LANGUAGE: 'en',

  // Default Financial Funds
  // 'isZakatEligible: true' strictly restricts expense categories to Shariah-compliant Zakat recipients
  DEFAULT_FUNDS: [
    {
      id: 'fund_general',
      nameKey: 'fund_general',
      defaultName: 'General Fund',
      isZakatEligible: false,
      isSystem: true,
      description: 'Mosque maintenance, utilities, staff salaries, and general operational expenses'
    },
    {
      id: 'fund_zakat',
      nameKey: 'fund_zakat',
      defaultName: 'Zakat Fund',
      isZakatEligible: true,
      isSystem: true,
      description: 'Obligatory Zakat exclusively for eligible poor, needy, and destitute individuals'
    },
    {
      id: 'fund_sadaqah',
      nameKey: 'fund_sadaqah',
      defaultName: 'Sadaqah Fund',
      isZakatEligible: false,
      isSystem: true,
      description: 'Voluntary charity for community welfare, general assistance, and relief'
    },
    {
      id: 'fund_fitra',
      nameKey: 'fund_fitra',
      defaultName: 'Fitra (Sadaqatul Fitr)',
      isZakatEligible: true,
      isSystem: true,
      description: 'Eid Fitra collections reserved strictly for eligible poor and needy families'
    },
    {
      id: 'fund_madrasa',
      nameKey: 'fund_madrasa',
      defaultName: 'Madrasa Fees & Education',
      isZakatEligible: false,
      isSystem: true,
      description: 'Madrasa student monthly fees, teacher allowances, books, and educational supplies'
    }
  ],

  // Expense Categories for Zakat-Eligible Funds
  // Under Islamic jurisprudence, Zakat & Fitra can only be disbursed to specific eligible categories
  ZAKAT_EXPENSE_CATEGORIES: [
    { id: 'zk_poor_needy', nameKey: 'zk_poor_needy', defaultName: 'Poor & Needy Relief (Fuqara & Masakeen)' },
    { id: 'zk_destitute_ration', nameKey: 'zk_destitute_ration', defaultName: 'Direct Ration & Food Aid to Needy' },
    { id: 'zk_medical_aid', nameKey: 'zk_medical_aid', defaultName: 'Emergency Medical Assistance for Poor' },
    { id: 'zk_widow_orphan', nameKey: 'zk_widow_orphan', defaultName: 'Widow & Orphan Support Stipend' },
    { id: 'zk_madrasa_poor_student', nameKey: 'zk_madrasa_poor_student', defaultName: 'Deserving Madrasa Student Stipend' },
    { id: 'zk_debt_relief', nameKey: 'zk_debt_relief', defaultName: 'Debt Relief for Insolvent Debtor (Gharimeen)' },
    { id: 'zk_stranded_traveler', nameKey: 'zk_stranded_traveler', defaultName: 'Stranded Traveler Assistance (Ibnus-Sabeel)' }
  ],

  // General Expense Categories for Regular Funds (General, Sadaqah, Madrasa)
  GENERAL_EXPENSE_CATEGORIES: [
    { id: 'exp_electric_water', nameKey: 'exp_electric_water', defaultName: 'Electricity & Water Utilities' },
    { id: 'exp_staff_salary', nameKey: 'exp_staff_salary', defaultName: 'Imam, Muazzin & Staff Salary' },
    { id: 'exp_repairs_maintenance', nameKey: 'exp_repairs_maintenance', defaultName: 'Building Repairs & Maintenance' },
    { id: 'exp_cleaning_sanitation', nameKey: 'exp_cleaning_sanitation', defaultName: 'Cleaning Supplies & Sanitation' },
    { id: 'exp_sound_audio', nameKey: 'exp_sound_audio', defaultName: 'Sound System & Mic Equipment' },
    { id: 'exp_ramadan_iftar', nameKey: 'exp_ramadan_iftar', defaultName: 'Ramadan Iftar & Community Programs' },
    { id: 'exp_madrasa_books', nameKey: 'exp_madrasa_books', defaultName: 'Madrasa Books & Stationery' },
    { id: 'exp_admin_office', nameKey: 'exp_admin_office', defaultName: 'Office, Printing & Register Books' },
    { id: 'exp_miscellaneous', nameKey: 'exp_miscellaneous', defaultName: 'Miscellaneous Emergency Expense' }
  ],

  // Payment Methods (Zero online gateways - all recorded transactions represent offline receipts)
  PAYMENT_METHODS: [
    { id: 'cash', nameKey: 'method_cash', defaultName: 'Cash' },
    { id: 'upi', nameKey: 'method_upi', defaultName: 'Direct UPI (QR / PhonePe / GPay)' },
    { id: 'bank', nameKey: 'method_bank', defaultName: 'Direct Bank Transfer (NEFT/IMPS)' },
    { id: 'cheque', nameKey: 'method_cheque', defaultName: 'Cheque' }
  ],

  // User Roles with Defined Permissions
  ROLES: {
    ADMIN: { id: 'admin', nameKey: 'role_admin', defaultName: 'Mutawalli / President (Admin)' },
    TREASURER: { id: 'treasurer', nameKey: 'role_treasurer', defaultName: 'Treasurer / Secretary' },
    TEACHER: { id: 'teacher', nameKey: 'role_teacher', defaultName: 'Ustad / Teacher' },
    VIEWER: { id: 'viewer', nameKey: 'role_viewer', defaultName: 'Committee Member / Viewer' }
  },

  // Daily Salah & Jumu'ah Prayers
  SALAH_PRAYERS: [
    { id: 'fajr', nameKey: 'salah_fajr', defaultName: 'Fajr' },
    { id: 'dhuhr', nameKey: 'salah_dhuhr', defaultName: 'Dhuhr' },
    { id: 'asr', nameKey: 'salah_asr', defaultName: 'Asr' },
    { id: 'maghrib', nameKey: 'salah_maghrib', defaultName: 'Maghrib' },
    { id: 'isha', nameKey: 'salah_isha', defaultName: 'Isha' },
    { id: 'jumuah', nameKey: 'salah_jumuah', defaultName: "Jumu'ah" }
  ],

  // Validation Rules
  VALIDATION: {
    PHONE_REGEX: /^[6-9]\d{9}$/, // Standard 10-digit Indian Mobile Number
    MIN_PIN_LENGTH: 6,           // Minimum 6 characters for PIN or password
    VERIFY_CODE_LENGTH: 8        // 8-character verification code for receipts
  },

  // Default Mosque Public Privacy Settings
  DEFAULT_PUBLIC_SETTINGS: {
    showSalaryInPublic: false,     // Keep specific staff salary breakdown private by default
    showBillPhotosInPublic: false  // Keep receipt photo bills internal by default
  },

  // LocalStorage Keys Prefix
  STORAGE_KEYS: {
    LANG: 'idarah_lang',
    CURRENT_SESSION: 'idarah_session',
    MOSQUES_LIST: 'idarah_mosques_catalog',
    MOSQUE_DATA_PREFIX: 'idarah_mosque_data_'
  }
};

/**
 * Returns the current date and time formatted in India Standard Time (Asia/Kolkata).
 * This ensures all devices across the world record consistent IST timestamps.
 */
function getISTDate(dateObj = new Date()) {
  const options = {
    timeZone: window.IDARAH_CONFIG.TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  };
  const formatter = new Intl.DateTimeFormat('en-CA', options); // returns YYYY-MM-DD
  return formatter.format(dateObj);
}

/**
 * Returns the current timestamp in India Standard Time (Asia/Kolkata) with hours, minutes, and seconds.
 */
function getISTTimestamp(dateObj = new Date()) {
  const options = {
    timeZone: window.IDARAH_CONFIG.TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  };
  const parts = new Intl.DateTimeFormat('en-GB', options).formatToParts(dateObj);
  const map = {};
  parts.forEach(p => map[p.type] = p.value);
  return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second} IST`;
}

/**
 * Returns the current year and month in IST format: 'YYYY-MM' (useful for monthly reports & fee cycles)
 */
function getISTMonth(dateObj = new Date()) {
  const istDate = getISTDate(dateObj);
  return istDate.substring(0, 7); // returns YYYY-MM
}

/**
 * Formats a number as an Indian Currency string (e.g., 25000 -> ₹25,000)
 */
function formatCurrency(amount) {
  const num = Number(amount) || 0;
  return '₹' + num.toLocaleString('en-IN', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 0
  });
}

/**
 * Generates an 8-character random alphanumeric verification code
 */
function generateVerificationCode() {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // avoiding ambiguous characters like 0/O, 1/I
  const len = window.IDARAH_CONFIG.VALIDATION.VERIFY_CODE_LENGTH;
  const rnd = new Uint32Array(len);
  window.crypto.getRandomValues(rnd); // cryptographically secure, unlike Math.random()
  let code = '';
  for (let i = 0; i < len; i++) {
    code += chars.charAt(rnd[i] % chars.length);
  }
  return code;
}

/**
 * Safely escapes HTML special characters to prevent Cross-Site Scripting (XSS).
 * Never inject raw user input directly into innerHTML.
 */
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
