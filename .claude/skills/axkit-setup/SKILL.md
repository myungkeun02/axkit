---
name: axkit-setup
description: Set up ax-kit on this computer - prerequisites, local store, keychain, model provider, Discord bot creation via the browser with human checkpoints, then hand over to Discord. Use when the user runs /axkit-setup or asks to install ax-kit.
---

# ax-kit setup (draft)

Follow docs/ARCHITECTURE.md section 8 (and docs/DESIGN.md section 3 for details). This file is the order and the human checkpoints. It is a scaffold; steps marked TODO are not implemented yet.

## Hard rules

- Stop and wait at every **HUMAN** step. Never attempt login, 2FA, captcha, ToS/policy acceptance, or typing any secret yourself.
- Never read, print, screenshot or paste a token, API key or client secret. Secrets go in only through `pnpm ax-kit secret set <name>` (hidden input or `--from-clipboard`), typed by the user.
- Do not take screenshots while a secret is visible (steps marked `noScreenshot`).
- If a web page does not look as expected, switch to the manual guide instead of guessing.
- Ask before installing anything system-wide.

## Steps

1. Check: OS, Node >= 22.13, pnpm, git, Chrome; optional gh, gcloud. Show what is missing and ask before installing.
2. `pnpm install`, `pnpm ax-kit setup` (multiple-choice onboarding; writes ~/.ax-kit/config.json, secrets go to keychain service `ax-kit`).
3. Model provider: ask with choices (Anthropic API / OpenAI API / Claude CLI / Codex CLI / local). The user enters keys with `pnpm ax-kit secret set <provider>-api-key`. TODO
4. Discord bot (DESIGN 3.4):
   1. Ask: existing private server or create one.
   2. Open https://discord.com/login — **HUMAN: login, 2FA, captcha.** Wait for "done".
   3. (new server) create it.
   4. https://discord.com/developers/applications → New Application → name.
   5. **HUMAN: accept the Developer Terms and Policy checkbox.** Then press Create.
   6. Bot tab: Message Content Intent on, Public Bot off, save.
   7. Reset Token. **HUMAN: 2FA if asked; copy the token; run `pnpm ax-kit secret set discord-bot-token --from-clipboard`.** No screenshots in this step.
   8. OAuth2 → URL Generator: scopes `bot`, `applications.commands`; permissions: View Channels, Send Messages, Create Public Threads, Send Messages in Threads, Embed Links, Attach Files, Add Reactions, Read Message History, Manage Channels (setup only).
   9. Open the URL, choose the server. **HUMAN: authorize / captcha.**
   10. `pnpm ax-kit discord verify` — channels, owner confirmation button. TODO
5. Install and start the daemon (launchd on macOS). TODO
6. Tell the user: everything continues in Discord (#비서): connectors, Google connection (DESIGN 3.5 — Google Cloud console steps with the same HUMAN checkpoints), folders, ingestion, interview.
