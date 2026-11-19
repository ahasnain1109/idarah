/**
 * Idarah - Mosque & Madrasa Management System
 * app.js
 * 
 * Plain-English Purpose:
 * Core application logic orchestrating:
 * 1. Multi-language internationalization (English, Urdu RTL, Hindi, Bengali)
 * 2. Multi-mosque isolation & role-based authentication (Admin, Treasurer, Teacher, Viewer)
 * 3. Triple-Entry SHA-256 cryptographic ledger with 17-field hashing and reversal engine
 * 4. Madrasa student enrollment, double-payment-proof monthly fees & Quran attendance tracker
 * 5. Mosque operations: Salah timings, staff salaries, Nikah/Janazah registers, assets, notices
 * 6. Public Ledger Explorer with receipt authenticity verification and privacy safeguards
 * 7. India Standard Time (Asia/Kolkata) enforcement & offline-safe localStorage with rollback
 */

(function () {
  'use strict';

  // ==========================================================================
  // Global State
  // ==========================================================================
  const State = {
    currentLang: 'en',
    currentMosqueId: null,
    currentUser: null,       // { id, name, phone, role, mosqueId }
    activeTab: 'dashboard',  // dashboard, finance, madrasa, ops, reports, settings, public
    activeMadrasaSubTab: 'students',   // students, attendance
    activeOpsSubTab: 'staff',          // staff, nikahJanazah, assets, notices
    isPublicView: false,
    publicSelectedMosqueId: null
  };

  // Shortcut references from window.IDARAH_CONFIG & window.IDARAH_HASH
  const CFG = window.IDARAH_CONFIG;
  const HASH = window.IDARAH_HASH;

  // ==========================================================================
  // Translation & i18n Helpers
  // ==========================================================================

  /**
   * Translates a string key into the currently selected language.
   * If parameters are provided (e.g. { amount: '₹500' }), replaces placeholders.
   */
  function t(key, params = {}) {
    const dict = window.IDARAH_TRANSLATIONS[State.currentLang] || window.IDARAH_TRANSLATIONS.en || {};
    let text = dict[key] || (window.IDARAH_TRANSLATIONS.en && window.IDARAH_TRANSLATIONS.en[key]) || key;
    
    // Replace {placeholder} tokens
    for (const p in params) {
      const regex = new RegExp('\\{' + p + '\\}', 'g');
      text = text.replace(regex, params[p]);
    }
    return text;
  }

  /**
   * Switches the active UI language, persists choice in localStorage,
   * updates the HTML dir attribute (RTL for Urdu), and re-renders the UI.
   */
  function setLanguage(langCode) {
    if (!window.IDARAH_TRANSLATIONS[langCode]) {
      langCode = CFG.DEFAULT_LANGUAGE;
    }
    State.currentLang = langCode;
    try {
      localStorage.setItem(CFG.STORAGE_KEYS.LANG, langCode);
    } catch (e) {
      console.warn('Could not save language preference:', e);
    }

    const htmlEl = document.documentElement;
    htmlEl.lang = langCode;
    htmlEl.dir = (langCode === 'ur') ? 'rtl' : 'ltr';

    // Update language select dropdowns
    document.querySelectorAll('.lang-select-input').forEach(sel => {
      sel.value = langCode;
    });

    renderCurrentView();
  }

  /**
   * Initializes language from localStorage or browser settings
   */
  function initLanguage() {
    let savedLang = null;
    try {
      savedLang = localStorage.getItem(CFG.STORAGE_KEYS.LANG);
    } catch (e) {}

    if (savedLang && window.IDARAH_TRANSLATIONS[savedLang]) {
      setLanguage(savedLang);
    } else {
      setLanguage(CFG.DEFAULT_LANGUAGE);
    }
  }

  // ==========================================================================
  // Safe Storage Management with Atomic Rollback
  // ==========================================================================

  /**
   * Safely reads JSON data from localStorage.
   */
  function storageGet(key, defaultVal = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : defaultVal;
    } catch (err) {
      console.error(`Error reading ${key} from storage:`, err);
      return defaultVal;
    }
  }

  /**
   * Safely writes JSON data to localStorage with automatic rollback on error
   * (such as quota exceeded). Never pretends data was saved if write fails.
   */
  function storageSet(key, value) {
    let previousVal = null;
    try {
      previousVal = localStorage.getItem(key);
    } catch (e) {}

    try {
      const serialized = JSON.stringify(value);
      localStorage.setItem(key, serialized);
      return true;
    } catch (err) {
      console.error(`Storage write failed for ${key}:`, err);
      // Rollback
      try {
        if (previousVal !== null) {
          localStorage.setItem(key, previousVal);
        } else {
          localStorage.removeItem(key);
        }
      } catch (rollbackErr) {
        console.error('Rollback failed:', rollbackErr);
      }
      showToast(t('errStorageFailed'), 'error');
      return false;
    }
  }

  // ==========================================================================
  // Mosque Data Model & Multi-Mosque Segregation
  // ==========================================================================

  /**
   * Returns the list of registered mosques from the central catalog.
   */
  function getMosquesCatalog() {
    return storageGet(CFG.STORAGE_KEYS.MOSQUES_LIST, []);
  }

  /**
   * Saves the mosques catalog to localStorage.
   */
  function saveMosquesCatalog(catalog) {
    return storageSet(CFG.STORAGE_KEYS.MOSQUES_LIST, catalog);
  }

  /**
   * Returns a specific mosque record from the catalog.
   */
  function getMosqueMeta(mosqueId) {
    const list = getMosquesCatalog();
    return list.find(m => m.id === mosqueId) || null;
  }

  /**
   * Returns full isolated application data for a specific mosque.
   */
  function getMosqueData(mosqueId) {
    if (!mosqueId) return null;
    const key = CFG.STORAGE_KEYS.MOSQUE_DATA_PREFIX + mosqueId;
    return storageGet(key, null);
  }

  /**
   * Persists updated mosque data with atomic rollback on failure.
   */
  function saveMosqueData(mosqueId, data) {
    if (!mosqueId) return false;
    const key = CFG.STORAGE_KEYS.MOSQUE_DATA_PREFIX + mosqueId;
    return storageSet(key, data);
  }

  /**
   * Returns all available funds for the current mosque (default + custom).
   */
  function getMosqueFunds(mosqueData) {
    const custom = (mosqueData && mosqueData.customFunds) || [];
    return [...CFG.DEFAULT_FUNDS, ...custom];
  }

  /**
   * Returns human-readable translated fund name.
   */
  function getFundName(fundId, mosqueData) {
    const funds = getMosqueFunds(mosqueData);
    const fund = funds.find(f => f.id === fundId);
    if (!fund) return fundId;
    return fund.nameKey ? t(fund.nameKey) : fund.defaultName || fund.name || fundId;
  }

  /**
   * Checks whether a specific fund is restricted to Zakat-only expenses.
   */
  function isFundZakatOnly(fundId, mosqueData) {
    const funds = getMosqueFunds(mosqueData);
    const fund = funds.find(f => f.id === fundId);
    return fund ? Boolean(fund.isZakatEligible) : false;
  }

  /**
   * Calculates the current live balance for each fund by traversing the ledger.
   */
  function calculateFundBalances(ledger = []) {
    const balances = {};
    // Initialize all default funds with 0
    CFG.DEFAULT_FUNDS.forEach(f => { balances[f.id] = 0; });

    ledger.forEach(entry => {
      const fundId = entry.fundId;
      if (typeof balances[fundId] !== 'number') {
        balances[fundId] = 0;
      }
      const amt = Number(entry.amount) || 0;
      if (entry.type === 'donation') {
        balances[fundId] += amt;
      } else if (entry.type === 'expense') {
        balances[fundId] -= amt;
      } else if (entry.type === 'reversal') {
        // Reversal reverses the impact of the targeted transaction
        if (entry.reversesType === 'donation') {
          balances[fundId] -= amt; // Reversing a donation subtracts it
        } else if (entry.reversesType === 'expense') {
          balances[fundId] += amt; // Reversing an expense restores it
        }
      }
    });

    return balances;
  }

  // ==========================================================================
  // Pre-Seeded Realistic Demo Data
  // ==========================================================================

  /**
   * Seeds an authentic demo mosque ("Madina Masjid & Madrasa Noor-ul-Uloom, Kolkata")
   * complete with pre-hashed SHA-256 ledger blocks, students, staff, and records.
   * This allows instant evaluation, public verification, and testing right away.
   */
  function seedDemoDataIfEmpty() {
    let catalog = getMosquesCatalog();
    if (catalog && catalog.length > 0) {
      return; // Data already exists
    }

    const demoMosqueId = 'mosque_demo_madina';
    const todayIST = getISTDate();
    const currentMonth = getISTMonth();

    const demoMosqueMeta = {
      id: demoMosqueId,
      name: 'Madina Masjid & Madrasa Noor-ul-Uloom',
      location: 'Park Circus, Kolkata, West Bengal',
      address: '14/2, Darga Road, Park Circus, Kolkata - 700017',
      registrationNo: 'WB-WAQF-2020-0419',
      adminPhone: '9876543210',
      createdAt: `${todayIST} 08:00:00 IST`,
      settings: {
        showSalaryInPublic: false,
        showBillPhotosInPublic: false
      },
      customFunds: [
        {
          id: 'fund_construction',
          name: 'Mosque Expansion & Wudhu Khana',
          defaultName: 'Mosque Expansion & Wudhu Khana',
          isZakatEligible: false,
          isSystem: false
        }
      ]
    };

    // Committee Users
    const demoUsers = [
      {
        id: 'user_admin',
        name: 'Maulana Abdul Rahman',
        phone: '9876543210',
        email: 'admin@noorululoom.org',
        role: 'admin',
        pin: hashPin('9876543210', '123456')
      },
      {
        id: 'user_treasurer',
        name: 'Haji Muhammad Tariq',
        phone: '9830112233',
        email: 'tariq@noorululoom.org',
        role: 'treasurer',
        pin: hashPin('9830112233', '123456')
      },
      {
        id: 'user_teacher',
        name: 'Qari Bilal Hussain',
        phone: '9830445566',
        email: 'bilal@noorululoom.org',
        role: 'teacher',
        pin: hashPin('9830445566', '123456')
      }
    ];

    // Build raw ledger entries and chain them with SHA-256
    const rawLedger = [
      {
        seq: 1,
        date: `${todayIST} 09:15:00 IST`,
        type: 'donation',
        amount: 25000,
        fundId: 'fund_general',
        method: 'Cash',
        category: 'Friday Jumuah Collection',
        note: 'Congregational collection box',
        donorName: 'Anonymous Donor',
        donorPhone: '',
        receiptNo: 'RCP-0001',
        verifyCode: '8K2M9X1A',
        billPhoto: '',
        recordedBy: 'Haji Muhammad Tariq (Treasurer)',
        reversesSeq: '',
        reversesType: '',
        prevHash: 'GENESIS'
      },
      {
        seq: 2,
        date: `${todayIST} 09:30:00 IST`,
        type: 'donation',
        amount: 50000,
        fundId: 'fund_zakat',
        method: 'Direct UPI (QR / PhonePe / GPay)',
        category: 'Annual Zakat Contribution',
        note: 'Dedicated for poor families',
        donorName: 'Private Contributor',
        donorPhone: '9831000000',
        receiptNo: 'RCP-0002',
        verifyCode: '4N7P3D9E',
        billPhoto: '',
        recordedBy: 'Haji Muhammad Tariq (Treasurer)',
        reversesSeq: '',
        reversesType: '',
        prevHash: '' // computed below
      },
      {
        seq: 3,
        date: `${todayIST} 10:00:00 IST`,
        type: 'donation',
        amount: 15000,
        fundId: 'fund_sadaqah',
        method: 'Cash',
        category: 'Community Welfare Donation',
        note: 'General welfare fund donation',
        donorName: 'Farhan Akhtar',
        donorPhone: '9832000000',
        receiptNo: 'RCP-0003',
        verifyCode: '9Y2T5W8C',
        billPhoto: '',
        recordedBy: 'Haji Muhammad Tariq (Treasurer)',
        reversesSeq: '',
        reversesType: '',
        prevHash: ''
      },
      {
        seq: 4,
        date: `${todayIST} 10:45:00 IST`,
        type: 'expense',
        amount: 12000,
        fundId: 'fund_zakat',
        method: 'Cash',
        category: 'Poor & Needy Relief (Fuqara & Masakeen)',
        note: 'Ration kits distributed to 6 destitute families in ward 64',
        donorName: '',
        donorPhone: '',
        receiptNo: '',
        verifyCode: '',
        billPhoto: '',
        recordedBy: 'Maulana Abdul Rahman (Admin)',
        reversesSeq: '',
        reversesType: '',
        prevHash: ''
      },
      {
        seq: 5,
        date: `${todayIST} 11:20:00 IST`,
        type: 'expense',
        amount: 4500,
        fundId: 'fund_general',
        method: 'Direct Bank Transfer (NEFT/IMPS)',
        category: 'Electricity & Water Utilities',
        note: 'CESC Kolkata Mosque Electricity Bill Payment',
        donorName: '',
        donorPhone: '',
        receiptNo: '',
        verifyCode: '',
        billPhoto: '',
        recordedBy: 'Haji Muhammad Tariq (Treasurer)',
        reversesSeq: '',
        reversesType: '',
        prevHash: ''
      }
    ];

    // Compute cryptographic SHA-256 hashes linking each block
    let prev = 'GENESIS';
    const chainedLedger = rawLedger.map(entry => {
      entry.prevHash = prev;
      entry.hash = HASH.computeEntryHash(entry, prev);
      prev = entry.hash;
      return entry;
    });

    // Students
    const demoStudents = [
      {
        id: 'std_1',
        name: 'Muhammad Zaid',
        guardianName: 'Tariq Ahmad',
        phone: '9876500001',
        className: 'Hifz Batch A',
        monthlyFee: 500,
        admissionDate: `${todayIST.substring(0, 7)}-01`
      },
      {
        id: 'std_2',
        name: 'Ahmad Raza',
        guardianName: 'Noor Alam',
        phone: '9876500002',
        className: 'Nazira Class 2',
        monthlyFee: 400,
        admissionDate: `${todayIST.substring(0, 7)}-01`
      },
      {
        id: 'std_3',
        name: 'Usman Ghani',
        guardianName: 'Irfan Sheikh',
        phone: '9876500003',
        className: 'Tajweed Branch',
        monthlyFee: 350,
        admissionDate: `${todayIST.substring(0, 7)}-01`
      }
    ];

    // Pre-record fee payment for Student 1
    const demoFeePayments = [
      {
        id: 'fee_1',
        studentId: 'std_1',
        studentName: 'Muhammad Zaid',
        month: currentMonth,
        amount: 500,
        receiptNo: 'RCP-0001',
        date: `${todayIST} 09:00:00 IST`,
        ledgerSeq: 1
      }
    ];

    // Daily Attendance pre-populated for today
    const demoAttendance = {
      [todayIST]: {
        'std_1': { status: 'present', sabaq: 'Surah Al-Baqarah 1-25', sabqi: 'Para 1 Quarter 2', manzil: 'Para 30 full' },
        'std_2': { status: 'present', sabaq: 'Surah Maryam 1-15', sabqi: 'Para 15', manzil: 'Para 1' },
        'std_3': { status: 'absent', sabaq: '', sabqi: '', manzil: '' }
      }
    };

    // Staff
    const demoStaff = [
      {
        id: 'stf_1',
        name: 'Maulana Abdul Rahman',
        role: 'Imam & Khateeb',
        phone: '9876543210',
        monthlySalary: 18000
      },
      {
        id: 'stf_2',
        name: 'Hafiz Imran Qasmi',
        role: 'Muazzin & Caretaker',
        phone: '9830889900',
        monthlySalary: 12000
      },
      {
        id: 'stf_3',
        name: 'Qari Bilal Hussain',
        role: 'Head Ustad (Hifz)',
        phone: '9830445566',
        monthlySalary: 15000
      }
    ];

    // Staff salary records
    const demoSalaryPayments = [];

    // Salah Timings (IST)
    const demoSalahTimings = {
      fajr: { adhan: '05:00', iqamah: '05:30' },
      dhuhr: { adhan: '12:45', iqamah: '01:15' },
      asr: { adhan: '04:15', iqamah: '04:45' },
      maghrib: { adhan: '05:40', iqamah: '05:45' },
      isha: { adhan: '07:30', iqamah: '08:00' },
      jumuah: { adhan: '12:30', iqamah: '01:30' }
    };

    // Nikah & Janazah
    const demoNikah = [
      {
        id: 'nk_1',
        groom: 'Farhan Ali (Kolkata)',
        bride: 'Ayesha Siddiqua (Howrah)',
        waliWitnesses: 'Wali: Tariq Ali; Witnesses: Zaid & Umar',
        mahr: '₹51,000 Prompt (Mu\'ajjal)',
        date: `${todayIST.substring(0, 7)}-05`,
        qadi: 'Maulana Abdul Rahman',
        notes: 'Solemnized at Jama Masjid Community Hall'
      }
    ];

    const demoJanazah = [
      {
        id: 'jn_1',
        deceased: 'Haji Ghulam Mustafa',
        age: 72,
        demiseDate: `${todayIST.substring(0, 7)}-10`,
        janazahTime: 'After Asr Prayer (04:45 PM)',
        burialPlace: 'Tiljala Muslim Qabristan, Kolkata',
        notes: 'Prominent community elder and founding member.'
      }
    ];

    // Assets
    const demoAssets = [
      {
        id: 'ast_1',
        name: 'Ahuja SSA-250M Sound Amplifier',
        location: 'Main Minaret & Prayer Hall',
        value: 18500,
        condition: 'Good / Operational',
        acquiredDate: '2023-04-12'
      },
      {
        id: 'ast_2',
        name: 'Voltas 2-Ton Inverter AC (2 Units)',
        location: 'Madrasa Hifz Class',
        value: 84000,
        condition: 'Good / Operational',
        acquiredDate: '2024-03-20'
      }
    ];

    // Notices
    const demoNotices = [
      {
        id: 'ntc_1',
        title: 'Ramadan 1448 Hifz Quran Completion & Dua',
        content: 'Special Khatm-e-Quran ceremony and community Iftar will be held on the 27th night of Ramadan in the main prayer hall. All brothers and well-wishers are cordially invited.',
        date: todayIST,
        expiryDate: ''
      }
    ];

    const demoData = {
      users: demoUsers,
      ledger: chainedLedger,
      students: demoStudents,
      feePayments: demoFeePayments,
      attendance: demoAttendance,
      staff: demoStaff,
      salaryPayments: demoSalaryPayments,
      salahTimings: demoSalahTimings,
      nikah: demoNikah,
      janazah: demoJanazah,
      assets: demoAssets,
      notices: demoNotices,
      customFunds: demoMosqueMeta.customFunds
    };

    saveMosquesCatalog([demoMosqueMeta]);
    saveMosqueData(demoMosqueId, demoData);
  }

  // ==========================================================================
  // Session & Authentication Handling
  // ==========================================================================

  /**
   * Restores user session from localStorage if available.
   */
  function restoreSession() {
    const session = storageGet(CFG.STORAGE_KEYS.CURRENT_SESSION, null);
    if (!session || !session.mosqueId) return;
    // Sessions store only the user id; the user record (and PIN hash) stays in mosque data.
    const userId = session.userId || (session.user && session.user.id);
    const data = getMosqueData(session.mosqueId);
    const user = data && data.users && data.users.find(u => u.id === userId);
    if (user) {
      State.currentMosqueId = session.mosqueId;
      State.currentUser = sessionUser(user);
    }
  }

  /**
   * Returns a copy of a user record without the PIN, safe to keep in memory/UI state.
   */
  function sessionUser(user) {
    const { pin, ...safe } = user;
    return safe;
  }

  /**
   * Salted SHA-256 digest of a PIN. Prefixed so legacy plaintext PINs can be detected and upgraded.
   */
  function hashPin(phone, pin) {
    return 'h1$' + HASH.sha256('idarah|' + phone + '|' + pin);
  }

  function pinMatches(user, pin) {
    if (typeof user.pin === 'string' && user.pin.startsWith('h1$')) {
      return user.pin === hashPin(user.phone, pin);
    }
    return user.pin === pin; // legacy plaintext (upgraded on successful login)
  }

  // ==========================================================================
  // Role-Based Permissions
  // ==========================================================================

  const ROLE_PERMISSIONS = {
    admin: ['ledger', 'fees', 'salary', 'madrasa', 'ops', 'settings'],
    treasurer: ['ledger', 'fees', 'salary', 'ops'],
    teacher: ['madrasa'],
    viewer: []
  };

  function can(perm) {
    const role = State.currentUser && State.currentUser.role;
    return Boolean(role && (ROLE_PERMISSIONS[role] || []).includes(perm));
  }

  /**
   * Returns true if the current user holds the permission; otherwise shows an error toast.
   */
  function requirePerm(perm) {
    if (can(perm)) return true;
    showToast(t('errPermissionDenied'), 'error');
    return false;
  }

  /**
   * Logs in a user after checking 10-digit mobile number and PIN.
   */
  function handleLogin(phone, pin) {
    phone = String(phone).trim();
    pin = String(pin).trim();

    if (!CFG.VALIDATION.PHONE_REGEX.test(phone)) {
      showToast(t('errInvalidPhone'), 'error');
      return false;
    }
    if (pin.length < CFG.VALIDATION.MIN_PIN_LENGTH) {
      showToast(t('errPinShort'), 'error');
      return false;
    }

    const catalog = getMosquesCatalog();
    let authenticatedUser = null;
    let matchedMosqueId = null;

    // Search across registered mosques
    for (const m of catalog) {
      const data = getMosqueData(m.id);
      if (data && data.users) {
        const found = data.users.find(u => u.phone === phone && pinMatches(u, pin));
        if (found) {
          // Upgrade legacy plaintext PIN to a salted hash
          if (!String(found.pin).startsWith('h1$')) {
            found.pin = hashPin(found.phone, pin);
            saveMosqueData(m.id, data);
          }
          authenticatedUser = sessionUser(found);
          matchedMosqueId = m.id;
          break;
        }
      }
    }

    if (!authenticatedUser) {
      showToast(t('errLoginFailed'), 'error');
      return false;
    }

    State.currentMosqueId = matchedMosqueId;
    State.currentUser = authenticatedUser;
    State.isPublicView = false;
    State.activeTab = 'dashboard';

    storageSet(CFG.STORAGE_KEYS.CURRENT_SESSION, {
      mosqueId: matchedMosqueId,
      userId: authenticatedUser.id
    });

    showToast(t('msgSaved'), 'success');
    renderCurrentView();
    return true;
  }

  /**
   * Registers a new Mosque/Madrasa and initiates committee onboarding.
   */
  function handleSignup(mosqueName, location, adminName, adminPhone, adminEmail, adminPin) {
    mosqueName = String(mosqueName).trim();
    location = String(location).trim();
    adminName = String(adminName).trim();
    adminPhone = String(adminPhone).trim();
    adminEmail = String(adminEmail).trim();
    adminPin = String(adminPin).trim();

    if (!mosqueName) {
      showToast(t('errMosqueNameReq'), 'error');
      return false;
    }
    if (!adminName) {
      showToast(t('errAdminNameReq'), 'error');
      return false;
    }
    if (!CFG.VALIDATION.PHONE_REGEX.test(adminPhone)) {
      showToast(t('errInvalidPhone'), 'error');
      return false;
    }
    if (adminPin.length < CFG.VALIDATION.MIN_PIN_LENGTH) {
      showToast(t('errPinShort'), 'error');
      return false;
    }

    // Check if user already exists
    const catalog = getMosquesCatalog();
    for (const m of catalog) {
      const d = getMosqueData(m.id);
      if (d && d.users && d.users.some(u => u.phone === adminPhone)) {
        showToast(t('errUserExists'), 'error');
        return false;
      }
    }

    const newMosqueId = 'mosque_' + Date.now();
    const todayIST = getISTDate();

    const newMosqueMeta = {
      id: newMosqueId,
      name: mosqueName,
      location: location,
      address: location,
      registrationNo: '',
      adminPhone: adminPhone,
      createdAt: `${todayIST} IST`,
      settings: { ...CFG.DEFAULT_PUBLIC_SETTINGS },
      customFunds: []
    };

    const adminUser = {
      id: 'user_' + Date.now(),
      name: adminName,
      phone: adminPhone,
      email: adminEmail,
      role: 'admin',
      pin: hashPin(adminPhone, adminPin)
    };

    const initialData = {
      users: [adminUser],
      ledger: [],
      students: [],
      feePayments: [],
      attendance: {},
      staff: [],
      salaryPayments: [],
      salahTimings: {
        fajr: { adhan: '05:00', iqamah: '05:30' },
        dhuhr: { adhan: '12:45', iqamah: '01:15' },
        asr: { adhan: '04:15', iqamah: '04:45' },
        maghrib: { adhan: '05:40', iqamah: '05:45' },
        isha: { adhan: '07:30', iqamah: '08:00' },
        jumuah: { adhan: '12:30', iqamah: '01:30' }
      },
      nikah: [],
      janazah: [],
      assets: [],
      notices: [],
      customFunds: []
    };

    catalog.push(newMosqueMeta);
    if (!saveMosquesCatalog(catalog) || !saveMosqueData(newMosqueId, initialData)) {
      return false;
    }

    State.currentMosqueId = newMosqueId;
    State.currentUser = sessionUser(adminUser);
    State.isPublicView = false;

    storageSet(CFG.STORAGE_KEYS.CURRENT_SESSION, {
      mosqueId: newMosqueId,
      userId: adminUser.id
    });

    // Open committee onboarding modal immediately!
    openOnboardingModal();
    return true;
  }

  /**
   * Logs out the current user and clears session
   */
  function handleLogout() {
    State.currentUser = null;
    State.currentMosqueId = null;
    State.isPublicView = false;
    try {
      localStorage.removeItem(CFG.STORAGE_KEYS.CURRENT_SESSION);
    } catch (e) {}
    renderCurrentView();
  }

  // ==========================================================================
  // SHA-256 Triple-Entry Ledger Operations
  // ==========================================================================

  /**
   * Generates the next donation receipt number (counts donations only: RCP-0001, RCP-0002...)
   */
  function generateReceiptNumber(ledger) {
    const donationCount = ledger.filter(e => e.type === 'donation').length;
    const nextNum = donationCount + 1;
    return 'RCP-' + String(nextNum).padStart(4, '0');
  }

  /**
   * Adds a Donation entry to the SHA-256 hash chain ledger.
   * Generates sequential receipt # and 8-character verification code.
   */
  function addDonationEntry({ amount, fundId, method, note, donorName, donorPhone }) {
    if (!can('ledger') && !can('fees')) {
      showToast(t('errPermissionDenied'), 'error');
      return null;
    }
    amount = Number(amount);
    if (!amount || amount <= 0) {
      showToast(t('errAmountInvalid'), 'error');
      return null;
    }

    const mosqueData = getMosqueData(State.currentMosqueId);
    if (!mosqueData) return null;

    const ledger = mosqueData.ledger || [];
    const seq = ledger.length + 1;
    const prevHash = seq === 1 ? 'GENESIS' : ledger[ledger.length - 1].hash;
    const receiptNo = generateReceiptNumber(ledger);
    const verifyCode = generateVerificationCode();
    const dateIST = getISTTimestamp();

    const entry = {
      seq: seq,
      date: dateIST,
      type: 'donation',
      amount: amount,
      fundId: fundId,
      method: method,
      category: note ? note : t('typeDonation'),
      note: note || '',
      donorName: donorName ? donorName.trim() : t('anonymousDonor'),
      donorPhone: donorPhone ? donorPhone.trim() : '',
      receiptNo: receiptNo,
      verifyCode: verifyCode,
      billPhoto: '',
      recordedBy: `${State.currentUser.name} (${t('role_' + State.currentUser.role)})`,
      reversesSeq: '',
      reversesType: '',
      prevHash: prevHash
    };

    // Calculate SHA-256 hash across all 17 fields
    entry.hash = HASH.computeEntryHash(entry, prevHash);

    ledger.push(entry);
    mosqueData.ledger = ledger;

    if (!saveMosqueData(State.currentMosqueId, mosqueData)) {
      return null;
    }

    showToast(t('msgDonationRecorded', { receiptNo: receiptNo }), 'success');
    return entry;
  }

  /**
   * Adds an Expense entry to the SHA-256 hash chain ledger.
   * Strictly enforces:
   * 1. Balance check: blocks if expense exceeds fund balance.
   * 2. Zakat restriction: if fund is Zakat-restricted, requires Zakat-eligible category.
   */
  function addExpenseEntry({ amount, fundId, category, note, billPhoto }) {
    if (!requirePerm('ledger')) return null;
    amount = Number(amount);
    if (!amount || amount <= 0) {
      showToast(t('errAmountInvalid'), 'error');
      return null;
    }

    const mosqueData = getMosqueData(State.currentMosqueId);
    if (!mosqueData) return null;

    // Check Fund Balance
    const balances = calculateFundBalances(mosqueData.ledger);
    const currentBalance = balances[fundId] || 0;
    if (amount > currentBalance) {
      const fundName = getFundName(fundId, mosqueData);
      showToast(t('errFundInsufficient', {
        amount: formatCurrency(amount),
        fund: fundName,
        balance: formatCurrency(currentBalance)
      }), 'error');
      return null;
    }

    // Check Zakat restriction
    const isZakat = isFundZakatOnly(fundId, mosqueData);
    if (isZakat) {
      const isEligibleCategory = CFG.ZAKAT_EXPENSE_CATEGORIES.some(c => c.id === category || c.defaultName === category || t(c.nameKey) === category);
      if (!isEligibleCategory) {
        showToast(t('errZakatCategoryRequired'), 'error');
        return null;
      }
    }

    const ledger = mosqueData.ledger || [];
    const seq = ledger.length + 1;
    const prevHash = seq === 1 ? 'GENESIS' : ledger[ledger.length - 1].hash;
    const dateIST = getISTTimestamp();

    const entry = {
      seq: seq,
      date: dateIST,
      type: 'expense',
      amount: amount,
      fundId: fundId,
      method: 'Cash/Direct',
      category: category,
      note: note || '',
      donorName: '',
      donorPhone: '',
      receiptNo: '',
      verifyCode: '',
      billPhoto: billPhoto || '',
      recordedBy: `${State.currentUser.name} (${t('role_' + State.currentUser.role)})`,
      reversesSeq: '',
      reversesType: '',
      prevHash: prevHash
    };

    entry.hash = HASH.computeEntryHash(entry, prevHash);

    ledger.push(entry);
    mosqueData.ledger = ledger;

    if (!saveMosqueData(State.currentMosqueId, mosqueData)) {
      return null;
    }

    showToast(t('msgExpenseRecorded', { seq: seq }), 'success');
    return entry;
  }

  /**
   * Appends a permanent Reversal entry to the SHA-256 ledger.
   * Ledger entries can NEVER be deleted or edited; corrections must be reversed.
   */
  function addReversalEntry(targetSeq, reason) {
    if (!requirePerm('ledger')) return null;
    const mosqueData = getMosqueData(State.currentMosqueId);
    if (!mosqueData) return null;

    const ledger = mosqueData.ledger || [];
    const target = ledger.find(e => e.seq === Number(targetSeq));
    if (!target) return null;

    // Check if target was already reversed
    const alreadyReversed = ledger.some(e => e.type === 'reversal' && e.reversesSeq === target.seq);
    if (alreadyReversed) {
      showToast('This block has already been reversed.', 'error');
      return null;
    }

    const seq = ledger.length + 1;
    const prevHash = ledger[ledger.length - 1].hash;
    const dateIST = getISTTimestamp();

    const entry = {
      seq: seq,
      date: dateIST,
      type: 'reversal',
      amount: target.amount,
      fundId: target.fundId,
      method: target.method,
      category: `Reversal of Block #${target.seq} (${target.category})`,
      note: reason ? reason.trim() : 'Correction entry',
      donorName: target.donorName,
      donorPhone: target.donorPhone,
      receiptNo: target.receiptNo,
      verifyCode: '',
      billPhoto: '',
      recordedBy: `${State.currentUser.name} (${t('role_' + State.currentUser.role)})`,
      reversesSeq: target.seq,
      reversesType: target.type,
      prevHash: prevHash
    };

    entry.hash = HASH.computeEntryHash(entry, prevHash);

    ledger.push(entry);
    mosqueData.ledger = ledger;

    // Reversing a fee/salary payment must also release that month so it can be re-collected
    mosqueData.feePayments = (mosqueData.feePayments || []).filter(f => f.ledgerSeq !== target.seq);
    mosqueData.salaryPayments = (mosqueData.salaryPayments || []).filter(p => p.ledgerSeq !== target.seq);

    if (!saveMosqueData(State.currentMosqueId, mosqueData)) {
      return null;
    }

    showToast(t('msgReversalRecorded', { seq: seq }), 'success');
    return entry;
  }

  // ==========================================================================
  // Image Compression Helper (Canvas Downscaling for Bill Photos)
  // ==========================================================================

  /**
   * Auto-compresses an uploaded bill/voucher image to JPEG with max 800px dimension
   * to keep localStorage footprint compact and fast.
   */
  function compressImageFile(file, callback) {
    if (!file || !file.type.startsWith('image/')) {
      callback(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = function (e) {
      const img = new Image();
      img.onload = function () {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;
        const maxDim = 800;

        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        const compressedDataUrl = canvas.toDataURL('image/jpeg', 0.65);
        callback(compressedDataUrl);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  // ==========================================================================
  // WhatsApp Share Generator
  // ==========================================================================

  /**
   * Generates a 1-tap WhatsApp Web/Mobile link for a donation receipt.
   */
  function generateReceiptWhatsAppUrl(entry, mosqueMeta) {
    const mosqueName = mosqueMeta ? mosqueMeta.name : 'Mosque & Madrasa';
    const fundName = getFundName(entry.fundId, getMosqueData(mosqueMeta.id));
    const verifyUrl = `${window.location.origin}${window.location.pathname}?verify=${encodeURIComponent(entry.receiptNo)}&code=${encodeURIComponent(entry.verifyCode)}`;

    const text = t('waReceiptTemplate', {
      mosqueName: mosqueName,
      receiptNo: entry.receiptNo,
      verifyCode: entry.verifyCode,
      date: entry.date,
      donorName: entry.donorName || t('anonymousDonor'),
      amount: formatCurrency(entry.amount),
      fundName: fundName,
      method: entry.method,
      hash: entry.hash.substring(0, 16) + '...',
      verifyUrl: verifyUrl
    });

    return 'https://api.whatsapp.com/send?text=' + encodeURIComponent(text);
  }

  // ==========================================================================
  // UI Rendering: View Routing & Tabs
  // ==========================================================================

  /**
   * Master render coordinator. Decides whether to render:
   * 1. Public Explorer (if isPublicView is true)
   * 2. Login / Sign Up Screen (if no active session)
   * 3. Authenticated Dashboard (with active tab)
   */
  function renderCurrentView() {
    const root = document.getElementById('app-root');
    if (!root) return;

    if (State.isPublicView) {
      renderPublicExplorer(root);
      return;
    }

    if (!State.currentUser || !State.currentMosqueId) {
      renderAuthScreen(root);
      return;
    }

    renderAuthenticatedApp(root);
  }

  /**
   * Displays a brief toast message in the bottom corner.
   */
  function showToast(message, type = 'info') {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      container.className = 'toast-container';
      document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  }

  // ==========================================================================
  // View 1: Authentication Screen (Login, Signup, Public Explorer Button)
  // ==========================================================================

  function renderAuthScreen(root) {
    const catalog = getMosquesCatalog();
    root.innerHTML = `
      <header class="app-header">
        <div class="header-container">
          <div class="brand-wrapper">
            <div class="brand-icon">🕌</div>
            <div class="brand-title-group">
              <h1>${escapeHtml(t('appName'))}</h1>
              <p>${escapeHtml(t('appTagline'))}</p>
            </div>
          </div>
          <div class="header-controls">
            <button type="button" id="btn-pwa-install" class="btn btn-outline btn-sm" onclick="window.installIdarahPwa()" style="color: #ffffff; border-color: rgba(255, 255, 255, 0.4);">
              📲 Install App
            </button>
            <select class="lang-selector lang-select-input" id="auth-lang-select" aria-label="Select Language">
              ${CFG.LANGUAGES.map(l => `<option value="${l.code}" ${l.code === State.currentLang ? 'selected' : ''}>${l.name}</option>`).join('')}
            </select>
          </div>
        </div>
      </header>

      <main class="main-container" style="max-width: 520px; margin-top: 24px;">
        <div class="card">
          <div style="text-align: center; margin-bottom: 20px;">
            <div style="font-size: 2.5rem; margin-bottom: 8px;">🕌</div>
            <h2 style="font-size: 1.4rem; font-weight: 700;">${escapeHtml(t('authTitle'))}</h2>
            <p style="font-size: 0.9rem; color: var(--text-muted);">${escapeHtml(t('authSubtitle'))}</p>
          </div>

          <!-- Auth Tabs: Login vs Register -->
          <div style="display: flex; gap: 8px; margin-bottom: 20px; border-bottom: 2px solid var(--border-subtle); padding-bottom: 4px;">
            <button type="button" id="tab-login-btn" class="nav-tab-btn active" style="flex: 1; text-align: center;">${escapeHtml(t('tabLogin'))}</button>
            <button type="button" id="tab-signup-btn" class="nav-tab-btn" style="flex: 1; text-align: center;">${escapeHtml(t('tabSignup'))}</button>
          </div>

          <!-- Login Form -->
          <form id="form-login" style="display: block;">
            <div class="form-group">
              <label class="form-label" for="login-phone">${escapeHtml(t('labelPhone'))}</label>
              <input type="tel" id="login-phone" class="form-control" placeholder="${escapeHtml(t('placeholderPhone'))}" maxlength="10" required autofocus />
            </div>
            <div class="form-group">
              <label class="form-label" for="login-pin">${escapeHtml(t('labelPassword'))}</label>
              <input type="password" id="login-pin" class="form-control" placeholder="${escapeHtml(t('placeholderPassword'))}" required />
            </div>

            <div style="margin: 12px 0; font-size: 0.85rem; color: var(--text-muted); background: var(--primary-light); padding: 8px 12px; border-radius: var(--radius-sm);">
              💡 ${escapeHtml(t('demoLoginHint'))}
            </div>

            <button type="submit" class="btn btn-primary btn-block" style="margin-top: 10px;">
              ${escapeHtml(t('btnLogin'))}
            </button>

            <button type="button" id="btn-quick-demo" class="btn btn-secondary btn-block btn-sm" style="margin-top: 8px;">
              ${escapeHtml(t('btnQuickDemo'))}
            </button>
          </form>

          <!-- Signup Form -->
          <form id="form-signup" style="display: none;">
            <div class="form-group">
              <label class="form-label" for="signup-mosque-name">${escapeHtml(t('labelMosqueName'))} *</label>
              <input type="text" id="signup-mosque-name" class="form-control" placeholder="${escapeHtml(t('placeholderMosqueName'))}" required />
            </div>
            <div class="form-group">
              <label class="form-label" for="signup-location">${escapeHtml(t('labelMosqueLocation'))}</label>
              <input type="text" id="signup-location" class="form-control" placeholder="${escapeHtml(t('placeholderMosqueLocation'))}" />
            </div>
            <div class="form-group">
              <label class="form-label" for="signup-admin-name">${escapeHtml(t('labelAdminName'))} *</label>
              <input type="text" id="signup-admin-name" class="form-control" placeholder="${escapeHtml(t('placeholderAdminName'))}" required />
            </div>
            <div class="form-group">
              <label class="form-label" for="signup-phone">${escapeHtml(t('labelPhone'))} *</label>
              <input type="tel" id="signup-phone" class="form-control" placeholder="${escapeHtml(t('placeholderPhone'))}" maxlength="10" required />
            </div>
            <div class="form-group">
              <label class="form-label" for="signup-email">${escapeHtml(t('labelEmail'))}</label>
              <input type="email" id="signup-email" class="form-control" placeholder="${escapeHtml(t('placeholderEmail'))}" />
            </div>
            <div class="form-group">
              <label class="form-label" for="signup-pin">${escapeHtml(t('labelPassword'))} *</label>
              <input type="password" id="signup-pin" class="form-control" placeholder="${escapeHtml(t('placeholderPassword'))}" minlength="6" required />
            </div>

            <button type="submit" class="btn btn-primary btn-block" style="margin-top: 10px;">
              ${escapeHtml(t('btnSignup'))}
            </button>
          </form>

          <hr style="margin: 24px 0 16px; border: 0; border-top: 1px solid var(--border-subtle);" />

          <!-- Open Public Ledger Explorer Button -->
          <div style="text-align: center;">
            <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 10px;">
              ${escapeHtml(t('publicExplorerNotice'))}
            </p>
            <button type="button" id="btn-open-public" class="btn btn-outline btn-block">
              🔍 ${escapeHtml(t('btnPublicExplorer'))}
            </button>
          </div>
        </div>
      </main>
    `;

    // Bind Auth Screen Events
    const langSelect = document.getElementById('auth-lang-select');
    if (langSelect) {
      langSelect.addEventListener('change', (e) => setLanguage(e.target.value));
    }

    const tabLogin = document.getElementById('tab-login-btn');
    const tabSignup = document.getElementById('tab-signup-btn');
    const formLogin = document.getElementById('form-login');
    const formSignup = document.getElementById('form-signup');

    tabLogin.addEventListener('click', () => {
      tabLogin.classList.add('active');
      tabSignup.classList.remove('active');
      formLogin.style.display = 'block';
      formSignup.style.display = 'none';
    });

    tabSignup.addEventListener('click', () => {
      tabSignup.classList.add('active');
      tabLogin.classList.remove('active');
      formLogin.style.display = 'none';
      formSignup.style.display = 'block';
    });

    // Quick demo fill
    const btnQuickDemo = document.getElementById('btn-quick-demo');
    if (btnQuickDemo) {
      btnQuickDemo.addEventListener('click', () => {
        document.getElementById('login-phone').value = '9876543210';
        document.getElementById('login-pin').value = '123456';
      });
    }

    // Submit Login
    formLogin.addEventListener('submit', (e) => {
      e.preventDefault();
      const phone = document.getElementById('login-phone').value;
      const pin = document.getElementById('login-pin').value;
      handleLogin(phone, pin);
    });

    // Submit Signup
    formSignup.addEventListener('submit', (e) => {
      e.preventDefault();
      const mosqueName = document.getElementById('signup-mosque-name').value;
      const location = document.getElementById('signup-location').value;
      const adminName = document.getElementById('signup-admin-name').value;
      const phone = document.getElementById('signup-phone').value;
      const email = document.getElementById('signup-email').value;
      const pin = document.getElementById('signup-pin').value;
      handleSignup(mosqueName, location, adminName, phone, email, pin);
    });

    // Open Public View
    document.getElementById('btn-open-public').addEventListener('click', () => {
      State.isPublicView = true;
      const mosques = getMosquesCatalog();
      State.publicSelectedMosqueId = mosques.length > 0 ? mosques[0].id : null;
      renderCurrentView();
    });
  }

  // ==========================================================================
  // View 2: Authenticated Main App Shell
  // ==========================================================================

  function renderAuthenticatedApp(root) {
    const mosqueMeta = getMosqueMeta(State.currentMosqueId);
    const mosqueData = getMosqueData(State.currentMosqueId);
    const mosqueName = mosqueMeta ? mosqueMeta.name : 'Idarah Mosque';

    root.innerHTML = `
      <!-- Top Application Header -->
      <header class="app-header">
        <div class="header-container">
          <div class="brand-wrapper">
            <div class="brand-icon">🕌</div>
            <div class="brand-title-group">
              <h1>${escapeHtml(t('appName'))}</h1>
              <p>${escapeHtml(mosqueName)}</p>
            </div>
          </div>
          <div class="header-controls">
            <button type="button" class="btn btn-outline btn-sm" onclick="window.installIdarahPwa()" style="color: #ffffff; border-color: rgba(255, 255, 255, 0.4);">
              📲 Install App
            </button>
            <select class="lang-selector lang-select-input" aria-label="Select Language">
              ${CFG.LANGUAGES.map(l => `<option value="${l.code}" ${l.code === State.currentLang ? 'selected' : ''}>${l.name}</option>`).join('')}
            </select>
            <button type="button" id="btn-logout" class="btn btn-outline btn-sm" style="color: #ffffff; border-color: rgba(255,255,255,0.4);">
              🚪 ${escapeHtml(t('btnLogout'))}
            </button>
          </div>
        </div>
      </header>

      <!-- Active Mosque & Role Metadata Bar -->
      <div class="mosque-bar">
        <div class="mosque-bar-container">
          <div class="mosque-info-pill">
            <span>📍 ${escapeHtml(mosqueMeta ? mosqueMeta.location : '')}</span>
          </div>
          <div class="user-badge-group">
            <span style="font-weight: 600;">👤 ${escapeHtml(State.currentUser.name)}</span>
            <span class="metric-card-badge badge-general">${escapeHtml(t('role_' + State.currentUser.role))}</span>
          </div>
        </div>
      </div>

      <!-- Navigation Tabs (Mobile-friendly scrollable bar) -->
      <nav class="nav-tabs-bar" aria-label="App Navigation">
        <div class="nav-tabs-container">
          <button type="button" class="nav-tab-btn ${State.activeTab === 'dashboard' ? 'active' : ''}" data-tab="dashboard">
            📊 ${escapeHtml(t('navDashboard'))}
          </button>
          <button type="button" class="nav-tab-btn ${State.activeTab === 'finance' ? 'active' : ''}" data-tab="finance">
            💰 ${escapeHtml(t('navFinance'))}
          </button>
          <button type="button" class="nav-tab-btn ${State.activeTab === 'madrasa' ? 'active' : ''}" data-tab="madrasa">
            📖 ${escapeHtml(t('navMadrasa'))}
          </button>
          <button type="button" class="nav-tab-btn ${State.activeTab === 'ops' ? 'active' : ''}" data-tab="ops">
            🕌 ${escapeHtml(t('navMosqueOps'))}
          </button>
          <button type="button" class="nav-tab-btn ${State.activeTab === 'reports' ? 'active' : ''}" data-tab="reports">
            📑 ${escapeHtml(t('navReports'))}
          </button>
          ${can('settings') ? `
          <button type="button" class="nav-tab-btn ${State.activeTab === 'settings' ? 'active' : ''}" data-tab="settings">
            ⚙️ ${escapeHtml(t('navSettings'))}
          </button>` : ''}
          <button type="button" class="nav-tab-btn" id="btn-switch-to-public">
            🔍 ${escapeHtml(t('publicTitle'))}
          </button>
        </div>
      </nav>

      <!-- Dynamic Tab Content Container -->
      <main class="main-container" id="tab-content-container">
        <!-- Rendered by tab router -->
      </main>
    `;

    // Global Header & Tab Listeners
    root.querySelectorAll('.lang-select-input').forEach(sel => {
      sel.addEventListener('change', (e) => setLanguage(e.target.value));
    });

    document.getElementById('btn-logout').addEventListener('click', handleLogout);

    document.getElementById('btn-switch-to-public').addEventListener('click', () => {
      State.isPublicView = true;
      State.publicSelectedMosqueId = State.currentMosqueId;
      renderCurrentView();
    });

    root.querySelectorAll('.nav-tab-btn[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        State.activeTab = btn.getAttribute('data-tab');
        renderCurrentView();
      });
    });

    // Render Active Tab Content
    const container = document.getElementById('tab-content-container');
    switch (State.activeTab) {
      case 'dashboard':
        renderDashboardTab(container, mosqueMeta, mosqueData);
        break;
      case 'finance':
        renderFinanceTab(container, mosqueMeta, mosqueData);
        break;
      case 'madrasa':
        renderMadrasaTab(container, mosqueMeta, mosqueData);
        break;
      case 'ops':
        renderMosqueOpsTab(container, mosqueMeta, mosqueData);
        break;
      case 'reports':
        renderReportsTab(container, mosqueMeta, mosqueData);
        break;
      case 'settings':
        if (!can('settings')) { State.activeTab = 'dashboard'; renderDashboardTab(container, mosqueMeta, mosqueData); break; }
        renderSettingsTab(container, mosqueMeta, mosqueData);
        break;
      default:
        renderDashboardTab(container, mosqueMeta, mosqueData);
    }
  }

  // ==========================================================================
  // Tab 1: Dashboard Overview
  // ==========================================================================

  function renderDashboardTab(container, mosqueMeta, mosqueData) {
    const ledger = mosqueData.ledger || [];
    const balances = calculateFundBalances(ledger);
    const totalBalance = Object.values(balances).reduce((acc, curr) => acc + curr, 0);

    const students = mosqueData.students || [];
    const staff = mosqueData.staff || [];
    const currentMonth = getISTMonth();
    const paidFeesCount = (mosqueData.feePayments || []).filter(p => p.month === currentMonth).length;
    const pendingDuesCount = students.length - paidFeesCount;

    container.innerHTML = `
      <!-- Total Treasury Hero Card -->
      <div class="card" style="background: linear-gradient(135deg, #047857 0%, #065f46 100%); color: #ffffff;">
        <div style="font-size: 0.9rem; opacity: 0.9; text-transform: uppercase; letter-spacing: 0.5px;">
          ${escapeHtml(t('totalTreasuryBalance'))}
        </div>
        <div style="font-size: 2.3rem; font-weight: 800; margin: 8px 0;">
          ${escapeHtml(formatCurrency(totalBalance))}
        </div>
        <div style="font-size: 0.85rem; opacity: 0.85;">
          🛡️ Triple-Entry Ledger Secured with SHA-256 Cryptography
        </div>
      </div>

      <!-- Quick Action Buttons -->
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; margin-bottom: 20px;">
        <button type="button" id="dash-btn-donation" class="btn btn-primary">
          ➕ ${escapeHtml(t('btnNewDonation'))}
        </button>
        <button type="button" id="dash-btn-expense" class="btn btn-secondary">
          ➖ ${escapeHtml(t('btnNewExpense'))}
        </button>
        <button type="button" id="dash-btn-verify" class="btn btn-outline">
          🔍 ${escapeHtml(t('btnVerifyLedger'))}
        </button>
      </div>

      <!-- Fund Balances Grid -->
      <h3 style="margin-bottom: 12px; font-weight: 700;">${escapeHtml(t('fundBalancesTitle'))}</h3>
      <div class="metrics-grid">
        ${getMosqueFunds(mosqueData).map(fund => {
          const bal = balances[fund.id] || 0;
          const isZakat = fund.isZakatEligible;
          return `
            <div class="metric-card ${isZakat ? 'zakat-restricted' : 'general-fund'}">
              <div class="metric-card-title">${escapeHtml(getFundName(fund.id, mosqueData))}</div>
              <div class="metric-card-amount">${escapeHtml(formatCurrency(bal))}</div>
              <span class="metric-card-badge ${isZakat ? 'badge-zakat' : 'badge-general'}">
                ${isZakat ? '⚠️ ' + escapeHtml(t('zakatRestrictedBadge')) : '✅ ' + escapeHtml(t('generalFundBadge'))}
              </span>
            </div>
          `;
        }).join('')}
      </div>

      <!-- Operational Summary Cards -->
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px;">
        <!-- Madrasa Card -->
        <div class="card">
          <div class="card-title">📖 ${escapeHtml(t('navMadrasa'))}</div>
          <p style="margin: 8px 0; color: var(--text-muted);">
            Enrolled Students: <strong>${students.length}</strong>
          </p>
          <p style="margin: 8px 0; color: ${pendingDuesCount > 0 ? 'var(--gold)' : 'var(--success)'}; font-weight: 600;">
            Pending Fees for ${currentMonth}: ${pendingDuesCount} students
          </p>
          <button type="button" class="btn btn-secondary btn-sm" style="margin-top: 10px;" id="dash-go-madrasa">
            ${escapeHtml(t('navMadrasa'))} →
          </button>
        </div>

        <!-- Salah Timings Card -->
        <div class="card">
          <div class="card-title">⏰ ${escapeHtml(t('salahTimingsTitle'))}</div>
          <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 10px; font-size: 0.85rem;">
            ${CFG.SALAH_PRAYERS.map(sp => {
              const tim = (mosqueData.salahTimings && mosqueData.salahTimings[sp.id]) || { adhan: '--:--', iqamah: '--:--' };
              return `
                <div style="background: var(--bg-app); padding: 6px; border-radius: var(--radius-sm); text-align: center;">
                  <div style="font-weight: 700;">${escapeHtml(t(sp.nameKey))}</div>
                  <div style="color: var(--primary); font-weight: 600;">${escapeHtml(tim.iqamah)}</div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      </div>
    `;

    // Event listeners
    document.getElementById('dash-btn-donation').addEventListener('click', () => openDonationModal());
    document.getElementById('dash-btn-expense').addEventListener('click', () => openExpenseModal());
    document.getElementById('dash-btn-verify').addEventListener('click', () => runIntegrityVerification());
    document.getElementById('dash-go-madrasa').addEventListener('click', () => {
      State.activeTab = 'madrasa';
      renderCurrentView();
    });
  }

  // ==========================================================================
  // Tab 2: Finance & Cryptographic Ledger
  // ==========================================================================

  function renderFinanceTab(container, mosqueMeta, mosqueData) {
    const ledger = mosqueData.ledger || [];
    const balances = calculateFundBalances(ledger);

    container.innerHTML = `
      <div class="card-header">
        <div>
          <h2 class="card-title">💰 ${escapeHtml(t('financeTitle'))}</h2>
          <p class="card-subtitle">${escapeHtml(t('financeSubtitle'))}</p>
        </div>
        <div style="display: flex; gap: 8px; flex-wrap: wrap;">
          <button type="button" id="fin-btn-donation" class="btn btn-primary">
            ➕ ${escapeHtml(t('btnNewDonation'))}
          </button>
          <button type="button" id="fin-btn-expense" class="btn btn-secondary">
            ➖ ${escapeHtml(t('btnNewExpense'))}
          </button>
          <button type="button" id="fin-btn-verify" class="btn btn-outline">
            🔍 ${escapeHtml(t('btnVerifyLedger'))}
          </button>
        </div>
      </div>

      <!-- Integrity Status Banner (injected on verify) -->
      <div id="integrity-status-banner"></div>

      <!-- Ledger Table -->
      <div class="card">
        <h3 style="margin-bottom: 12px; font-weight: 700;">${escapeHtml(t('recentTransactionsTitle'))} (${ledger.length} Blocks)</h3>
        ${ledger.length === 0 ? `<p style="color: var(--text-muted);">${escapeHtml(t('ledgerEmpty'))}</p>` : `
          <div class="table-responsive">
            <table class="data-table">
              <thead>
                <tr>
                  <th>${escapeHtml(t('thSeq'))}</th>
                  <th>${escapeHtml(t('thDate'))}</th>
                  <th>${escapeHtml(t('thType'))}</th>
                  <th>${escapeHtml(t('thFund'))}</th>
                  <th>${escapeHtml(t('thDetails'))}</th>
                  <th>${escapeHtml(t('thAmount'))}</th>
                  <th>${escapeHtml(t('thReceipt'))}</th>
                  <th>${escapeHtml(t('thHash'))}</th>
                  <th>${escapeHtml(t('thAction'))}</th>
                </tr>
              </thead>
              <tbody>
                ${ledger.slice().reverse().map(entry => {
                  const isReversal = entry.type === 'reversal';
                  const isReversed = ledger.some(e => e.type === 'reversal' && e.reversesSeq === entry.seq);
                  const rowClass = isReversed ? 'row-reversed' : (isReversal ? 'row-reversal' : '');

                  let typeLabel = '';
                  let amtClass = '';
                  if (entry.type === 'donation') {
                    typeLabel = '📥 ' + t('typeDonation');
                    amtClass = 'amount-positive';
                  } else if (entry.type === 'expense') {
                    typeLabel = '📤 ' + t('typeExpense');
                    amtClass = 'amount-negative';
                  } else {
                    typeLabel = '🔄 ' + t('typeReversal');
                    amtClass = 'amount-negative';
                  }

                  return `
                    <tr class="${rowClass}">
                      <td><strong>#${entry.seq}</strong></td>
                      <td style="white-space: nowrap;">${escapeHtml(entry.date)}</td>
                      <td>
                        <span class="metric-card-badge ${entry.type === 'donation' ? 'badge-general' : 'badge-zakat'}">
                          ${escapeHtml(typeLabel)}
                        </span>
                        ${isReversed ? `<div style="font-size: 0.75rem; color: var(--danger); font-weight: 700;">(Reversed)</div>` : ''}
                      </td>
                      <td>${escapeHtml(getFundName(entry.fundId, mosqueData))}</td>
                      <td>
                        <div><strong>${escapeHtml(entry.category || '')}</strong></div>
                        <div style="font-size: 0.8rem; color: var(--text-muted);">
                          ${entry.type === 'donation' ? (escapeHtml(entry.donorName || t('anonymousDonor')) + ' • ' + escapeHtml(entry.method)) : escapeHtml(entry.note || '')}
                        </div>
                      </td>
                      <td class="${amtClass}">
                        ${entry.type === 'expense' ? '-' : '+'}${escapeHtml(formatCurrency(entry.amount))}
                      </td>
                      <td>
                        ${entry.receiptNo ? `
                          <button type="button" class="btn btn-outline btn-sm view-receipt-btn" data-seq="${entry.seq}">
                            🧾 ${escapeHtml(entry.receiptNo)}
                          </button>
                        ` : '-'}
                      </td>
                      <td>
                        <span class="hash-badge" title="${escapeHtml(entry.hash)}">
                          ${escapeHtml(entry.hash.substring(0, 12))}...
                        </span>
                      </td>
                      <td>
                        ${(!isReversed && !isReversal && (State.currentUser.role === 'admin' || State.currentUser.role === 'treasurer')) ? `
                          <button type="button" class="btn btn-danger btn-sm reverse-btn" data-seq="${entry.seq}">
                            ${escapeHtml(t('btnReverseEntry'))}
                          </button>
                        ` : '-'}
                      </td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
        `}
      </div>
    `;

    // Event listeners
    document.getElementById('fin-btn-donation').addEventListener('click', () => openDonationModal());
    document.getElementById('fin-btn-expense').addEventListener('click', () => openExpenseModal());
    document.getElementById('fin-btn-verify').addEventListener('click', () => runIntegrityVerification());

    // Receipt buttons
    container.querySelectorAll('.view-receipt-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const seq = Number(btn.getAttribute('data-seq'));
        const entry = ledger.find(e => e.seq === seq);
        if (entry) openReceiptModal(entry);
      });
    });

    // Reversal buttons
    container.querySelectorAll('.reverse-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const seq = Number(btn.getAttribute('data-seq'));
        openReversalModal(seq);
      });
    });
  }

  // ==========================================================================
  // Tab 3: Madrasa Management
  // ==========================================================================

  function renderMadrasaTab(container, mosqueMeta, mosqueData) {
    const students = mosqueData.students || [];
    const feePayments = mosqueData.feePayments || [];
    const currentMonth = getISTMonth();

    container.innerHTML = `
      <div class="card-header">
        <div>
          <h2 class="card-title">📖 ${escapeHtml(t('madrasaTitle'))}</h2>
          <p class="card-subtitle">${escapeHtml(t('madrasaSubtitle'))}</p>
        </div>
        <div style="display: flex; gap: 8px;">
          <button type="button" id="madrasa-tab-students" class="btn ${State.activeMadrasaSubTab === 'students' ? 'btn-primary' : 'btn-outline'} btn-sm">
            👥 ${escapeHtml(t('tabStudents'))}
          </button>
          <button type="button" id="madrasa-tab-attendance" class="btn ${State.activeMadrasaSubTab === 'attendance' ? 'btn-primary' : 'btn-outline'} btn-sm">
            📝 ${escapeHtml(t('tabAttendance'))}
          </button>
        </div>
      </div>

      <div id="madrasa-subtab-container"></div>
    `;

    document.getElementById('madrasa-tab-students').addEventListener('click', () => {
      State.activeMadrasaSubTab = 'students';
      renderCurrentView();
    });

    document.getElementById('madrasa-tab-attendance').addEventListener('click', () => {
      State.activeMadrasaSubTab = 'attendance';
      renderCurrentView();
    });

    const subContainer = document.getElementById('madrasa-subtab-container');
    if (State.activeMadrasaSubTab === 'students') {
      renderMadrasaStudentsSubTab(subContainer, mosqueData, currentMonth);
    } else {
      renderMadrasaAttendanceSubTab(subContainer, mosqueData);
    }
  }

  function renderMadrasaStudentsSubTab(subContainer, mosqueData, currentMonth) {
    const students = mosqueData.students || [];
    const feePayments = mosqueData.feePayments || [];

    // Calculate dues
    const paidStudentIds = feePayments.filter(f => f.month === currentMonth).map(f => f.studentId);
    const unpaidStudents = students.filter(s => !paidStudentIds.includes(s.id));
    const pendingDuesTotal = unpaidStudents.reduce((sum, s) => sum + (Number(s.monthlyFee) || 0), 0);

    subContainer.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; flex-wrap: wrap; gap: 10px;">
        <div style="font-size: 0.95rem; font-weight: 700; color: ${unpaidStudents.length > 0 ? 'var(--gold)' : 'var(--success)'};">
          ⚠️ ${escapeHtml(t('totalPendingDues', { count: unpaidStudents.length, amount: formatCurrency(pendingDuesTotal) }))}
        </div>
        <button type="button" id="btn-add-student" class="btn btn-primary btn-sm">
          ➕ ${escapeHtml(t('btnAddStudent'))}
        </button>
      </div>

      <div class="card">
        <h3 style="margin-bottom: 12px; font-weight: 700;">${escapeHtml(t('studentsListTitle'))}</h3>
        ${students.length === 0 ? `<p style="color: var(--text-muted);">No students enrolled yet.</p>` : `
          <div class="table-responsive">
            <table class="data-table">
              <thead>
                <tr>
                  <th>${escapeHtml(t('thStudentName'))}</th>
                  <th>${escapeHtml(t('thClass'))}</th>
                  <th>${escapeHtml(t('thFeeAmount'))}</th>
                  <th>${escapeHtml(t('thFeeStatus'))} (${currentMonth})</th>
                  <th>${escapeHtml(t('thActions'))}</th>
                </tr>
              </thead>
              <tbody>
                ${students.map(s => {
                  const isPaid = paidStudentIds.includes(s.id);
                  return `
                    <tr>
                      <td>
                        <strong>${escapeHtml(s.name)}</strong>
                        <div style="font-size: 0.8rem; color: var(--text-muted);">
                          Guardian: ${escapeHtml(s.guardianName || 'N/A')} • 📞 ${escapeHtml(s.phone || 'N/A')}
                        </div>
                      </td>
                      <td>${escapeHtml(s.className || 'General')}</td>
                      <td><strong>${escapeHtml(formatCurrency(s.monthlyFee))}</strong></td>
                      <td>
                        <span class="metric-card-badge ${isPaid ? 'badge-general' : 'badge-zakat'}">
                          ${isPaid ? '✅ ' + escapeHtml(t('feeStatusPaid', { month: currentMonth })) : '⚠️ ' + escapeHtml(t('feeStatusDue'))}
                        </span>
                      </td>
                      <td style="white-space: nowrap;">
                        ${!isPaid ? `
                          <button type="button" class="btn btn-primary btn-sm collect-fee-btn" data-id="${s.id}">
                            💳 ${escapeHtml(t('btnCollectFee'))}
                          </button>
                        ` : ''}
                        <button type="button" class="btn btn-outline btn-sm edit-student-btn" data-id="${s.id}">
                          ✏️ ${escapeHtml(t('btnEditStudent'))}
                        </button>
                        <button type="button" class="btn btn-danger btn-sm delete-student-btn" data-id="${s.id}">
                          🗑️
                        </button>
                      </td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
        `}
      </div>
    `;

    document.getElementById('btn-add-student').addEventListener('click', () => openStudentModal());

    subContainer.querySelectorAll('.collect-fee-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        openCollectFeeModal(id);
      });
    });

    subContainer.querySelectorAll('.edit-student-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        const std = students.find(s => s.id === id);
        if (std) openStudentModal(std);
      });
    });

    subContainer.querySelectorAll('.delete-student-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        if (requirePerm('madrasa') && confirm(t('confirmDelete'))) {
          mosqueData.students = students.filter(s => s.id !== id);
          saveMosqueData(State.currentMosqueId, mosqueData);
          showToast(t('msgSaved'), 'success');
          renderCurrentView();
        }
      });
    });
  }

  function renderMadrasaAttendanceSubTab(subContainer, mosqueData) {
    const students = mosqueData.students || [];
    let selectedDate = getISTDate();
    const attendanceMap = mosqueData.attendance || {};
    let dayRecords = attendanceMap[selectedDate] || {};

    subContainer.innerHTML = `
      <div class="card" style="margin-bottom: 16px;">
        <div style="display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap;">
          <div class="form-group" style="margin-bottom: 0;">
            <label class="form-label" for="att-date-picker">${escapeHtml(t('attendanceDateLabel'))}</label>
            <input type="date" id="att-date-picker" class="form-control" value="${selectedDate}" />
          </div>
          <button type="button" id="att-save-btn" class="btn btn-primary">
            💾 ${escapeHtml(t('btnSaveAttendance'))}
          </button>
        </div>
      </div>

      <div class="card">
        ${students.length === 0 ? `<p style="color: var(--text-muted);">Please enroll students first.</p>` : `
          <div class="table-responsive">
            <table class="data-table">
              <thead>
                <tr>
                  <th>${escapeHtml(t('thStudent'))}</th>
                  <th>${escapeHtml(t('thAttendanceStatus'))}</th>
                  <th>${escapeHtml(t('thSabaq'))}</th>
                  <th>${escapeHtml(t('thSabqi'))}</th>
                  <th>${escapeHtml(t('thManzil'))}</th>
                </tr>
              </thead>
              <tbody id="att-tbody">
                ${students.map(s => {
                  const rec = dayRecords[s.id] || { status: 'unmarked', sabaq: '', sabqi: '', manzil: '' };
                  return `
                    <tr data-student-id="${s.id}">
                      <td>
                        <strong>${escapeHtml(s.name)}</strong>
                        <div style="font-size: 0.8rem; color: var(--text-muted);">${escapeHtml(s.className || '')}</div>
                      </td>
                      <td>
                        <div class="attendance-pills">
                          <label>
                            <input type="radio" name="att_${s.id}" value="present" class="attendance-pill-input" ${rec.status === 'present' ? 'checked' : ''} />
                            <span class="attendance-pill-label present">✓ ${escapeHtml(t('statusPresent'))}</span>
                          </label>
                          <label>
                            <input type="radio" name="att_${s.id}" value="absent" class="attendance-pill-input" ${rec.status === 'absent' ? 'checked' : ''} />
                            <span class="attendance-pill-label absent">✗ ${escapeHtml(t('statusAbsent'))}</span>
                          </label>
                        </div>
                      </td>
                      <td>
                        <input type="text" class="form-control sabaq-input" value="${escapeHtml(rec.sabaq || '')}" placeholder="${escapeHtml(t('placeholderSabaq'))}" style="min-height: 38px;" />
                      </td>
                      <td>
                        <input type="text" class="form-control sabqi-input" value="${escapeHtml(rec.sabqi || '')}" placeholder="${escapeHtml(t('placeholderSabqi'))}" style="min-height: 38px;" />
                      </td>
                      <td>
                        <input type="text" class="form-control manzil-input" value="${escapeHtml(rec.manzil || '')}" placeholder="${escapeHtml(t('placeholderManzil'))}" style="min-height: 38px;" />
                      </td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
        `}
      </div>
    `;

    const datePicker = document.getElementById('att-date-picker');
    datePicker.addEventListener('change', (e) => {
      selectedDate = e.target.value;
      dayRecords = attendanceMap[selectedDate] || {};
      // Re-populate inputs for chosen date
      students.forEach(s => {
        const rec = dayRecords[s.id] || { status: 'unmarked', sabaq: '', sabqi: '', manzil: '' };
        const row = subContainer.querySelector(`tr[data-student-id="${s.id}"]`);
        if (row) {
          const radio = row.querySelector(`input[name="att_${s.id}"][value="${rec.status}"]`);
          if (radio) radio.checked = true;
          row.querySelector('.sabaq-input').value = rec.sabaq || '';
          row.querySelector('.sabqi-input').value = rec.sabqi || '';
          row.querySelector('.manzil-input').value = rec.manzil || '';
        }
      });
    });

    document.getElementById('att-save-btn').addEventListener('click', () => {
      if (!requirePerm('madrasa')) return;
      const updatedDay = {};
      students.forEach(s => {
        const row = subContainer.querySelector(`tr[data-student-id="${s.id}"]`);
        if (row) {
          const selectedRadio = row.querySelector(`input[name="att_${s.id}"]:checked`);
          const status = selectedRadio ? selectedRadio.value : 'unmarked';
          const sabaq = row.querySelector('.sabaq-input').value.trim();
          const sabqi = row.querySelector('.sabqi-input').value.trim();
          const manzil = row.querySelector('.manzil-input').value.trim();
          updatedDay[s.id] = { status, sabaq, sabqi, manzil };
        }
      });

      mosqueData.attendance = mosqueData.attendance || {};
      mosqueData.attendance[selectedDate] = updatedDay;
      saveMosqueData(State.currentMosqueId, mosqueData);
      showToast(t('attendanceSavedSuccess', { date: selectedDate }), 'success');
    });
  }

  // ==========================================================================
  // Tab 4: Mosque Operations
  // ==========================================================================

  function renderMosqueOpsTab(container, mosqueMeta, mosqueData) {
    container.innerHTML = `
      <div class="card-header">
        <div>
          <h2 class="card-title">🕌 ${escapeHtml(t('opsTitle'))}</h2>
          <p class="card-subtitle">${escapeHtml(t('opsSubtitle'))}</p>
        </div>
        <div style="display: flex; gap: 6px; flex-wrap: wrap;">
          <button type="button" id="ops-tab-staff" class="btn ${State.activeOpsSubTab === 'staff' ? 'btn-primary' : 'btn-outline'} btn-sm">
            👥 ${escapeHtml(t('tabStaff'))}
          </button>
          <button type="button" id="ops-tab-nikah" class="btn ${State.activeOpsSubTab === 'nikahJanazah' ? 'btn-primary' : 'btn-outline'} btn-sm">
            📜 ${escapeHtml(t('tabNikahJanazah'))}
          </button>
          <button type="button" id="ops-tab-assets" class="btn ${State.activeOpsSubTab === 'assets' ? 'btn-primary' : 'btn-outline'} btn-sm">
            📦 ${escapeHtml(t('tabAssets'))}
          </button>
          <button type="button" id="ops-tab-notices" class="btn ${State.activeOpsSubTab === 'notices' ? 'btn-primary' : 'btn-outline'} btn-sm">
            📢 ${escapeHtml(t('tabNotices'))}
          </button>
        </div>
      </div>

      <div id="ops-subtab-container"></div>
    `;

    document.getElementById('ops-tab-staff').addEventListener('click', () => {
      State.activeOpsSubTab = 'staff';
      renderCurrentView();
    });
    document.getElementById('ops-tab-nikah').addEventListener('click', () => {
      State.activeOpsSubTab = 'nikahJanazah';
      renderCurrentView();
    });
    document.getElementById('ops-tab-assets').addEventListener('click', () => {
      State.activeOpsSubTab = 'assets';
      renderCurrentView();
    });
    document.getElementById('ops-tab-notices').addEventListener('click', () => {
      State.activeOpsSubTab = 'notices';
      renderCurrentView();
    });

    const sub = document.getElementById('ops-subtab-container');
    if (State.activeOpsSubTab === 'staff') {
      renderOpsStaffSubTab(sub, mosqueData);
    } else if (State.activeOpsSubTab === 'nikahJanazah') {
      renderOpsNikahJanazahSubTab(sub, mosqueData);
    } else if (State.activeOpsSubTab === 'assets') {
      renderOpsAssetsSubTab(sub, mosqueData);
    } else {
      renderOpsNoticesSubTab(sub, mosqueData, mosqueMeta);
    }
  }

  function renderOpsStaffSubTab(sub, mosqueData) {
    const staff = mosqueData.staff || [];
    const salaryPayments = mosqueData.salaryPayments || [];
    const currentMonth = getISTMonth();

    subContainerStaff(sub, staff, salaryPayments, currentMonth, mosqueData);
  }

  function subContainerStaff(sub, staff, salaryPayments, currentMonth, mosqueData) {
    sub.innerHTML = `
      <div style="display: flex; justify-content: flex-end; margin-bottom: 16px;">
        <button type="button" id="btn-add-staff" class="btn btn-primary btn-sm">
          ➕ ${escapeHtml(t('btnAddStaff'))}
        </button>
      </div>

      <div class="card">
        <h3 style="margin-bottom: 12px; font-weight: 700;">${escapeHtml(t('staffListTitle'))}</h3>
        ${staff.length === 0 ? `<p style="color: var(--text-muted);">No staff registered yet.</p>` : `
          <div class="table-responsive">
            <table class="data-table">
              <thead>
                <tr>
                  <th>${escapeHtml(t('thStaffName'))}</th>
                  <th>${escapeHtml(t('thSalaryAmount'))}</th>
                  <th>${escapeHtml(t('thSalaryStatus'))} (${currentMonth})</th>
                  <th>${escapeHtml(t('thActions'))}</th>
                </tr>
              </thead>
              <tbody>
                ${staff.map(st => {
                  const isPaid = salaryPayments.some(p => p.staffId === st.id && p.month === currentMonth);
                  return `
                    <tr>
                      <td>
                        <strong>${escapeHtml(st.name)}</strong>
                        <div style="font-size: 0.8rem; color: var(--text-muted);">
                          ${escapeHtml(st.role)} • 📞 ${escapeHtml(st.phone || 'N/A')}
                        </div>
                      </td>
                      <td><strong>${escapeHtml(formatCurrency(st.monthlySalary))}</strong></td>
                      <td>
                        <span class="metric-card-badge ${isPaid ? 'badge-general' : 'badge-zakat'}">
                          ${isPaid ? '✅ ' + escapeHtml(t('salaryPaidBadge', { month: currentMonth })) : '⚠️ ' + escapeHtml(t('salaryDueBadge', { month: currentMonth }))}
                        </span>
                      </td>
                      <td style="white-space: nowrap;">
                        ${!isPaid ? `
                          <button type="button" class="btn btn-primary btn-sm pay-salary-btn" data-id="${st.id}">
                            💵 ${escapeHtml(t('btnPaySalary'))}
                          </button>
                        ` : ''}
                        <button type="button" class="btn btn-outline btn-sm edit-staff-btn" data-id="${st.id}">
                          ✏️ ${escapeHtml(t('btnEditStaff'))}
                        </button>
                        <button type="button" class="btn btn-danger btn-sm delete-staff-btn" data-id="${st.id}">
                          🗑️
                        </button>
                      </td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
        `}
      </div>
    `;

    document.getElementById('btn-add-staff').addEventListener('click', () => openStaffModal());

    sub.querySelectorAll('.pay-salary-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        openPaySalaryModal(id);
      });
    });

    sub.querySelectorAll('.edit-staff-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        const st = staff.find(s => s.id === id);
        if (st) openStaffModal(st);
      });
    });

    sub.querySelectorAll('.delete-staff-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        if (requirePerm('ops') && confirm(t('confirmDelete'))) {
          mosqueData.staff = staff.filter(s => s.id !== id);
          saveMosqueData(State.currentMosqueId, mosqueData);
          showToast(t('msgSaved'), 'success');
          renderCurrentView();
        }
      });
    });
  }

  function renderOpsNikahJanazahSubTab(sub, mosqueData) {
    const nikahList = mosqueData.nikah || [];
    const janazahList = mosqueData.janazah || [];

    sub.innerHTML = `
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px;">
        <!-- Nikah Register -->
        <div class="card">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
            <h3 class="card-title">📜 ${escapeHtml(t('nikahTitle'))}</h3>
            <button type="button" id="btn-add-nikah" class="btn btn-primary btn-sm">➕ ${escapeHtml(t('btnAddNikah'))}</button>
          </div>
          ${nikahList.length === 0 ? `<p style="color: var(--text-muted);">No records registered.</p>` : `
            <div class="table-responsive">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>${escapeHtml(t('thGroomBride'))}</th>
                    <th>${escapeHtml(t('thNikahDate'))}</th>
                    <th>${escapeHtml(t('thMahr'))}</th>
                    <th>${escapeHtml(t('thAction'))}</th>
                  </tr>
                </thead>
                <tbody>
                  ${nikahList.map(n => `
                    <tr>
                      <td>
                        <strong>${escapeHtml(n.groom)}</strong> &amp; <strong>${escapeHtml(n.bride)}</strong>
                        <div style="font-size: 0.75rem; color: var(--text-muted);">${escapeHtml(n.waliWitnesses || '')}</div>
                      </td>
                      <td>${escapeHtml(n.date)}</td>
                      <td>${escapeHtml(n.mahr)}</td>
                      <td>
                        <button type="button" class="btn btn-danger btn-sm del-nikah-btn" data-id="${n.id}">🗑️</button>
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          `}
        </div>

        <!-- Janazah Register -->
        <div class="card">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
            <h3 class="card-title">⚰️ ${escapeHtml(t('janazahTitle'))}</h3>
            <button type="button" id="btn-add-janazah" class="btn btn-primary btn-sm">➕ ${escapeHtml(t('btnAddJanazah'))}</button>
          </div>
          ${janazahList.length === 0 ? `<p style="color: var(--text-muted);">No records registered.</p>` : `
            <div class="table-responsive">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>${escapeHtml(t('thDeceased'))}</th>
                    <th>${escapeHtml(t('thDemiseDate'))}</th>
                    <th>${escapeHtml(t('thJanazahTime'))}</th>
                    <th>${escapeHtml(t('thAction'))}</th>
                  </tr>
                </thead>
                <tbody>
                  ${janazahList.map(j => `
                    <tr>
                      <td>
                        <strong>${escapeHtml(j.deceased)}</strong> (${escapeHtml(j.age)} yrs)
                        <div style="font-size: 0.75rem; color: var(--text-muted);">${escapeHtml(j.burialPlace || '')}</div>
                      </td>
                      <td>${escapeHtml(j.demiseDate)}</td>
                      <td>${escapeHtml(j.janazahTime)}</td>
                      <td>
                        <button type="button" class="btn btn-danger btn-sm del-janazah-btn" data-id="${j.id}">🗑️</button>
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          `}
        </div>
      </div>
    `;

    document.getElementById('btn-add-nikah').addEventListener('click', () => openNikahModal());
    document.getElementById('btn-add-janazah').addEventListener('click', () => openJanazahModal());

    sub.querySelectorAll('.del-nikah-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (requirePerm('ops') && confirm(t('confirmDelete'))) {
          mosqueData.nikah = nikahList.filter(n => n.id !== btn.getAttribute('data-id'));
          saveMosqueData(State.currentMosqueId, mosqueData);
          renderCurrentView();
        }
      });
    });

    sub.querySelectorAll('.del-janazah-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (requirePerm('ops') && confirm(t('confirmDelete'))) {
          mosqueData.janazah = janazahList.filter(j => j.id !== btn.getAttribute('data-id'));
          saveMosqueData(State.currentMosqueId, mosqueData);
          renderCurrentView();
        }
      });
    });
  }

  function renderOpsAssetsSubTab(sub, mosqueData) {
    const assets = mosqueData.assets || [];

    sub.innerHTML = `
      <div style="display: flex; justify-content: flex-end; margin-bottom: 16px;">
        <button type="button" id="btn-add-asset" class="btn btn-primary btn-sm">
          ➕ ${escapeHtml(t('btnAddAsset'))}
        </button>
      </div>

      <div class="card">
        <h3 style="margin-bottom: 12px; font-weight: 700;">${escapeHtml(t('assetsTitle'))}</h3>
        ${assets.length === 0 ? `<p style="color: var(--text-muted);">No assets recorded yet.</p>` : `
          <div class="table-responsive">
            <table class="data-table">
              <thead>
                <tr>
                  <th>${escapeHtml(t('thAssetName'))}</th>
                  <th>${escapeHtml(t('thAssetValue'))}</th>
                  <th>${escapeHtml(t('thAssetCondition'))}</th>
                  <th>${escapeHtml(t('thAssetDate'))}</th>
                  <th>${escapeHtml(t('thAction'))}</th>
                </tr>
              </thead>
              <tbody>
                ${assets.map(a => `
                  <tr>
                    <td>
                      <strong>${escapeHtml(a.name)}</strong>
                      <div style="font-size: 0.8rem; color: var(--text-muted);">${escapeHtml(a.location)}</div>
                    </td>
                    <td><strong>${escapeHtml(formatCurrency(a.value))}</strong></td>
                    <td>
                      <span class="metric-card-badge ${a.condition.includes('Good') ? 'badge-general' : 'badge-zakat'}">
                        ${escapeHtml(a.condition)}
                      </span>
                    </td>
                    <td>${escapeHtml(a.acquiredDate || 'N/A')}</td>
                    <td>
                      <button type="button" class="btn btn-danger btn-sm del-asset-btn" data-id="${a.id}">🗑️</button>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        `}
      </div>
    `;

    document.getElementById('btn-add-asset').addEventListener('click', () => openAssetModal());

    sub.querySelectorAll('.del-asset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (requirePerm('ops') && confirm(t('confirmDelete'))) {
          mosqueData.assets = assets.filter(a => a.id !== btn.getAttribute('data-id'));
          saveMosqueData(State.currentMosqueId, mosqueData);
          renderCurrentView();
        }
      });
    });
  }

  function renderOpsNoticesSubTab(sub, mosqueData, mosqueMeta) {
    const notices = mosqueData.notices || [];

    sub.innerHTML = `
      <div style="display: flex; justify-content: flex-end; margin-bottom: 16px;">
        <button type="button" id="btn-add-notice" class="btn btn-primary btn-sm">
          ➕ ${escapeHtml(t('btnAddNotice'))}
        </button>
      </div>

      <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px;">
        ${notices.length === 0 ? `<p style="color: var(--text-muted);">${escapeHtml(t('noNoticesYet'))}</p>` : notices.map(n => {
          const waUrl = 'https://api.whatsapp.com/send?text=' + encodeURIComponent(
            t('waNoticeTemplate', {
              mosqueName: mosqueMeta.name,
              title: n.title,
              content: n.content,
              date: n.date,
              address: mosqueMeta.location
            })
          );
          return `
            <div class="card" style="margin-bottom: 0;">
              <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
                <h4 style="font-weight: 700; color: var(--primary); font-size: 1.05rem;">${escapeHtml(n.title)}</h4>
                <button type="button" class="btn btn-danger btn-sm del-notice-btn" data-id="${n.id}" style="padding: 2px 6px; min-height: 28px;">✕</button>
              </div>
              <p style="font-size: 0.9rem; line-height: 1.5; color: var(--text-main); margin-bottom: 12px;">
                ${escapeHtml(n.content)}
              </p>
              <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid var(--border-subtle); padding-top: 10px; font-size: 0.8rem; color: var(--text-muted);">
                <span>📅 ${escapeHtml(n.date)}</span>
                <a href="${waUrl}" target="_blank" rel="noopener noreferrer" class="btn btn-whatsapp btn-sm" style="text-decoration: none;">
                  💬 WhatsApp
                </a>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;

    document.getElementById('btn-add-notice').addEventListener('click', () => openNoticeModal());

    sub.querySelectorAll('.del-notice-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (requirePerm('ops') && confirm(t('confirmDelete'))) {
          mosqueData.notices = notices.filter(n => n.id !== btn.getAttribute('data-id'));
          saveMosqueData(State.currentMosqueId, mosqueData);
          renderCurrentView();
        }
      });
    });
  }

  // ==========================================================================
  // Tab 5: Printable Monthly PDF Report
  // ==========================================================================

  function renderReportsTab(container, mosqueMeta, mosqueData) {
    let selectedMonth = getISTMonth();
    const ledger = mosqueData.ledger || [];

    function generateReportData(monthStr) {
      // Filter transactions belonging to selectedMonth (YYYY-MM)
      const monthEntries = ledger.filter(e => e.date && e.date.startsWith(monthStr));
      const priorEntries = ledger.filter(e => e.date && e.date < monthStr);

      const openingBalances = calculateFundBalances(priorEntries);
      const openingTotal = Object.values(openingBalances).reduce((a, b) => a + b, 0);

      let inflow = 0;
      let outflow = 0;

      monthEntries.forEach(e => {
        const amt = Number(e.amount) || 0;
        if (e.type === 'donation') inflow += amt;
        else if (e.type === 'expense') outflow += amt;
        else if (e.type === 'reversal') {
          if (e.reversesType === 'donation') inflow -= amt;
          else if (e.reversesType === 'expense') outflow -= amt;
        }
      });

      const closingTotal = openingTotal + inflow - outflow;
      return { monthEntries, openingTotal, inflow, outflow, closingTotal };
    }

    let report = generateReportData(selectedMonth);

    container.innerHTML = `
      <div class="card-header no-print">
        <div>
          <h2 class="card-title">📑 ${escapeHtml(t('reportTitle'))}</h2>
          <p class="card-subtitle">${escapeHtml(t('reportSubtitle'))}</p>
        </div>
        <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
          <input type="month" id="report-month-picker" class="form-control" value="${selectedMonth}" style="width: auto; min-height: 40px;" />
          <button type="button" id="report-print-btn" class="btn btn-primary">
            🖨️ ${escapeHtml(t('btnPrintReport'))}
          </button>
        </div>
      </div>

      <!-- Printable Report Container -->
      <div id="printable-report-wrapper" class="card">
        <!-- Print Header -->
        <div style="text-align: center; border-bottom: 2px solid #000; padding-bottom: 12px; margin-bottom: 16px;">
          <h1 style="font-size: 1.5rem; font-weight: 800; color: var(--primary);">${escapeHtml(mosqueMeta.name)}</h1>
          <p style="font-size: 0.95rem;">${escapeHtml(mosqueMeta.address || mosqueMeta.location)}</p>
          ${mosqueMeta.registrationNo ? `<p style="font-size: 0.85rem;">Registration / Waqf No: <strong>${escapeHtml(mosqueMeta.registrationNo)}</strong></p>` : ''}
          <h2 style="font-size: 1.2rem; font-weight: 700; margin-top: 10px;">
            ${escapeHtml(t('reportTitle'))} — ${selectedMonth} (IST)
          </h2>
          <div style="font-size: 0.8rem; color: var(--text-muted);">
            ${escapeHtml(t('reportSignDate', { date: getISTTimestamp() }))}
          </div>
        </div>

        <!-- 4 Key Summary Numbers -->
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 20px; text-align: center;">
          <div style="border: 1px solid var(--border-color); padding: 10px; border-radius: var(--radius-sm);">
            <div style="font-size: 0.75rem; color: var(--text-muted); font-weight: 700;">${escapeHtml(t('reportOpeningBalance'))}</div>
            <div style="font-size: 1.25rem; font-weight: 800;" id="rep-open">${escapeHtml(formatCurrency(report.openingTotal))}</div>
          </div>
          <div style="border: 1px solid var(--border-color); padding: 10px; border-radius: var(--radius-sm); color: var(--success);">
            <div style="font-size: 0.75rem; font-weight: 700;">${escapeHtml(t('reportInflow'))}</div>
            <div style="font-size: 1.25rem; font-weight: 800;" id="rep-inflow">+${escapeHtml(formatCurrency(report.inflow))}</div>
          </div>
          <div style="border: 1px solid var(--border-color); padding: 10px; border-radius: var(--radius-sm); color: var(--danger);">
            <div style="font-size: 0.75rem; font-weight: 700;">${escapeHtml(t('reportOutflow'))}</div>
            <div style="font-size: 1.25rem; font-weight: 800;" id="rep-outflow">-${escapeHtml(formatCurrency(report.outflow))}</div>
          </div>
          <div style="border: 1px solid var(--border-color); padding: 10px; border-radius: var(--radius-sm); background: var(--primary-light);">
            <div style="font-size: 0.75rem; color: var(--primary); font-weight: 700;">${escapeHtml(t('reportClosingBalance'))}</div>
            <div style="font-size: 1.25rem; font-weight: 800; color: var(--primary);" id="rep-closing">${escapeHtml(formatCurrency(report.closingTotal))}</div>
          </div>
        </div>

        <!-- Monthly Detailed Ledger Table -->
        <h4 style="margin-bottom: 8px; font-weight: 700;">${escapeHtml(t('reportDetailedLedger'))}</h4>
        <div id="rep-table-container">
          ${renderReportTableHtml(report.monthEntries, mosqueData)}
        </div>

        <!-- Signatures Box for Print PDF -->
        <div style="display: flex; justify-content: space-between; margin-top: 40px; padding-top: 20px; border-top: 1px dotted #888;">
          <div style="text-align: center; width: 200px;">
            <div style="border-bottom: 1px solid #000; height: 40px;"></div>
            <div style="font-size: 0.85rem; font-weight: 700; margin-top: 6px;">Mutawalli / President</div>
          </div>
          <div style="text-align: center; width: 200px;">
            <div style="border-bottom: 1px solid #000; height: 40px;"></div>
            <div style="font-size: 0.85rem; font-weight: 700; margin-top: 6px;">Treasurer / Secretary</div>
          </div>
          <div style="text-align: center; width: 200px;">
            <div style="border-bottom: 1px solid #000; height: 40px;"></div>
            <div style="font-size: 0.85rem; font-weight: 700; margin-top: 6px;">Auditor / Stamp</div>
          </div>
        </div>
      </div>
    `;

    function renderReportTableHtml(entries, mData) {
      if (!entries || entries.length === 0) {
        return `<p style="color: var(--text-muted); padding: 12px 0;">${escapeHtml(t('reportNoData'))}</p>`;
      }
      return `
        <div class="table-responsive">
          <table class="data-table">
            <thead>
              <tr>
                <th>Block #</th>
                <th>Date &amp; Time (IST)</th>
                <th>Type</th>
                <th>Fund</th>
                <th>Category / Details</th>
                <th>Amount (₹)</th>
                <th>Receipt #</th>
                <th>SHA-256 Digest</th>
              </tr>
            </thead>
            <tbody>
              ${entries.map(e => `
                <tr>
                  <td>#${e.seq}</td>
                  <td style="white-space: nowrap;">${escapeHtml(e.date)}</td>
                  <td>${escapeHtml(e.type)}</td>
                  <td>${escapeHtml(getFundName(e.fundId, mData))}</td>
                  <td>${escapeHtml(e.category)} ${e.note ? `(${escapeHtml(e.note)})` : ''}</td>
                  <td><strong>${escapeHtml(formatCurrency(e.amount))}</strong></td>
                  <td>${escapeHtml(e.receiptNo || '-')}</td>
                  <td><span class="hash-badge">${escapeHtml(e.hash.substring(0, 10))}...</span></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `;
    }

    const monthPicker = document.getElementById('report-month-picker');
    monthPicker.addEventListener('change', (e) => {
      selectedMonth = e.target.value;
      report = generateReportData(selectedMonth);
      document.getElementById('rep-open').textContent = formatCurrency(report.openingTotal);
      document.getElementById('rep-inflow').textContent = '+' + formatCurrency(report.inflow);
      document.getElementById('rep-outflow').textContent = '-' + formatCurrency(report.outflow);
      document.getElementById('rep-closing').textContent = formatCurrency(report.closingTotal);
      document.getElementById('rep-table-container').innerHTML = renderReportTableHtml(report.monthEntries, mosqueData);
    });

    document.getElementById('report-print-btn').addEventListener('click', () => {
      window.print();
    });
  }

  // ==========================================================================
  // Tab 6: Settings (Mosque Profile, Custom Funds, Privacy, Salah)
  // ==========================================================================

  function renderSettingsTab(container, mosqueMeta, mosqueData) {
    const customFunds = mosqueData.customFunds || [];
    const settings = mosqueMeta.settings || CFG.DEFAULT_PUBLIC_SETTINGS;
    const salah = mosqueData.salahTimings || {};

    container.innerHTML = `
      <div class="card-header">
        <div>
          <h2 class="card-title">⚙️ ${escapeHtml(t('settingsTitle'))}</h2>
          <p class="card-subtitle">${escapeHtml(t('settingsSubtitle'))}</p>
        </div>
      </div>

      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px;">
        <!-- Mosque Profile Form -->
        <div class="card">
          <h3 class="card-title">🏢 ${escapeHtml(t('sectionMosqueDetails'))}</h3>
          <form id="form-settings-profile">
            <div class="form-group">
              <label class="form-label">${escapeHtml(t('labelMosqueName'))}</label>
              <input type="text" id="set-mosque-name" class="form-control" value="${escapeHtml(mosqueMeta.name)}" required />
            </div>
            <div class="form-group">
              <label class="form-label">${escapeHtml(t('labelAddress'))}</label>
              <input type="text" id="set-mosque-address" class="form-control" value="${escapeHtml(mosqueMeta.address || mosqueMeta.location)}" required />
            </div>
            <div class="form-group">
              <label class="form-label">${escapeHtml(t('labelRegistrationNo'))}</label>
              <input type="text" id="set-mosque-reg" class="form-control" value="${escapeHtml(mosqueMeta.registrationNo || '')}" placeholder="e.g. WB-WAQF-2021-9981" />
            </div>
            <button type="submit" class="btn btn-primary btn-sm">
              💾 ${escapeHtml(t('btnSaveProfile'))}
            </button>
          </form>
        </div>

        <!-- Public Explorer Privacy Settings -->
        <div class="card">
          <h3 class="card-title">🔒 ${escapeHtml(t('sectionPrivacy'))}</h3>
          <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 12px;">
            Control what level of granular detail is exposed in the Public Ledger Explorer. Donor names and phone numbers are permanently confidential.
          </p>
          <form id="form-settings-privacy">
            <div class="form-group" style="flex-direction: row; align-items: center; gap: 10px;">
              <input type="checkbox" id="set-priv-salary" style="width: 20px; height: 20px;" ${settings.showSalaryInPublic ? 'checked' : ''} />
              <label class="form-label" for="set-priv-salary" style="margin-bottom: 0; cursor: pointer;">
                ${escapeHtml(t('privacySalaryLabel'))}
              </label>
            </div>
            <div class="form-group" style="flex-direction: row; align-items: center; gap: 10px;">
              <input type="checkbox" id="set-priv-bill" style="width: 20px; height: 20px;" ${settings.showBillPhotosInPublic ? 'checked' : ''} />
              <label class="form-label" for="set-priv-bill" style="margin-bottom: 0; cursor: pointer;">
                ${escapeHtml(t('privacyBillLabel'))}
              </label>
            </div>
            <button type="submit" class="btn btn-primary btn-sm" style="margin-top: 10px;">
              💾 ${escapeHtml(t('btnSavePrivacy'))}
            </button>
          </form>
        </div>
      </div>

      <!-- Daily Salah Timings -->
      <div class="card" style="margin-top: 16px;">
        <h3 class="card-title">⏰ ${escapeHtml(t('salahTimingsTitle'))}</h3>
        <form id="form-settings-salah">
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 16px;">
            ${CFG.SALAH_PRAYERS.map(sp => {
              const current = salah[sp.id] || { adhan: '05:00', iqamah: '05:30' };
              return `
                <div style="background: var(--bg-app); padding: 10px; border-radius: var(--radius-sm); border: 1px solid var(--border-subtle);">
                  <div style="font-weight: 700; margin-bottom: 6px;">${escapeHtml(t(sp.nameKey))}</div>
                  <div class="form-group" style="margin-bottom: 6px;">
                    <label style="font-size: 0.75rem;">${escapeHtml(t('salahAdhan'))}</label>
                    <input type="time" class="form-control" name="${sp.id}_adhan" value="${current.adhan}" style="min-height: 36px; padding: 4px;" />
                  </div>
                  <div class="form-group" style="margin-bottom: 0;">
                    <label style="font-size: 0.75rem; font-weight: 700; color: var(--primary);">${escapeHtml(t('salahIqamah'))}</label>
                    <input type="time" class="form-control" name="${sp.id}_iqamah" value="${current.iqamah}" style="min-height: 36px; padding: 4px; font-weight: 700;" />
                  </div>
                </div>
              `;
            }).join('')}
          </div>
          <button type="submit" class="btn btn-primary btn-sm">
            💾 ${escapeHtml(t('btnSaveSalah'))}
          </button>
        </form>
      </div>

      <!-- Custom Financial Funds -->
      <div class="card" style="margin-top: 16px;">
        <h3 class="card-title">🏷️ ${escapeHtml(t('sectionCustomFunds'))}</h3>
        <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 12px;">
          ${escapeHtml(t('customFundsDesc'))}
        </p>

        <form id="form-add-custom-fund" style="display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; margin-bottom: 16px;">
          <div class="form-group" style="flex: 2; min-width: 220px; margin-bottom: 0;">
            <label class="form-label">${escapeHtml(t('labelNewFundName'))}</label>
            <input type="text" id="new-fund-name" class="form-control" placeholder="${escapeHtml(t('placeholderNewFundName'))}" required />
          </div>
          <div class="form-group" style="flex: 1; min-width: 200px; margin-bottom: 0; display: flex; flex-direction: row; align-items: center; gap: 8px;">
            <input type="checkbox" id="new-fund-zakat" style="width: 20px; height: 20px;" />
            <label class="form-label" for="new-fund-zakat" style="margin-bottom: 0; cursor: pointer; font-size: 0.85rem;">
              ${escapeHtml(t('labelIsZakatEligible'))}
            </label>
          </div>
          <button type="submit" class="btn btn-primary btn-sm">
            ➕ ${escapeHtml(t('btnAddCustomFund'))}
          </button>
        </form>

        <div style="font-size: 0.9rem;">
          <h4 style="font-weight: 700; margin-bottom: 6px;">Active Funds:</h4>
          <ul style="list-style: none; padding: 0;">
            ${getMosqueFunds(mosqueData).map(f => `
              <li style="padding: 6px 0; border-bottom: 1px solid var(--border-subtle); display: flex; justify-content: space-between; align-items: center;">
                <span>${escapeHtml(getFundName(f.id, mosqueData))}</span>
                <span class="metric-card-badge ${f.isZakatEligible ? 'badge-zakat' : 'badge-general'}">
                  ${f.isZakatEligible ? t('zakatRestrictedBadge') : t('generalFundBadge')}
                </span>
              </li>
            `).join('')}
          </ul>
        </div>
      </div>
    `;

    // Listeners
    document.getElementById('form-settings-profile').addEventListener('submit', (e) => {
      e.preventDefault();
      mosqueMeta.name = document.getElementById('set-mosque-name').value.trim();
      mosqueMeta.address = document.getElementById('set-mosque-address').value.trim();
      mosqueMeta.registrationNo = document.getElementById('set-mosque-reg').value.trim();
      const catalog = getMosquesCatalog();
      const idx = catalog.findIndex(m => m.id === mosqueMeta.id);
      if (idx !== -1) catalog[idx] = mosqueMeta;
      saveMosquesCatalog(catalog);
      showToast(t('msgSaved'), 'success');
      renderCurrentView();
    });

    document.getElementById('form-settings-privacy').addEventListener('submit', (e) => {
      e.preventDefault();
      mosqueMeta.settings = mosqueMeta.settings || {};
      mosqueMeta.settings.showSalaryInPublic = document.getElementById('set-priv-salary').checked;
      mosqueMeta.settings.showBillPhotosInPublic = document.getElementById('set-priv-bill').checked;
      const catalog = getMosquesCatalog();
      const idx = catalog.findIndex(m => m.id === mosqueMeta.id);
      if (idx !== -1) catalog[idx] = mosqueMeta;
      saveMosquesCatalog(catalog);
      showToast(t('msgSaved'), 'success');
    });

    document.getElementById('form-settings-salah').addEventListener('submit', (e) => {
      e.preventDefault();
      const formData = new FormData(e.target);
      const newSalah = {};
      CFG.SALAH_PRAYERS.forEach(sp => {
        newSalah[sp.id] = {
          adhan: formData.get(`${sp.id}_adhan`),
          iqamah: formData.get(`${sp.id}_iqamah`)
        };
      });
      mosqueData.salahTimings = newSalah;
      saveMosqueData(State.currentMosqueId, mosqueData);
      showToast(t('msgSaved'), 'success');
    });

    document.getElementById('form-add-custom-fund').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = document.getElementById('new-fund-name').value.trim();
      const isZakat = document.getElementById('new-fund-zakat').checked;
      if (!name) return;

      const newFund = {
        id: 'fund_custom_' + Date.now(),
        name: name,
        defaultName: name,
        isZakatEligible: isZakat,
        isSystem: false
      };

      mosqueData.customFunds = mosqueData.customFunds || [];
      mosqueData.customFunds.push(newFund);
      saveMosqueData(State.currentMosqueId, mosqueData);

      mosqueMeta.customFunds = mosqueData.customFunds;
      const catalog = getMosquesCatalog();
      const idx = catalog.findIndex(m => m.id === mosqueMeta.id);
      if (idx !== -1) catalog[idx] = mosqueMeta;
      saveMosquesCatalog(catalog);

      showToast(t('msgSaved'), 'success');
      renderCurrentView();
    });
  }

  // ==========================================================================
  // View 3: Transparent Public Ledger Explorer (Zero Login Required)
  // ==========================================================================

  function renderPublicExplorer(root) {
    const catalog = getMosquesCatalog();
    const activeMosqueId = State.publicSelectedMosqueId || (catalog[0] ? catalog[0].id : null);
    const mosqueMeta = catalog.find(m => m.id === activeMosqueId) || catalog[0];
    const mosqueData = mosqueMeta ? getMosqueData(mosqueMeta.id) : null;

    const ledger = (mosqueData && mosqueData.ledger) || [];
    const balances = calculateFundBalances(ledger);
    const settings = (mosqueMeta && mosqueMeta.settings) || CFG.DEFAULT_PUBLIC_SETTINGS;

    root.innerHTML = `
      <!-- Public Header -->
      <header class="app-header">
        <div class="header-container">
          <div class="brand-wrapper">
            <div class="brand-icon">🌐</div>
            <div class="brand-title-group">
              <h1>${escapeHtml(t('publicTitle'))}</h1>
              <p>${escapeHtml(t('publicSubtitle'))}</p>
            </div>
          </div>
          <div class="header-controls">
            <button type="button" class="btn btn-outline btn-sm" onclick="window.installIdarahPwa()" style="color: #ffffff; border-color: rgba(255, 255, 255, 0.4);">
              📲 Install App
            </button>
            <select class="lang-selector lang-select-input" aria-label="Select Language">
              ${CFG.LANGUAGES.map(l => `<option value="${l.code}" ${l.code === State.currentLang ? 'selected' : ''}>${l.name}</option>`).join('')}
            </select>
            <button type="button" id="btn-exit-public" class="btn btn-outline btn-sm" style="color: #ffffff; border-color: rgba(255,255,255,0.4);">
              🔐 ${escapeHtml(t('btnBackToLogin'))}
            </button>
          </div>
        </div>
      </header>

      <main class="main-container">
        <!-- Mosque Selector & Notice -->
        <div class="card" style="margin-bottom: 16px;">
          <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
            <div style="flex: 1; min-width: 250px;">
              <label class="form-label">${escapeHtml(t('publicMosqueSelector'))}</label>
              <select id="public-mosque-select" class="form-control">
                ${catalog.map(m => `
                  <option value="${m.id}" ${m.id === activeMosqueId ? 'selected' : ''}>
                    🕌 ${escapeHtml(m.name)} (${escapeHtml(m.location)})
                  </option>
                `).join('')}
              </select>
            </div>
            <button type="button" id="public-btn-verify-chain" class="btn btn-primary" style="margin-top: 24px;">
              🔍 ${escapeHtml(t('btnVerifyLedger'))}
            </button>
          </div>
          <p style="font-size: 0.85rem; color: var(--text-muted); margin-top: 10px; background: var(--bg-app); padding: 8px 12px; border-radius: var(--radius-sm);">
            🛡️ ${escapeHtml(t('publicAuditNotice'))}
          </p>
        </div>

        <!-- Integrity Result Banner -->
        <div id="public-integrity-banner"></div>

        <!-- Receipt Verifier Tool -->
        <div class="card" style="border: 2px dashed var(--primary); background: #ffffff;">
          <div class="card-title">🔍 ${escapeHtml(t('publicVerifyCardTitle'))}</div>
          <p class="card-subtitle" style="margin-bottom: 14px;">${escapeHtml(t('publicVerifyCardDesc'))}</p>
          <div style="display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end;">
            <div class="form-group" style="flex: 1; min-width: 160px; margin-bottom: 0;">
              <label class="form-label">${escapeHtml(t('labelReceiptNo'))}</label>
              <input type="text" id="verify-receipt-no" class="form-control" placeholder="${escapeHtml(t('placeholderReceiptNo'))}" />
            </div>
            <div class="form-group" style="flex: 1; min-width: 160px; margin-bottom: 0;">
              <label class="form-label">${escapeHtml(t('labelVerifyCode'))}</label>
              <input type="text" id="verify-code-input" class="form-control" placeholder="${escapeHtml(t('placeholderVerifyCode'))}" maxlength="8" style="text-transform: uppercase;" />
            </div>
            <button type="button" id="btn-check-receipt" class="btn btn-primary">
              ${escapeHtml(t('btnVerifyReceipt'))}
            </button>
          </div>
          <div id="receipt-verify-output" style="margin-top: 14px;"></div>
        </div>

        <!-- Live Fund Balances -->
        <h3 style="margin-bottom: 12px; font-weight: 700;">${escapeHtml(t('fundBalancesTitle'))}</h3>
        <div class="metrics-grid">
          ${getMosqueFunds(mosqueData).map(f => `
            <div class="metric-card ${f.isZakatEligible ? 'zakat-restricted' : 'general-fund'}">
              <div class="metric-card-title">${escapeHtml(getFundName(f.id, mosqueData))}</div>
              <div class="metric-card-amount">${escapeHtml(formatCurrency(balances[f.id] || 0))}</div>
              <span class="metric-card-badge ${f.isZakatEligible ? 'badge-zakat' : 'badge-general'}">
                ${f.isZakatEligible ? t('zakatRestrictedBadge') : t('generalFundBadge')}
              </span>
            </div>
          `).join('')}
        </div>

        <!-- Salah Timings & Community Bulletins -->
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; margin-bottom: 20px;">
          <!-- Salah Timings -->
          <div class="card" style="margin-bottom: 0;">
            <div class="card-title">⏰ ${escapeHtml(t('publicSalahCardTitle'))}</div>
            <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 12px; font-size: 0.85rem;">
              ${CFG.SALAH_PRAYERS.map(sp => {
                const tim = (mosqueData && mosqueData.salahTimings && mosqueData.salahTimings[sp.id]) || { adhan: '--:--', iqamah: '--:--' };
                return `
                  <div style="background: var(--bg-app); padding: 8px 4px; border-radius: var(--radius-sm); text-align: center;">
                    <div style="font-weight: 700;">${escapeHtml(t(sp.nameKey))}</div>
                    <div style="color: var(--primary); font-weight: 700; margin-top: 4px;">${escapeHtml(tim.iqamah)}</div>
                  </div>
                `;
              }).join('')}
            </div>
          </div>

          <!-- Community Notices -->
          <div class="card" style="margin-bottom: 0;">
            <div class="card-title">📢 ${escapeHtml(t('publicNoticesCardTitle'))}</div>
            ${(!mosqueData || !mosqueData.notices || mosqueData.notices.length === 0) ? `<p style="color: var(--text-muted); font-size: 0.9rem;">${escapeHtml(t('noNoticesYet'))}</p>` : `
              <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 8px;">
                ${mosqueData.notices.slice(0, 3).map(n => `
                  <div style="background: var(--bg-app); padding: 8px 12px; border-radius: var(--radius-sm);">
                    <div style="font-weight: 700; color: var(--primary); font-size: 0.9rem;">${escapeHtml(n.title)}</div>
                    <div style="font-size: 0.85rem; color: var(--text-main); margin: 4px 0;">${escapeHtml(n.content)}</div>
                    <div style="font-size: 0.75rem; color: var(--text-muted);">📅 ${escapeHtml(n.date)}</div>
                  </div>
                `).join('')}
              </div>
            `}
          </div>
        </div>

        <!-- Full SHA-256 Hash Chain Explorer (Protected Privacy) -->
        <div class="card">
          <h3 class="card-title">🔗 ${escapeHtml(t('recentTransactionsTitle'))} (${ledger.length} Blocks)</h3>
          ${ledger.length === 0 ? `<p style="color: var(--text-muted);">${escapeHtml(t('ledgerEmpty'))}</p>` : `
            <div class="table-responsive">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>${escapeHtml(t('thSeq'))}</th>
                    <th>${escapeHtml(t('thDate'))}</th>
                    <th>${escapeHtml(t('thType'))}</th>
                    <th>${escapeHtml(t('thFund'))}</th>
                    <th>${escapeHtml(t('thDetails'))}</th>
                    <th>${escapeHtml(t('thAmount'))}</th>
                    <th>${escapeHtml(t('thHash'))}</th>
                  </tr>
                </thead>
                <tbody>
                  ${ledger.slice().reverse().map(e => `
                    <tr>
                      <td><strong>#${e.seq}</strong></td>
                      <td style="white-space: nowrap;">${escapeHtml(e.date)}</td>
                      <td>
                        <span class="metric-card-badge ${e.type === 'donation' ? 'badge-general' : 'badge-zakat'}">
                          ${escapeHtml(e.type)}
                        </span>
                      </td>
                      <td>${escapeHtml(getFundName(e.fundId, mosqueData))}</td>
                      <td>
                        <strong>${escapeHtml(e.category)}</strong>
                        <div style="font-size: 0.8rem; color: var(--text-muted);">
                          ${e.type === 'donation' ? 'Donor: [Confidential / Protected]' : (settings.showSalaryInPublic ? escapeHtml(e.note) : 'Note: [Protected for privacy]')}
                        </div>
                      </td>
                      <td><strong>${escapeHtml(formatCurrency(e.amount))}</strong></td>
                      <td><span class="hash-badge" title="${escapeHtml(e.hash)}">${escapeHtml(e.hash.substring(0, 12))}...</span></td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          `}
        </div>
      </main>
    `;

    // Public Listeners
    root.querySelectorAll('.lang-select-input').forEach(sel => {
      sel.addEventListener('change', (e) => setLanguage(e.target.value));
    });

    document.getElementById('btn-exit-public').addEventListener('click', () => {
      State.isPublicView = false;
      renderCurrentView();
    });

    document.getElementById('public-mosque-select').addEventListener('change', (e) => {
      State.publicSelectedMosqueId = e.target.value;
      renderCurrentView();
    });

    document.getElementById('public-btn-verify-chain').addEventListener('click', () => {
      const banner = document.getElementById('public-integrity-banner');
      banner.innerHTML = `<div class="integrity-banner intact">Computing SHA-256 hash digests...</div>`;
      setTimeout(() => {
        const result = HASH.verifyChainIntegrity(ledger);
        if (result.valid) {
          banner.innerHTML = `
            <div class="integrity-banner intact">
              <span>${escapeHtml(t('ledgerStatusIntact', { count: result.count }))}</span>
            </div>
          `;
        } else {
          banner.innerHTML = `
            <div class="integrity-banner tampered">
              <span>${escapeHtml(t('ledgerStatusTampered', { seq: result.brokenSeq }))} - ${escapeHtml(result.reason)}</span>
            </div>
          `;
        }
      }, 200);
    });

    // Receipt Search
    document.getElementById('btn-check-receipt').addEventListener('click', () => {
      const receiptNo = document.getElementById('verify-receipt-no').value.trim();
      const code = document.getElementById('verify-code-input').value.trim().toUpperCase();
      const output = document.getElementById('receipt-verify-output');

      if (!receiptNo || !code) {
        output.innerHTML = `<div style="color: var(--danger); font-weight: 600;">Please enter both Receipt # and 8-character Verification Code.</div>`;
        return;
      }

      const match = ledger.find(e => e.receiptNo && e.receiptNo.toUpperCase() === receiptNo.toUpperCase() && e.verifyCode === code);
      if (match) {
        output.innerHTML = `
          <div style="background: var(--success-light); border: 1.5px solid #86efac; padding: 14px; border-radius: var(--radius-md); color: #166534;">
            <div style="font-weight: 700; font-size: 1.05rem; margin-bottom: 4px;">
              ${escapeHtml(t('receiptVerifiedSuccess', {
                seq: match.seq,
                fund: getFundName(match.fundId, mosqueData),
                date: match.date
              }))}
            </div>
            <div style="font-size: 0.9rem; margin-top: 6px;">
              Amount: <strong>${escapeHtml(formatCurrency(match.amount))}</strong> | Method: ${escapeHtml(match.method)}
            </div>
            <div style="font-family: monospace; font-size: 0.75rem; margin-top: 4px; word-break: break-all;">
              Block SHA-256 Digest: ${escapeHtml(match.hash)}
            </div>
          </div>
        `;
      } else {
        output.innerHTML = `
          <div style="background: var(--danger-light); border: 1.5px solid #fca5a5; padding: 12px; border-radius: var(--radius-md); color: #991b1b; font-weight: 600;">
            ${escapeHtml(t('receiptVerifyFailed'))}
          </div>
        `;
      }
    });

    // Check URL parameters for direct receipt verification links (e.g., from WhatsApp)
    const urlParams = new URLSearchParams(window.location.search);
    const urlVerify = urlParams.get('verify');
    const urlCode = urlParams.get('code');
    if (urlVerify && urlCode) {
      document.getElementById('verify-receipt-no').value = urlVerify;
      document.getElementById('verify-code-input').value = urlCode;
      document.getElementById('btn-check-receipt').click();
    }
  }

  // ==========================================================================
  // Cryptographic Ledger Integrity Check Handler
  // ==========================================================================

  function runIntegrityVerification() {
    const banner = document.getElementById('integrity-status-banner');
    if (!banner) return;

    banner.innerHTML = `<div class="integrity-banner intact">${escapeHtml(t('ledgerStatusChecking'))}</div>`;

    setTimeout(() => {
      const mosqueData = getMosqueData(State.currentMosqueId);
      const ledger = (mosqueData && mosqueData.ledger) || [];
      const result = HASH.verifyChainIntegrity(ledger);

      if (result.valid) {
        banner.innerHTML = `
          <div class="integrity-banner intact">
            <span>${escapeHtml(t('ledgerStatusIntact', { count: result.count }))}</span>
            <span style="font-family: monospace; font-size: 0.8rem;">Last Block Hash: ${escapeHtml((result.lastHash || '').substring(0, 16))}...</span>
          </div>
        `;
      } else {
        banner.innerHTML = `
          <div class="integrity-banner tampered">
            <div>
              <div>${escapeHtml(t('ledgerStatusTampered', { seq: result.brokenSeq }))}</div>
              <div style="font-size: 0.85rem; font-weight: normal; margin-top: 4px;">${escapeHtml(result.reason)}</div>
            </div>
          </div>
        `;
      }
    }, 150);
  }

  // ==========================================================================
  // Modal Dialogs Engine
  // ==========================================================================

  function createModal(titleText, contentHtml) {
    const existing = document.getElementById('active-modal-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'active-modal-overlay';
    overlay.className = 'modal-overlay';

    overlay.innerHTML = `
      <div class="modal-dialog">
        <div class="modal-header">
          <h3 class="modal-title">${escapeHtml(titleText)}</h3>
          <button type="button" class="modal-close-btn" id="modal-close-x">✕</button>
        </div>
        <div class="modal-body">
          ${contentHtml}
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    function closeModal() {
      overlay.classList.remove('active');
      setTimeout(() => overlay.remove(), 200);
    }

    overlay.querySelector('#modal-close-x').addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
    });

    setTimeout(() => overlay.classList.add('active'), 10);
    return { overlay, closeModal };
  }

  // ==========================================================================
  // Modal 1: Onboarding Committee Members
  // ==========================================================================

  function openOnboardingModal() {
    const mosqueData = getMosqueData(State.currentMosqueId);
    let tempMembers = [...((mosqueData && mosqueData.users) || [])];

    function getBodyHtml() {
      return `
        <p style="font-size: 0.9rem; color: var(--text-muted); margin-bottom: 16px;">
          ${escapeHtml(t('onboardingSubtitle'))}
        </p>

        <form id="form-onboard-add" style="background: var(--bg-app); padding: 14px; border-radius: var(--radius-md); margin-bottom: 16px;">
          <div class="form-group">
            <label class="form-label">${escapeHtml(t('labelMemberName'))} *</label>
            <input type="text" id="ob-name" class="form-control" placeholder="${escapeHtml(t('placeholderMemberName'))}" required />
          </div>
          <div class="form-group">
            <label class="form-label">${escapeHtml(t('labelPhone'))} *</label>
            <input type="tel" id="ob-phone" class="form-control" placeholder="${escapeHtml(t('placeholderPhone'))}" maxlength="10" required />
          </div>
          <div class="form-group">
            <label class="form-label">${escapeHtml(t('labelMemberRole'))} *</label>
            <select id="ob-role" class="form-control">
              <option value="treasurer">${escapeHtml(t('role_treasurer'))}</option>
              <option value="teacher">${escapeHtml(t('role_teacher'))}</option>
              <option value="viewer">${escapeHtml(t('role_viewer'))}</option>
              <option value="admin">${escapeHtml(t('role_admin'))}</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">${escapeHtml(t('labelMemberPin'))} *</label>
            <input type="password" id="ob-pin" class="form-control" placeholder="${escapeHtml(t('placeholderMemberPin'))}" minlength="6" required />
          </div>
          <button type="submit" class="btn btn-secondary btn-block btn-sm">
            ➕ ${escapeHtml(t('btnAddMember'))}
          </button>
        </form>

        <h4 style="font-weight: 700; margin-bottom: 8px;">${escapeHtml(t('membersListHeading'))}</h4>
        <div id="ob-members-list" style="margin-bottom: 16px; max-height: 140px; overflow-y: auto;">
          ${tempMembers.map(m => `
            <div style="padding: 6px 10px; background: #ffffff; border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center;">
              <div>
                <strong>${escapeHtml(m.name)}</strong>
                <div style="font-size: 0.75rem; color: var(--text-muted);">${escapeHtml(m.phone)} • ${escapeHtml(t('role_' + m.role))}</div>
              </div>
            </div>
          `).join('')}
        </div>

        <button type="button" id="ob-finish-btn" class="btn btn-primary btn-block">
          ✅ ${escapeHtml(t('btnFinishOnboarding'))}
        </button>
      `;
    }

    const { overlay, closeModal } = createModal(t('onboardingTitle'), getBodyHtml());

    function bindEvents() {
      const form = overlay.querySelector('#form-onboard-add');
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const name = overlay.querySelector('#ob-name').value.trim();
        const phone = overlay.querySelector('#ob-phone').value.trim();
        const role = overlay.querySelector('#ob-role').value;
        const pin = overlay.querySelector('#ob-pin').value.trim();

        if (!CFG.VALIDATION.PHONE_REGEX.test(phone)) {
          showToast(t('errInvalidPhone'), 'error');
          return;
        }
        if (pin.length < 6) {
          showToast(t('errPinShort'), 'error');
          return;
        }

        const newMem = {
          id: 'user_' + Date.now(),
          name, phone, role, pin: hashPin(phone, pin), email: ''
        };
        tempMembers.push(newMem);
        mosqueData.users = tempMembers;
        saveMosqueData(State.currentMosqueId, mosqueData);

        overlay.querySelector('.modal-body').innerHTML = getBodyHtml();
        bindEvents();
      });

      overlay.querySelector('#ob-finish-btn').addEventListener('click', () => {
        closeModal();
        State.activeTab = 'dashboard';
        renderCurrentView();
      });
    }

    bindEvents();
  }

  // ==========================================================================
  // Modal 2: Record Donation
  // ==========================================================================

  function openDonationModal() {
    if (!requirePerm('ledger')) return;
    const mosqueData = getMosqueData(State.currentMosqueId);
    const funds = getMosqueFunds(mosqueData);

    const bodyHtml = `
      <form id="modal-form-donation">
        <div class="form-group">
          <label class="form-label">${escapeHtml(t('labelAmount'))} *</label>
          <input type="number" id="don-amount" class="form-control" placeholder="${escapeHtml(t('placeholderAmount'))}" min="1" step="any" required autofocus />
        </div>
        <div class="form-group">
          <label class="form-label">${escapeHtml(t('labelFund'))} *</label>
          <select id="don-fund" class="form-control">
            ${funds.map(f => `
              <option value="${f.id}">${escapeHtml(getFundName(f.id, mosqueData))} ${f.isZakatEligible ? ' (' + t('zakatRestrictedBadge') + ')' : ''}</option>
            `).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">${escapeHtml(t('labelMethod'))} *</label>
          <select id="don-method" class="form-control">
            ${CFG.PAYMENT_METHODS.map(m => `
              <option value="${escapeHtml(t(m.nameKey))}">${escapeHtml(t(m.nameKey))}</option>
            `).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">${escapeHtml(t('labelDonorName'))}</label>
          <input type="text" id="don-name" class="form-control" placeholder="${escapeHtml(t('placeholderDonorName'))}" />
        </div>
        <div class="form-group">
          <label class="form-label">${escapeHtml(t('labelDonorPhone'))}</label>
          <input type="tel" id="don-phone" class="form-control" placeholder="10-digit mobile (optional)" maxlength="10" />
        </div>
        <div class="form-group">
          <label class="form-label">${escapeHtml(t('labelNote'))}</label>
          <input type="text" id="don-note" class="form-control" placeholder="${escapeHtml(t('placeholderNote'))}" />
        </div>
        <button type="submit" class="btn btn-primary btn-block">
          🧾 ${escapeHtml(t('btnSaveDonation'))}
        </button>
      </form>
    `;

    const { overlay, closeModal } = createModal(t('modalDonationTitle'), bodyHtml);

    overlay.querySelector('#modal-form-donation').addEventListener('submit', (e) => {
      e.preventDefault();
      const amount = overlay.querySelector('#don-amount').value;
      const fundId = overlay.querySelector('#don-fund').value;
      const method = overlay.querySelector('#don-method').value;
      const donorName = overlay.querySelector('#don-name').value;
      const donorPhone = overlay.querySelector('#don-phone').value;
      const note = overlay.querySelector('#don-note').value;

      const entry = addDonationEntry({ amount, fundId, method, note, donorName, donorPhone });
      if (entry) {
        closeModal();
        renderCurrentView();
        // Immediately show the official receipt with WhatsApp share button
        openReceiptModal(entry);
      }
    });
  }

  // ==========================================================================
  // Modal 3: Record Expense
  // ==========================================================================

  function openExpenseModal() {
    if (!requirePerm('ledger')) return;
    const mosqueData = getMosqueData(State.currentMosqueId);
    const funds = getMosqueFunds(mosqueData);
    const balances = calculateFundBalances(mosqueData.ledger);

    let compressedPhotoBase64 = '';

    function getCategoriesOptions(fundId) {
      const isZakat = isFundZakatOnly(fundId, mosqueData);
      const catList = isZakat ? CFG.ZAKAT_EXPENSE_CATEGORIES : CFG.GENERAL_EXPENSE_CATEGORIES;
      return catList.map(c => `<option value="${escapeHtml(t(c.nameKey))}">${escapeHtml(t(c.nameKey))}</option>`).join('');
    }

    const defaultFundId = funds[0].id;

    const bodyHtml = `
      <form id="modal-form-expense">
        <div class="form-group">
          <label class="form-label">${escapeHtml(t('labelFund'))} *</label>
          <select id="exp-fund" class="form-control">
            ${funds.map(f => `
              <option value="${f.id}">${escapeHtml(getFundName(f.id, mosqueData))} ${f.isZakatEligible ? ' (' + t('zakatRestrictedBadge') + ')' : ''}</option>
            `).join('')}
          </select>
          <div id="exp-fund-warning" style="font-size: 0.8rem; font-weight: 600; color: var(--primary); margin-top: 4px;">
            ${escapeHtml(t('expenseBalanceWarning', { balance: formatCurrency(balances[defaultFundId] || 0) }))}
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">${escapeHtml(t('labelCategory'))} *</label>
          <select id="exp-category" class="form-control">
            ${getCategoriesOptions(defaultFundId)}
          </select>
          <div id="exp-zakat-notice" style="display: none; font-size: 0.8rem; color: #b45309; font-weight: 600; margin-top: 4px;">
            ${escapeHtml(t('zakatFundNotice'))}
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">${escapeHtml(t('labelAmount'))} *</label>
          <input type="number" id="exp-amount" class="form-control" placeholder="${escapeHtml(t('placeholderAmount'))}" min="1" step="any" required />
        </div>

        <div class="form-group">
          <label class="form-label">${escapeHtml(t('labelNote'))}</label>
          <input type="text" id="exp-note" class="form-control" placeholder="Description / Purpose of expense" />
        </div>

        <div class="form-group">
          <label class="form-label">${escapeHtml(t('labelBillPhoto'))}</label>
          <input type="file" id="exp-file" accept="image/*" class="form-control" style="min-height: 44px; padding: 6px;" />
          <div id="exp-file-status" style="font-size: 0.75rem; color: var(--text-muted); margin-top: 2px;"></div>
        </div>

        <button type="submit" class="btn btn-danger btn-block">
          📦 ${escapeHtml(t('btnSaveExpense'))}
        </button>
      </form>
    `;

    const { overlay, closeModal } = createModal(t('modalExpenseTitle'), bodyHtml);

    const fundSelect = overlay.querySelector('#exp-fund');
    const catSelect = overlay.querySelector('#exp-category');
    const warningDiv = overlay.querySelector('#exp-fund-warning');
    const zakatNotice = overlay.querySelector('#exp-zakat-notice');

    fundSelect.addEventListener('change', () => {
      const fundId = fundSelect.value;
      const bal = balances[fundId] || 0;
      warningDiv.textContent = t('expenseBalanceWarning', { balance: formatCurrency(bal) });
      catSelect.innerHTML = getCategoriesOptions(fundId);

      const isZakat = isFundZakatOnly(fundId, mosqueData);
      zakatNotice.style.display = isZakat ? 'block' : 'none';
    });

    const fileInput = overlay.querySelector('#exp-file');
    const fileStatus = overlay.querySelector('#exp-file-status');
    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        fileStatus.textContent = 'Auto-compressing image...';
        compressImageFile(file, (dataUrl) => {
          compressedPhotoBase64 = dataUrl;
          fileStatus.textContent = '✅ Bill photo compressed and attached.';
        });
      }
    });

    overlay.querySelector('#modal-form-expense').addEventListener('submit', (e) => {
      e.preventDefault();
      const fundId = fundSelect.value;
      const category = catSelect.value;
      const amount = overlay.querySelector('#exp-amount').value;
      const note = overlay.querySelector('#exp-note').value;

      const entry = addExpenseEntry({
        amount,
        fundId,
        category,
        note,
        billPhoto: compressedPhotoBase64
      });

      if (entry) {
        closeModal();
        renderCurrentView();
      }
    });
  }

  // ==========================================================================
  // Modal 4: Official Receipt Display & WhatsApp Share
  // ==========================================================================

  function openReceiptModal(entry) {
    const mosqueMeta = getMosqueMeta(State.currentMosqueId);
    const mosqueData = getMosqueData(State.currentMosqueId);
    const waUrl = generateReceiptWhatsAppUrl(entry, mosqueMeta);

    const bodyHtml = `
      <div class="receipt-box" id="official-receipt-print">
        <div class="receipt-watermark">AUTHENTIC</div>
        
        <div style="text-align: center; margin-bottom: 16px;">
          <h2 style="font-size: 1.3rem; font-weight: 800; color: var(--primary);">${escapeHtml(mosqueMeta.name)}</h2>
          <div style="font-size: 0.85rem; color: var(--text-muted);">${escapeHtml(mosqueMeta.location)}</div>
          <div style="font-size: 0.95rem; font-weight: 700; margin-top: 6px;">${escapeHtml(t('receiptMosqueHeader'))}</div>
        </div>

        <div class="receipt-row">
          <span class="receipt-label">${escapeHtml(t('receiptNumberLabel'))}</span>
          <span class="receipt-val" style="color: var(--primary);">${escapeHtml(entry.receiptNo)}</span>
        </div>
        <div class="receipt-row">
          <span class="receipt-label">${escapeHtml(t('receiptVerifyCodeLabel'))}</span>
          <span class="receipt-val" style="font-family: monospace; letter-spacing: 1px;">${escapeHtml(entry.verifyCode)}</span>
        </div>
        <div class="receipt-row">
          <span class="receipt-label">${escapeHtml(t('receiptDateLabel'))}</span>
          <span class="receipt-val">${escapeHtml(entry.date)}</span>
        </div>
        <div class="receipt-row">
          <span class="receipt-label">${escapeHtml(t('receiptDonorLabel'))}</span>
          <span class="receipt-val">${escapeHtml(entry.donorName || t('anonymousDonor'))}</span>
        </div>
        <div class="receipt-row">
          <span class="receipt-label">${escapeHtml(t('receiptAmountLabel'))}</span>
          <span class="receipt-val" style="font-size: 1.2rem; color: var(--success);">${escapeHtml(formatCurrency(entry.amount))}</span>
        </div>
        <div class="receipt-row">
          <span class="receipt-label">${escapeHtml(t('receiptFundLabel'))}</span>
          <span class="receipt-val">${escapeHtml(getFundName(entry.fundId, mosqueData))}</span>
        </div>
        <div class="receipt-row">
          <span class="receipt-label">${escapeHtml(t('receiptMethodLabel'))}</span>
          <span class="receipt-val">${escapeHtml(entry.method)}</span>
        </div>
        <div class="receipt-row">
          <span class="receipt-label">${escapeHtml(t('receiptRecordedByLabel'))}</span>
          <span class="receipt-val">${escapeHtml(entry.recordedBy)}</span>
        </div>
        <div class="receipt-row" style="flex-direction: column; gap: 4px; border-bottom: none;">
          <span class="receipt-label">${escapeHtml(t('receiptHashLabel'))}</span>
          <span style="font-family: monospace; font-size: 0.7rem; word-break: break-all; background: var(--bg-app); padding: 4px 6px; border-radius: var(--radius-sm);">
            ${escapeHtml(entry.hash)}
          </span>
        </div>

        <p style="font-size: 0.75rem; color: var(--text-muted); text-align: center; margin-top: 14px;">
          ${escapeHtml(t('receiptNotice'))}
        </p>
      </div>

      <div style="display: flex; gap: 10px; margin-top: 16px;">
        <a href="${waUrl}" target="_blank" rel="noopener noreferrer" class="btn btn-whatsapp" style="flex: 2; text-decoration: none;">
          💬 ${escapeHtml(t('btnShareWhatsApp'))}
        </a>
        <button type="button" id="btn-print-single-receipt" class="btn btn-secondary" style="flex: 1;">
          🖨️ ${escapeHtml(t('btnPrintReceipt'))}
        </button>
      </div>
    `;

    const { overlay, closeModal } = createModal(t('receiptModalTitle'), bodyHtml);

    overlay.querySelector('#btn-print-single-receipt').addEventListener('click', () => {
      window.print();
    });
  }

  // ==========================================================================
  // Modal 5: Cryptographic Reversal Confirmation
  // ==========================================================================

  function openReversalModal(seq) {
    if (!requirePerm('ledger')) return;
    const mosqueData = getMosqueData(State.currentMosqueId);
    const entry = mosqueData.ledger.find(e => e.seq === seq);
    if (!entry) return;

    const bodyHtml = `
      <form id="form-reversal-confirm">
        <div style="background: var(--danger-light); border: 1.5px solid #fca5a5; padding: 12px; border-radius: var(--radius-md); color: #991b1b; font-size: 0.9rem; margin-bottom: 16px;">
          ⚠️ ${escapeHtml(t('reversalWarning', { seq: entry.seq, amount: formatCurrency(entry.amount) }))}
        </div>

        <div class="form-group">
          <label class="form-label">${escapeHtml(t('labelReversalReason'))} *</label>
          <input type="text" id="rev-reason" class="form-control" placeholder="${escapeHtml(t('placeholderReversalReason'))}" required autofocus />
        </div>

        <div style="display: flex; gap: 10px; margin-top: 16px;">
          <button type="submit" class="btn btn-danger" style="flex: 1;">
            ${escapeHtml(t('btnConfirmReversal'))}
          </button>
          <button type="button" id="rev-cancel-btn" class="btn btn-outline" style="flex: 1;">
            ${escapeHtml(t('btnCancel'))}
          </button>
        </div>
      </form>
    `;

    const { overlay, closeModal } = createModal(t('reversalModalTitle'), bodyHtml);

    overlay.querySelector('#rev-cancel-btn').addEventListener('click', closeModal);

    overlay.querySelector('#form-reversal-confirm').addEventListener('submit', (e) => {
      e.preventDefault();
      const reason = overlay.querySelector('#rev-reason').value.trim();
      if (!reason) return;

      const revEntry = addReversalEntry(seq, reason);
      if (revEntry) {
        closeModal();
        renderCurrentView();
      }
    });
  }

  // ==========================================================================
  // Modal 6: Madrasa Student Enrollment / Edit
  // ==========================================================================

  function openStudentModal(existingStudent = null) {
    if (!requirePerm('madrasa')) return;
    const isEdit = Boolean(existingStudent);
    const mosqueData = getMosqueData(State.currentMosqueId);

    const bodyHtml = `
      <form id="form-student-modal">
        <div class="form-group">
          <label class="form-label">${escapeHtml(t('labelStudentName'))} *</label>
          <input type="text" id="std-name" class="form-control" value="${escapeHtml(existingStudent ? existingStudent.name : '')}" placeholder="${escapeHtml(t('placeholderStudentName'))}" required />
        </div>
        <div class="form-group">
          <label class="form-label">${escapeHtml(t('labelGuardianName'))} *</label>
          <input type="text" id="std-guardian" class="form-control" value="${escapeHtml(existingStudent ? existingStudent.guardianName : '')}" placeholder="${escapeHtml(t('placeholderGuardianName'))}" required />
        </div>
        <div class="form-group">
          <label class="form-label">${escapeHtml(t('labelPhone'))} *</label>
          <input type="tel" id="std-phone" class="form-control" value="${escapeHtml(existingStudent ? existingStudent.phone : '')}" placeholder="${escapeHtml(t('placeholderPhone'))}" maxlength="10" required />
        </div>
        <div class="form-group">
          <label class="form-label">${escapeHtml(t('labelClass'))} *</label>
          <input type="text" id="std-class" class="form-control" value="${escapeHtml(existingStudent ? existingStudent.className : '')}" placeholder="${escapeHtml(t('placeholderClass'))}" required />
        </div>
        <div class="form-group">
          <label class="form-label">${escapeHtml(t('labelMonthlyFee'))} *</label>
          <input type="number" id="std-fee" class="form-control" value="${existingStudent ? existingStudent.monthlyFee : '500'}" min="0" required />
        </div>

        <button type="submit" class="btn btn-primary btn-block">
          💾 ${isEdit ? escapeHtml(t('btnEditStudent')) : escapeHtml(t('btnAddStudent'))}
        </button>
      </form>
    `;

    const { overlay, closeModal } = createModal(isEdit ? t('btnEditStudent') : t('btnAddStudent'), bodyHtml);

    overlay.querySelector('#form-student-modal').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = overlay.querySelector('#std-name').value.trim();
      const guardian = overlay.querySelector('#std-guardian').value.trim();
      const phone = overlay.querySelector('#std-phone').value.trim();
      const className = overlay.querySelector('#std-class').value.trim();
      const fee = Number(overlay.querySelector('#std-fee').value) || 0;

      if (!CFG.VALIDATION.PHONE_REGEX.test(phone)) {
        showToast(t('errInvalidPhone'), 'error');
        return;
      }

      mosqueData.students = mosqueData.students || [];

      if (isEdit) {
        const idx = mosqueData.students.findIndex(s => s.id === existingStudent.id);
        if (idx !== -1) {
          mosqueData.students[idx] = { ...existingStudent, name, guardianName: guardian, phone, className, monthlyFee: fee };
        }
      } else {
        mosqueData.students.push({
          id: 'std_' + Date.now(),
          name, guardianName: guardian, phone, className, monthlyFee: fee,
          admissionDate: getISTDate()
        });
      }

      saveMosqueData(State.currentMosqueId, mosqueData);
      showToast(t('msgSaved'), 'success');
      closeModal();
      renderCurrentView();
    });
  }

  // ==========================================================================
  // Modal 7: Collect Madrasa Fee (Prevents double payment & updates ledger)
  // ==========================================================================

  function openCollectFeeModal(studentId) {
    if (!requirePerm('fees')) return;
    const mosqueData = getMosqueData(State.currentMosqueId);
    const student = (mosqueData.students || []).find(s => s.id === studentId);
    if (!student) return;

    const currentMonth = getISTMonth();

    const bodyHtml = `
      <form id="form-collect-fee-modal">
        <div style="background: var(--primary-light); padding: 12px; border-radius: var(--radius-md); margin-bottom: 16px;">
          <div style="font-weight: 700; color: var(--primary); font-size: 1.1rem;">${escapeHtml(student.name)}</div>
          <div style="font-size: 0.85rem; color: var(--text-muted);">Class: ${escapeHtml(student.className)} • Fee: ${escapeHtml(formatCurrency(student.monthlyFee))}</div>
        </div>

        <div class="form-group">
          <label class="form-label">${escapeHtml(t('feeMonthSelector'))}</label>
          <input type="month" id="fee-month-input" class="form-control" value="${currentMonth}" required />
        </div>

        <div class="form-group">
          <label class="form-label">${escapeHtml(t('labelAmount'))}</label>
          <input type="number" id="fee-amount-input" class="form-control" value="${student.monthlyFee}" min="1" required />
        </div>

        <div class="form-group">
          <label class="form-label">${escapeHtml(t('labelMethod'))}</label>
          <select id="fee-method-input" class="form-control">
            ${CFG.PAYMENT_METHODS.map(m => `<option value="${escapeHtml(t(m.nameKey))}">${escapeHtml(t(m.nameKey))}</option>`).join('')}
          </select>
        </div>

        <p style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 16px;">
          💡 ${escapeHtml(t('feeAutoLedgerNotice'))}
        </p>

        <button type="submit" class="btn btn-primary btn-block">
          💳 ${escapeHtml(t('btnConfirmFeePayment'))}
        </button>
      </form>
    `;

    const { overlay, closeModal } = createModal(t('modalCollectFeeTitle'), bodyHtml);

    overlay.querySelector('#form-collect-fee-modal').addEventListener('submit', (e) => {
      e.preventDefault();
      const month = overlay.querySelector('#fee-month-input').value;
      const amount = Number(overlay.querySelector('#fee-amount-input').value);
      const method = overlay.querySelector('#fee-method-input').value;

      // Double Payment Check
      mosqueData.feePayments = mosqueData.feePayments || [];
      const alreadyPaid = mosqueData.feePayments.some(f => f.studentId === student.id && f.month === month);
      if (alreadyPaid) {
        showToast(t('errFeeAlreadyPaid', { name: student.name, month: month }), 'error');
        return;
      }

      // Add to Cryptographic Ledger under 'fund_madrasa'
      const ledgerEntry = addDonationEntry({
        amount: amount,
        fundId: 'fund_madrasa',
        method: method,
        note: `Madrasa Monthly Fee for ${student.name} (${month})`,
        donorName: `Guardian of ${student.name}`,
        donorPhone: student.phone
      });

      if (!ledgerEntry) return;

      // Record fee payment receipt record
      const feePaymentRecord = {
        id: 'fee_' + Date.now(),
        studentId: student.id,
        studentName: student.name,
        month: month,
        amount: amount,
        receiptNo: ledgerEntry.receiptNo,
        date: ledgerEntry.date,
        ledgerSeq: ledgerEntry.seq
      };

      // Re-read: addDonationEntry already saved the new ledger block, so saving the
      // stale copy held by this modal would erase it.
      const freshData = getMosqueData(State.currentMosqueId);
      freshData.feePayments = freshData.feePayments || [];
      freshData.feePayments.push(feePaymentRecord);
      saveMosqueData(State.currentMosqueId, freshData);

      showToast(t('msgFeeRecorded', { receiptNo: ledgerEntry.receiptNo }), 'success');
      closeModal();
      renderCurrentView();
      openReceiptModal(ledgerEntry);
    });
  }

  // ==========================================================================
  // Modal 8: Staff Member Add / Edit
  // ==========================================================================

  function openStaffModal(existingStaff = null) {
    if (!requirePerm('ops')) return;
    const isEdit = Boolean(existingStaff);
    const mosqueData = getMosqueData(State.currentMosqueId);

    const bodyHtml = `
      <form id="form-staff-modal">
        <div class="form-group">
          <label class="form-label">${escapeHtml(t('labelStaffName'))} *</label>
          <input type="text" id="stf-name" class="form-control" value="${escapeHtml(existingStaff ? existingStaff.name : '')}" placeholder="${escapeHtml(t('placeholderStaffName'))}" required />
        </div>
        <div class="form-group">
          <label class="form-label">${escapeHtml(t('labelStaffRole'))} *</label>
          <input type="text" id="stf-role" class="form-control" value="${escapeHtml(existingStaff ? existingStaff.role : '')}" placeholder="${escapeHtml(t('placeholderStaffRole'))}" required />
        </div>
        <div class="form-group">
          <label class="form-label">${escapeHtml(t('labelPhone'))} *</label>
          <input type="tel" id="stf-phone" class="form-control" value="${escapeHtml(existingStaff ? existingStaff.phone : '')}" placeholder="${escapeHtml(t('placeholderPhone'))}" maxlength="10" required />
        </div>
        <div class="form-group">
          <label class="form-label">${escapeHtml(t('labelStaffSalary'))} *</label>
          <input type="number" id="stf-salary" class="form-control" value="${existingStaff ? existingStaff.monthlySalary : '15000'}" min="1" required />
        </div>

        <button type="submit" class="btn btn-primary btn-block">
          💾 ${isEdit ? escapeHtml(t('btnEditStaff')) : escapeHtml(t('btnAddStaff'))}
        </button>
      </form>
    `;

    const { overlay, closeModal } = createModal(isEdit ? t('btnEditStaff') : t('btnAddStaff'), bodyHtml);

    overlay.querySelector('#form-staff-modal').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = overlay.querySelector('#stf-name').value.trim();
      const role = overlay.querySelector('#stf-role').value.trim();
      const phone = overlay.querySelector('#stf-phone').value.trim();
      const salary = Number(overlay.querySelector('#stf-salary').value) || 0;

      if (!CFG.VALIDATION.PHONE_REGEX.test(phone)) {
        showToast(t('errInvalidPhone'), 'error');
        return;
      }

      mosqueData.staff = mosqueData.staff || [];

      if (isEdit) {
        const idx = mosqueData.staff.findIndex(s => s.id === existingStaff.id);
        if (idx !== -1) {
          mosqueData.staff[idx] = { ...existingStaff, name, role, phone, monthlySalary: salary };
        }
      } else {
        mosqueData.staff.push({
          id: 'stf_' + Date.now(),
          name, role, phone, monthlySalary: salary
        });
      }

      saveMosqueData(State.currentMosqueId, mosqueData);
      showToast(t('msgSaved'), 'success');
      closeModal();
      renderCurrentView();
    });
  }

  // ==========================================================================
  // Modal 9: Disburse Staff Salary (Checks General fund balance & double payment)
  // ==========================================================================

  function openPaySalaryModal(staffId) {
    if (!requirePerm('salary')) return;
    const mosqueData = getMosqueData(State.currentMosqueId);
    const staff = (mosqueData.staff || []).find(s => s.id === staffId);
    if (!staff) return;

    const currentMonth = getISTMonth();
    const balances = calculateFundBalances(mosqueData.ledger);
    const generalBalance = balances['fund_general'] || 0;

    const bodyHtml = `
      <form id="form-pay-salary-modal">
        <div style="background: var(--primary-light); padding: 12px; border-radius: var(--radius-md); margin-bottom: 16px;">
          <div style="font-weight: 700; color: var(--primary); font-size: 1.1rem;">${escapeHtml(staff.name)}</div>
          <div style="font-size: 0.85rem; color: var(--text-muted);">${escapeHtml(staff.role)} • Monthly Salary: ${escapeHtml(formatCurrency(staff.monthlySalary))}</div>
        </div>

        <div class="form-group">
          <label class="form-label">${escapeHtml(t('feeMonthSelector'))}</label>
          <input type="month" id="sal-month-input" class="form-control" value="${currentMonth}" required />
        </div>

        <div class="form-group">
          <label class="form-label">${escapeHtml(t('labelAmount'))}</label>
          <input type="number" id="sal-amount-input" class="form-control" value="${staff.monthlySalary}" min="1" required />
        </div>

        <p style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 16px;">
          💡 ${escapeHtml(t('salaryFundNotice', { balance: formatCurrency(generalBalance) }))}
        </p>

        <button type="submit" class="btn btn-primary btn-block">
          💵 ${escapeHtml(t('btnConfirmSalaryPayment'))}
        </button>
      </form>
    `;

    const { overlay, closeModal } = createModal(t('modalPaySalaryTitle'), bodyHtml);

    overlay.querySelector('#form-pay-salary-modal').addEventListener('submit', (e) => {
      e.preventDefault();
      const month = overlay.querySelector('#sal-month-input').value;
      const amount = Number(overlay.querySelector('#sal-amount-input').value);

      // Check double payment
      mosqueData.salaryPayments = mosqueData.salaryPayments || [];
      const alreadyPaid = mosqueData.salaryPayments.some(p => p.staffId === staff.id && p.month === month);
      if (alreadyPaid) {
        showToast(t('errSalaryAlreadyPaid', { name: staff.name, month: month }), 'error');
        return;
      }

      // Check balance & record expense block
      const expenseEntry = addExpenseEntry({
        amount: amount,
        fundId: 'fund_general',
        category: t('exp_staff_salary'),
        note: `Salary disbursement to ${staff.name} (${staff.role}) for ${month}`
      });

      if (!expenseEntry) return;

      // Re-read: addExpenseEntry already saved the new ledger block (see fee flow note).
      const freshData = getMosqueData(State.currentMosqueId);
      freshData.salaryPayments = freshData.salaryPayments || [];
      freshData.salaryPayments.push({
        id: 'sal_' + Date.now(),
        staffId: staff.id,
        staffName: staff.name,
        month: month,
        amount: amount,
        date: expenseEntry.date,
        ledgerSeq: expenseEntry.seq
      });

      saveMosqueData(State.currentMosqueId, freshData);
      showToast(t('msgSalaryRecorded', { seq: expenseEntry.seq }), 'success');
      closeModal();
      renderCurrentView();
    });
  }

  // ==========================================================================
  // Modal 10: Register Nikah
  // ==========================================================================

  function openNikahModal() {
    if (!requirePerm('ops')) return;
    const mosqueData = getMosqueData(State.currentMosqueId);
    const todayIST = getISTDate();

    const bodyHtml = `
      <form id="form-nikah-modal">
        <div class="form-group">
          <label class="form-label">${escapeHtml(t('labelGroom'))} *</label>
          <input type="text" id="nk-groom" class="form-control" placeholder="${escapeHtml(t('placeholderGroom'))}" required />
        </div>
        <div class="form-group">
          <label class="form-label">${escapeHtml(t('labelBride'))} *</label>
          <input type="text" id="nk-bride" class="form-control" placeholder="${escapeHtml(t('placeholderBride'))}" required />
        </div>
        <div class="form-group">
          <label class="form-label">${escapeHtml(t('labelWaliWitnesses'))}</label>
          <input type="text" id="nk-wali" class="form-control" placeholder="${escapeHtml(t('placeholderWaliWitnesses'))}" />
        </div>
        <div class="form-group">
          <label class="form-label">${escapeHtml(t('labelMahr'))} *</label>
          <input type="text" id="nk-mahr" class="form-control" placeholder="${escapeHtml(t('placeholderMahr'))}" required />
        </div>
        <div class="form-group">
          <label class="form-label">${escapeHtml(t('labelNikahDate'))} *</label>
          <input type="date" id="nk-date" class="form-control" value="${todayIST}" required />
        </div>
        <div class="form-group">
          <label class="form-label">${escapeHtml(t('labelQadi'))}</label>
          <input type="text" id="nk-qadi" class="form-control" value="${escapeHtml(State.currentUser.name)}" />
        </div>
        <button type="submit" class="btn btn-primary btn-block">
          📜 ${escapeHtml(t('btnAddNikah'))}
        </button>
      </form>
    `;

    const { overlay, closeModal } = createModal(t('btnAddNikah'), bodyHtml);

    overlay.querySelector('#form-nikah-modal').addEventListener('submit', (e) => {
      e.preventDefault();
      const groom = overlay.querySelector('#nk-groom').value.trim();
      const bride = overlay.querySelector('#nk-bride').value.trim();
      const waliWitnesses = overlay.querySelector('#nk-wali').value.trim();
      const mahr = overlay.querySelector('#nk-mahr').value.trim();
      const date = overlay.querySelector('#nk-date').value;
      const qadi = overlay.querySelector('#nk-qadi').value.trim();

      mosqueData.nikah = mosqueData.nikah || [];
      mosqueData.nikah.push({
        id: 'nk_' + Date.now(),
        groom, bride, waliWitnesses, mahr, date, qadi
      });

      saveMosqueData(State.currentMosqueId, mosqueData);
      showToast(t('msgSaved'), 'success');
      closeModal();
      renderCurrentView();
    });
  }

  // ==========================================================================
  // Modal 11: Register Janazah
  // ==========================================================================

  function openJanazahModal() {
    if (!requirePerm('ops')) return;
    const mosqueData = getMosqueData(State.currentMosqueId);
    const todayIST = getISTDate();

    const bodyHtml = `
      <form id="form-janazah-modal">
        <div class="form-group">
          <label class="form-label">${escapeHtml(t('labelDeceased'))} *</label>
          <input type="text" id="jn-name" class="form-control" placeholder="${escapeHtml(t('placeholderDeceased'))}" required />
        </div>
        <div class="form-group">
          <label class="form-label">${escapeHtml(t('labelDeceasedAge'))}</label>
          <input type="number" id="jn-age" class="form-control" placeholder="${escapeHtml(t('placeholderDeceasedAge'))}" min="1" max="150" />
        </div>
        <div class="form-group">
          <label class="form-label">${escapeHtml(t('labelDemiseDate'))} *</label>
          <input type="date" id="jn-date" class="form-control" value="${todayIST}" required />
        </div>
        <div class="form-group">
          <label class="form-label">${escapeHtml(t('labelJanazahTime'))} *</label>
          <input type="text" id="jn-time" class="form-control" placeholder="${escapeHtml(t('placeholderJanazahTime'))}" required />
        </div>
        <div class="form-group">
          <label class="form-label">${escapeHtml(t('labelBurialPlace'))}</label>
          <input type="text" id="jn-burial" class="form-control" placeholder="${escapeHtml(t('placeholderBurialPlace'))}" />
        </div>
        <button type="submit" class="btn btn-primary btn-block">
          ⚰️ ${escapeHtml(t('btnAddJanazah'))}
        </button>
      </form>
    `;

    const { overlay, closeModal } = createModal(t('btnAddJanazah'), bodyHtml);

    overlay.querySelector('#form-janazah-modal').addEventListener('submit', (e) => {
      e.preventDefault();
      const deceased = overlay.querySelector('#jn-name').value.trim();
      const age = overlay.querySelector('#jn-age').value.trim();
      const demiseDate = overlay.querySelector('#jn-date').value;
      const janazahTime = overlay.querySelector('#jn-time').value.trim();
      const burialPlace = overlay.querySelector('#jn-burial').value.trim();

      mosqueData.janazah = mosqueData.janazah || [];
      mosqueData.janazah.push({
        id: 'jn_' + Date.now(),
        deceased, age, demiseDate, janazahTime, burialPlace
      });

      saveMosqueData(State.currentMosqueId, mosqueData);
      showToast(t('msgSaved'), 'success');
      closeModal();
      renderCurrentView();
    });
  }

  // ==========================================================================
  // Modal 12: Add Asset
  // ==========================================================================

  function openAssetModal() {
    if (!requirePerm('ops')) return;
    const mosqueData = getMosqueData(State.currentMosqueId);
    const todayIST = getISTDate();

    const bodyHtml = `
      <form id="form-asset-modal">
        <div class="form-group">
          <label class="form-label">${escapeHtml(t('labelAssetName'))} *</label>
          <input type="text" id="ast-name" class="form-control" placeholder="${escapeHtml(t('placeholderAssetName'))}" required />
        </div>
        <div class="form-group">
          <label class="form-label">${escapeHtml(t('labelAssetLocation'))} *</label>
          <input type="text" id="ast-loc" class="form-control" placeholder="${escapeHtml(t('placeholderAssetLocation'))}" required />
        </div>
        <div class="form-group">
          <label class="form-label">${escapeHtml(t('labelAssetValue'))} *</label>
          <input type="number" id="ast-val" class="form-control" placeholder="e.g. 25000" min="0" required />
        </div>
        <div class="form-group">
          <label class="form-label">${escapeHtml(t('labelAssetCondition'))}</label>
          <select id="ast-cond" class="form-control">
            <option value="${escapeHtml(t('conditionGood'))}">${escapeHtml(t('conditionGood'))}</option>
            <option value="${escapeHtml(t('conditionRepair'))}">${escapeHtml(t('conditionRepair'))}</option>
            <option value="${escapeHtml(t('conditionReplaced'))}">${escapeHtml(t('conditionReplaced'))}</option>
          </select>
        </div>
        <button type="submit" class="btn btn-primary btn-block">
          📦 ${escapeHtml(t('btnAddAsset'))}
        </button>
      </form>
    `;

    const { overlay, closeModal } = createModal(t('btnAddAsset'), bodyHtml);

    overlay.querySelector('#form-asset-modal').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = overlay.querySelector('#ast-name').value.trim();
      const location = overlay.querySelector('#ast-loc').value.trim();
      const val = Number(overlay.querySelector('#ast-val').value) || 0;
      const cond = overlay.querySelector('#ast-cond').value;

      mosqueData.assets = mosqueData.assets || [];
      mosqueData.assets.push({
        id: 'ast_' + Date.now(),
        name, location, value: val, condition: cond,
        acquiredDate: todayIST
      });

      saveMosqueData(State.currentMosqueId, mosqueData);
      showToast(t('msgSaved'), 'success');
      closeModal();
      renderCurrentView();
    });
  }

  // ==========================================================================
  // Modal 13: Publish Community Notice
  // ==========================================================================

  function openNoticeModal() {
    if (!requirePerm('ops')) return;
    const mosqueData = getMosqueData(State.currentMosqueId);
    const todayIST = getISTDate();

    const bodyHtml = `
      <form id="form-notice-modal">
        <div class="form-group">
          <label class="form-label">${escapeHtml(t('labelNoticeTitle'))} *</label>
          <input type="text" id="ntc-title" class="form-control" placeholder="${escapeHtml(t('placeholderNoticeTitle'))}" required />
        </div>
        <div class="form-group">
          <label class="form-label">${escapeHtml(t('labelNoticeContent'))} *</label>
          <textarea id="ntc-content" class="form-control" placeholder="${escapeHtml(t('placeholderNoticeContent'))}" required></textarea>
        </div>
        <div class="form-group">
          <label class="form-label">${escapeHtml(t('labelNoticeExpiry'))}</label>
          <input type="date" id="ntc-expiry" class="form-control" />
        </div>
        <button type="submit" class="btn btn-primary btn-block">
          📢 ${escapeHtml(t('btnAddNotice'))}
        </button>
      </form>
    `;

    const { overlay, closeModal } = createModal(t('btnAddNotice'), bodyHtml);

    overlay.querySelector('#form-notice-modal').addEventListener('submit', (e) => {
      e.preventDefault();
      const title = overlay.querySelector('#ntc-title').value.trim();
      const content = overlay.querySelector('#ntc-content').value.trim();
      const expiry = overlay.querySelector('#ntc-expiry').value;

      mosqueData.notices = mosqueData.notices || [];
      mosqueData.notices.unshift({
        id: 'ntc_' + Date.now(),
        title, content, date: todayIST, expiryDate: expiry
      });

      saveMosqueData(State.currentMosqueId, mosqueData);
      showToast(t('msgSaved'), 'success');
      closeModal();
      renderCurrentView();
    });
  }

  // ==========================================================================
  // App Bootstrapper
  // ==========================================================================

  function initApp() {
    // 1. Seed demo mosque if fresh setup
    seedDemoDataIfEmpty();

    // 2. Initialize language & RTL
    initLanguage();

    // 3. Restore session
    restoreSession();

    // 4. Check URL hash or query params
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('public') || urlParams.has('verify')) {
      State.isPublicView = true;
    }

    // 5. Render
    renderCurrentView();
  }

  // Run on DOM Ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }

})();
