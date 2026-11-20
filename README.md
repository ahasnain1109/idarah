# Idarah - Mosque & Madrasa Management System
**ادارہ — شفاف مسجد و مدرسہ انتظامی نظام**

A complete, mobile-first web app for small mosques and madrasas in India. Built with plain HTML5, CSS3, vanilla JavaScript, and pure cryptographic SHA-256 hash chaining.

---

## 🧱 Multi-Committee Platform (Supabase) — Setup

This branch turns Idarah into a shared platform: many committees, each with 1+ modules
(Mosque, Madarsa, Dargah, Imambargah, Charitable/Waqf), one login per person (India `+91` phone + password).

1. **Create a Supabase project**, then open **SQL Editor** and run, in this order (each is safe to re-run):
   1. `supabase/migrations/001_modular_committees_rls.sql` - committees, modules, roles, operational tables, RLS
   2. `supabase/migrations/002_finance_tamper_evident_ledger.sql` - funds + append-only, hash-chained ledger
   3. `supabase/migrations/003_madarsa_mosque_ops.sql` - class names, Hifz log upserts, fee collection and salary payment functions
   (If an earlier draft of 001 is already installed, running only 002 is enough. It replaces the draft finance tables.)
2. **Auth settings**: Authentication -> Sign In / Providers -> User Signups: turn **off "Confirm email"**. Leave the Phone provider OFF
   (it needs a paid SMS provider). The app signs people in with phone + password through a hidden address derived from the number.
3. **Add your keys**: copy `.env.example` to `.env` and fill `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`
   (the anon / publishable key only; **never** the service_role / secret key).
   Run `node scripts/generate-config.js` to create `supabase-config.js`, then serve the folder (e.g. `npx serve .`).
4. **Netlify**: add the same two variables under Site settings → Environment variables. `netlify.toml` runs the generator on every deploy.

Security lives in the database: every table has Row Level Security so one committee can never read or change another's data.
The ledger is append-only with a hash chain computed by the database; `select public.verify_ledger('<committee id>')` re-checks it.

The previous single-mosque localStorage app (`app.js`, `hash-chain.js`, `translations/`) is kept for reference while its features are ported onto the new tables.

---

## 🚀 Quick Deployment Guide

### Option 1: Deploy to Netlify (Free & Takes 30 Seconds)

#### Method A: Direct Drag-and-Drop (No Git Required)
1. Go to [https://app.netlify.com/drop](https://app.netlify.com/drop).
2. Sign in or create a free Netlify account.
3. Drag the folder `C:\Users\Syeda\.gemini\antigravity\scratch\idarah` directly into the browser window.
4. Netlify will instantly assign you a live HTTPS URL (e.g., `https://idarah-mosque.netlify.app`).

#### Method B: Connect via GitHub
1. Push this repository to GitHub (see GitHub section below).
2. On Netlify, click **"Add new site"** → **"Import an existing project"** → **GitHub**.
3. Select your `idarah` repository.
4. Leave build command empty and publish directory as `.`. Click **Deploy**.

---

### Option 2: Publish to GitHub & GitHub Pages

1. Create a new repository on [GitHub.com](https://github.com/new) named `idarah` (keep it Public).
2. Run these commands in PowerShell or Terminal inside this folder:
   ```bash
   git branch -M main
   git remote add origin https://github.com/<YOUR-USERNAME>/idarah.git
   git push -u origin main
   ```
3. **To enable free GitHub Pages hosting**:
   - Go to your repository on GitHub.
   - Click **Settings** → **Pages** (on the left sidebar).
   - Under **Build and deployment** > **Branch**, select `main` and `/ (root)`, then click **Save**.
   - In 1–2 minutes, your app will be live at `https://<YOUR-USERNAME>.github.io/idarah/`.

---

## 📱 How to Install on Android & iPhone (PWA & APK)

### 🤖 Android Installation

#### 1. Instant PWA Installation (Recommended)
1. Open your live Netlify or GitHub Pages link in **Google Chrome** on your Android phone.
2. Either:
   - Tap the **"📲 Install App"** button in the top navigation bar, OR
   - Tap Chrome's **3 vertical dots (⋮)** in the top right corner → Tap **"Install app"** (or **"Add to Home screen"**).
3. The app is installed onto your home screen with the Mosque icon, launches in full screen without the browser URL bar, and functions 100% offline!

#### 2. Generate a Downloadable Android `.apk` File (Google Play Store Ready)
If you need an `.apk` file:
1. Deploy your app to Netlify or GitHub Pages (must be an active HTTPS link).
2. Open Microsoft's free PWA Builder: [https://www.pwabuilder.com/](https://www.pwabuilder.com/).
3. Paste your live URL and click **Start**.
4. Click **"Package for Android"** → Select **Download APK / AAB**.
5. You receive an installable `.apk` file ready to install on any Android phone.

---

### 🍏 iPhone (iOS) Installation

Apple iOS allows any web app with a Web Manifest to install as a native home screen app:
1. Open your live link in **Safari** on your iPhone.
2. Tap the **Share button** at the bottom (the square with an arrow pointing upward).
3. Scroll down in the share sheet and tap **"Add to Home Screen"** (➕).
4. Tap **"Add"** in the top right corner.
5. The **Idarah** app icon will appear directly on your iPhone home screen. When opened, it behaves like an iOS app with full screen and offline storage.

---

## 🛡️ Core Features
- **100% Client-Side & Private**: All data is stored in browser `localStorage` with multi-mosque isolation and atomic rollback on failure. Zero online payment gateways or tracking.
- **Triple-Entry SHA-256 Ledger**: Every transaction is chained across 17 cryptographic fields. Transactions cannot be deleted or modified; corrections are signed via permanent Reversal blocks.
- **Zakat Safety**: Strict Shariah rules restricting Zakat and Fitra disbursement to eligible recipients only.
- **Four Languages**: English, Urdu (اردو with right-to-left layout), Hindi (हिन्दी), and Bengali (বাংলা).
- **Madrasa & Quran Tracker**: Student enrollments, duplicate-proof monthly fees linked to the ledger, and Sabaq/Sabqi/Manzil Quran progress.
- **Mosque Civil Registers**: Salah/Jumu'ah timings, staff salary disbursement, Nikah (marriage) and Janazah (funeral) registers, assets, and community bulletins.
- **Public Ledger Explorer**: Allows any community member to verify official receipts and inspect ledger integrity without logging in.
