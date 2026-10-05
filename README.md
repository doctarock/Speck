# Speck

This distribution includes Speck's compiled server, browser interface, and the Genesis runtime modules it uses. It does not include optional plugins, credentials, or user data.

## Getting started

Requirements: Node.js 18 or newer.

```powershell
npm install
npm start
```

Open `http://127.0.0.1:4310`. The server binds to loopback by default and creates fresh runtime data under `data/`. Model, embedding, and browser services are disabled unless explicitly configured. Keep credentials and personal data in local settings, never in this repository.
