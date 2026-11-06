# NETRON

NETRON is a temporary email service that lets you generate a disposable inbox in seconds without exposing your personal address. Built for quick signups, one-time verifications, and keeping your real mailbox out of spam lists.

**Live:** [netron.fun](https://netron.fun)

## What it does
- Generates a temporary email address in one click (or pick a custom name)
- Live inbox with 10-second auto-refresh, sound alerts and unread badges
- QR code to transfer the address to your phone
- Mailboxes automatically self-destruct after 60 minutes
- Favorites, search, batch actions (select / favorite / delete)
- Simple pages: About, FAQ, Privacy Policy, Terms of Service

## Under the hood
- **Fully static, client-side app** — no NETRON server, no accounts, no tracking
- Disposable mailboxes are provided by the public [Guerrilla Mail](https://www.guerrillamail.com) API (CORS-friendly, no keys)
- Strict Content-Security-Policy; email HTML is sanitized in the browser before rendering
- Sessions, favorites and preferences live in browser local storage only
- Plain HTML/CSS/JS — no build step, no dependencies, served via GitHub Pages

## Pages
| Page | Purpose |
|------|---------|
| `index.html` | The app: generator + live inbox |
| `about.html` | What NETRON is and how it works |
| `faq.html` | Frequently asked questions |
| `privacy.html` | Privacy policy |
| `terms.html` | Terms of service |

## What it's for
- Signing up on services you don't fully trust yet
- Trial accounts and one-time confirmation emails
- Keeping your real inbox clean and protected from leaks/spam

## Important
This service is intended for legitimate privacy use. Please don't use it for spam, fraud, harassment, or anything illegal.
