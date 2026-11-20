# Idarah - Project Notes

## What the app does
Idarah helps mosques, madarsas, dargahs, imambargahs and charitable trusts in India run their work in one place.
One login (mobile number + password) works for many committees. A committee can have several modules
(Mosque, Madarsa, Dargah, Imambargah, Charitable/Waqf). Each committee only ever sees its own data.
Money is kept in a ledger that cannot be edited or deleted, and any tampering is detected.

## Where things are
- Project folder: `C:\Users\Syeda\OneDrive\Desktop\idarah-repo`
- GitHub: `ahasnain1109/idarah` (the `main` branch is the live app)
- Live site and installed phone app: https://idarah-h12r.netlify.app (updates by itself after every push to `main`)
- Database: Supabase project `jsvvkxomdpgnfbgnhjyd`. SQL files are in `supabase/migrations/` (001, 002, 003 - all already run)

## Tech used
- Plain HTML, JavaScript and CSS (no build tool), installable phone app (PWA)
- Supabase (database, login, security rules), Netlify (hosting), GitHub (code)
- Tests in the `tests` folder (npm)

## Built so far (live)
- Login and sign up with a +91 mobile number and password (no OTP yet)
- Setup wizard: pick modules, fill one short form per module; "Onboard Another Module" later
- Committee switcher; only onboarded modules are shown
- Familiar layout: green header, committee/role bar, tabs (Dashboard, Finance, modules, Reports, Settings)
- Finance: default and custom funds, donations with receipts and WhatsApp share, expenses (no overspending, Zakat funds only allow the 7 Zakat categories), reversals with reasons, Verify Ledger
- Madarsa: students, monthly fees (creates a ledger receipt), attendance with Sabaq/Sabqi/Manzil, teachers and salaries
- Mosque: Salah timings, staff and salaries, Nikah and Janazah registers, assets, notices
- Dargah / Imambargah: events, Langar and Niyaz. Waqf: properties, beneficiaries
- Reports: printable monthly report with signature boxes
- Settings: team and roles, module details, add modules
- Roles are enforced by the database: admin, mutawalli_trustee, imam_zakir, teacher, accountant, volunteer, parent
- The installed phone app refreshes itself after each new version

## In progress
- Nothing right now.

## Left to do
- Public page to check a receipt without logging in
- Urdu, Hindi and Bengali languages (the app is English only now)
- OTP (SMS) login, so nobody can sign up with someone else's number
- Automatic database updates (SQL is pasted by hand today)
- Bill photo upload for expenses
- Bring old data from the first app (it lives in each phone's browser) if needed

## How the code is organised (for Claude)
- No build tool. `index.html` loads plain scripts in this order: `config.js` (helpers), Supabase library (CDN), `supabase-config.js` (generated), `platform-modules.js` (module forms, categories, validation), `platform-core.js` (login, data calls), `platform-onboarding.js` (wizard + form drawing), `platform-ui.js` (pop-up, generic register screen, section registry), `platform-finance.js`, `platform-madarsa.js`, `platform-mosque.js` (also dargah/imambargah/waqf screens), `platform-reports.js`, `platform-app.js` (login screens, header, tabs, dashboard, settings).
- Styles: `style.css` (old look, still used) and `platform.css` (new parts).
- Each module type lists its screens with `P.registerSections(type, [...])`; buttons are hidden by role in the app, but the database (Row Level Security) is what really protects data.
- The old single-mosque app (`app.js`, `hash-chain.js`, `translations/`) is still in the folder for reference but is not loaded.
- Database: 001 = committees, modules, roles, normal tables + security. 002 = funds + tamper-evident ledger. 003 = fee/salary functions. All are safe to re-run.

## How to ship a change
1. Work on a branch, run the tests, then merge into `main` and push. Netlify publishes `main` by itself in about a minute and the installed phone app refreshes itself.
2. A change to `supabase/migrations/` needs the user to paste the SQL in Supabase (SQL Editor, New query, Run). Copy the file to their clipboard with PowerShell `Set-Clipboard` first.
3. Preview without going live: `netlify deploy --build --alias <name>` (Netlify CLI is installed and logged in).

## How to run the tests
- Open a terminal in the `tests` folder. First time only: `npm install`.
- `npm run test:db` (147 checks on the database rules) and `npm run test:ui` (131 checks on the screens). Both must show 0 failed.
- Update a test whenever behaviour changes.

## Things to remember
- Login uses a hidden email `91XXXXXXXXXX@phone.idarah.example.com` + password, because the Supabase Phone provider needs a paid SMS account. "Confirm email" is OFF in Supabase.
- Never use or ask for the Supabase secret / service_role key. Only the publishable key is used (set on Netlify).
- Windows PowerShell adds a hidden BOM to files saved with `Set-Content -Encoding utf8`; write files with the Write tool or .NET UTF8 without BOM. Put git commit messages in a file and use `git commit -F`.

## Rules
- I am not a coder. Explain in simple words, one step at a time.
- Read PROJECT_NOTES.md at the start of every new thread.
- Work on one task at a time. Change only what I ask. Do not touch anything else.
- Before writing code for a big task, show me a short plan and wait for my approval.
- When editing, change only the lines that need changing. Do not rewrite whole files.
- Do not give extra suggestions or alternatives unless I ask.
- Keep replies short. When a task is done, give a 2-3 line summary of what changed.
- Open only the files needed for the task. Do not scan the whole project.
- If you hit the same error twice, stop and tell me. Do not keep retrying.
- When a task is finished, update PROJECT_NOTES.md.
