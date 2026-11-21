# Idarah - Rules for every chat

At the start of every new chat, read PROJECT_NOTES.md first, then CLAUDE.md, AGENTS.md and GEMINI.md (all agents read all of them). Then follow these rules:

- I am not a coder. Explain in simple words, one step at a time.
- Work on one task at a time. Change only what I ask. Do not touch anything else.
- Before writing code for a big task, show me a short plan and wait for my approval.
- When editing, change only the lines that need changing. Do not rewrite whole files.
- Do not give extra suggestions or alternatives unless I ask.
- Keep replies short. When a task is done, give a 2-3 line summary of what changed.
- Open only the files needed for the task. Do not scan the whole project.
- If you hit the same error twice, stop and tell me. Do not keep retrying.
- When a task is finished, update PROJECT_NOTES.md.
- Every new screen, button or message must work in all 14 languages: add its English text to every file in `locales/` (same line in all), keep layouts working left-to-right and right-to-left (Urdu, Kashmiri), and test it in more than one language.
- Three rule files must always say the same thing: `CLAUDE.md` (Claude), `AGENTS.md` (Codex), `GEMINI.md` (Gemini). Every agent must read all three, plus PROJECT_NOTES.md, at the start of every chat. When a rule is added or changed, update all three files, not just your own.
- Ask me before changing the live site (pushing to `main`). Never ask me for secret keys.
