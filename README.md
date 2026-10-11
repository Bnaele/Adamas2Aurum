# Adamas2Aurum

[![Deployed App](badges/badge-deploy.svg)](https://website.adamas2aurum.workers.dev)
![Tests](badges/badge-tests.svg)
![Statements](badges/badge-statements.svg)
![Branches](badges/badge-branches.svg)
![Functions](badges/badge-functions.svg)
![Lines](badges/badge-lines.svg)

A location-based campus trivia and card-battle game.

---

## Tech Stack

### Frontend

- Plain HTML, CSS, and JavaScript (ESM) (no framework)

### Backend

- [Node.js](https://nodejs.org/) with [Express](https://expressjs.com/) 5
- [MySQL](https://www.mysql.com/) 8.4 via `mysql2/promise` (local or Aiven-hosted)
- [Better Auth](https://www.better-auth.com/) for email/password + Google OAuth
- `express-session` for session-based auth; a bridge middleware maps Better Auth
  sessions to `req.session.user` so existing routes (events, trivia, questions)
  keep working without modification
- The backend **also serves the frontend** statically from port 3000, so
  everything runs same-origin — no separate Vite dev server needed unless you
  want HMR during frontend development

### Tooling

- [Jest](https://jestjs.io/) for frontend and backend unit tests

### Formatting

- [Prettier](https://prettier.io/)

---

## Project Structure

```
Adamas2Aurum/
├── app/
│   └── src/
│       ├── frontend/       # Vite + vanilla JS + Leaflet map
│       │   ├── js/
│       │   ├── css/
│       │   ── pages/      # auth, events, console, map
│       |
│       ├── frontend/       # Vanilla JS + Leaflet map (served by backend on :3000)
│       │   ├── js/          # main, console, events, auth, geolocation, utils
│       │   ├── css/         # style.css, map.css
│       │   ├── pages/       # auth, events, console, map
│       ├── frontend/       # plain JS + Leaflet map
│       │   ├── js/
│       │   ├── css/
│       │   └── pages/      # auth, events, console, map
│       └── backend/        # Express API
│           ├── routes/     # auth, events, trivia
│           ├── websocket/  # websockets (battle, and etc.)
│           ├── db/         # schema.sql, seed.sql
│           └── utils/
├── docs/
└── RUNNING.md              # local setup instructions
├── .env
└── package.json
├── package.json
├── .prettierrc.yaml
├── .prettierignore
├── setup.py          # automated setup
├── db_connect.py     # connects to the DB via the mysql CLI
└── README.md
```

---

## Prerequisites

- Node.js 18+
- npm
- Python 3 - for `setup.py` and `db_connect.py`
- Docker & Docker Compose - only needed for [local DB setup](#local-db-setup)
- MySQL client (`mysql`) - only needed if you want to connect via `db_connect.py`
     - Or alternatively MariaDB client (`mariadb`)

---

## Getting Started

### Quick start

The setup script installs dependencies, optionally sets up a MySQL DB using Docker, and starts both the backend and frontend. It's cross-platform, so the same command works on macOS, Linux, and Windows:

```bash
$ python3 setup.py          # start mode
$ python3 setup.py --dev    # dev mode
```

You'll be prompted whether to set up the local database.

### Manual setup

If you'd rather run each step yourself:

1. Install dependencies:

```bash
$ npm run install-deps
```

> **Note:** This runs `npm install` at the project root, then inside `app/src/backend`, since the backend has its own `package.json`.

2. Start the backend:

```bash
$ npm run dev:backend     # dev mode
$ npm run start:backend   # production mode
```

> `dev:backend` and `start:backend` delegate to `app/src/backend`, which needs its own matching `dev` and `start` scripts.

3. Serve the frontend:

```bash
$ npm run dev:frontend     # dev mode
$ npm run start:frontend   # production mode
```

> **Note**: Both currently run the same command (`serve app/src/frontend -l 8055`) - this serves the frontend as static files and does not hot-reload on change.

---

## Local DB setup

This project can be set up to use MySQL locally via Docker.

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/)
- [Docker Compose](https://docs.docker.com/compose/install/)

### Setup

1. Copy the example env file:

```bash
$ cp app/src/backend/.env.example app/src/backend/.env
```

2. Start the database:

```bash
$ npm run db:up
```

3. Create Better Auth's tables (needed for Google / email sign-in):

```bash
$ npm run db:migrate-auth
```

### How It Works

1. **Schema auto-creates** on startup — `server.js` calls
   `initialize_database()` which runs `schema.sql` with
   `CREATE TABLE IF NOT EXISTS` for every table (events, users,
   admin_roles, questions, trivia_questions, trivia_options, …).
   This is safe and non-destructive — existing data is never touched.
2. **Better Auth** does **not** create its own tables (`user`,
   `session`, `account`, `verification`) — Google and email sign-in
   return 500 until they exist. Create them once per database with
   `npm run db:migrate-auth` (`setup.py` does this for you). It uses
   Better Auth's own migration planner, is additive and safe to re-run.
   On startup the server only _checks_ and logs a warning if they're
   missing — it never migrates automatically, since that would also
   touch any shared/deployed DB the server points at.
3. **Bridge middleware** runs on every request: if a Better Auth
   session exists, it looks up (or creates) a matching row in the
   `users` table and populates `req.session.user` so that existing
   routes can read `req.session.user.user_id` without modification.
4. **Auth flow**: sign up / sign in via `POST /api/auth/sign-up/email`
   and `POST /api/auth/sign-in/email` (Better Auth), or use the legacy
   PIN-based `POST /api/auth/login` (see Auth Architecture below).
5. **Roles**: the `admin_roles` table stores roles per user
   (`EVENT_AUTHOR`, `SUPER_ADMIN`). Author-only routes check this table
   via the `requireEventAuthor` middleware.

### Seeding the database

npm run dev
=======

$ npm run db:up

````

- Stop the database:

```bash
$ npm run db:down
````

> **Note:** To delete the DB completely, run `docker compose down -v` from `app/src/backend`.
>
> On Linux (maybe macOS, too), `db:up` might need to be run with `sudo` depending on your Docker install (`setup.py` does not do this, so you would have to go to `app/src/backend/package.json` and add sudo to those scripts manually, or add the current `$USER` to the `docker` group so elevation isn't needed).
>
> On Windows, elevation (apparently) isn't required with Docker Desktop.

### Connecting via the MySQL CLI

Once the database is running, you can connect to it directly with:

```bash
$ python3 db_connect.py
```

This reads connection settings from your `app/src/backend/.env` (falling back to sane defaults if it isn't there) and calls the `mysql` (or `mariadb`) client for you, automatically passing `--ssl-ca=app/src/backend/certs/ca.pem` or `--skip-ssl` depending on `DB_SSL`. Requires the `mysql` (or `mariadb`) client to be installed and on your `PATH`.

### Seeding the database

Seeding is **not automatic** — startup only creates tables. To populate
seed data (users, events, trivia questions, admin roles), run once:

Seeding is not automatic - `npm run dev` only creates tables if they don't
exist yet (safe, non-destructive). To populate test data (users, events,
trivia questions, etc.), run once:

```bash
$ npm run db:seed
```

> This TRUNCATEs and re-inserts all seed data on the **shared** Aiven
> database. Don't run it while teammates are actively testing - check in
> the group chat first. If your login suddenly stops working with
> "Invalid credentials" even though nothing changed, it likely means
> someone else ran `db:seed` (or an older backend re-seeded automatically)
> and your test account got wiped - just log in with a seeded account
> again, or re-run `db:seed` yourself if needed.

### Test accounts

After seeding, you can log in with any of these accounts using **Username + PIN** in the auth drawer:

| Username / Email     | PIN  | Role           | Landing page after login |
| -------------------- | ---- | -------------- | ------------------------ |
| `alice@example.com`  | 1234 | `SUPER_ADMIN`  | Console                  |
| `admin@wits.ac.za`   | 1234 | `SUPER_ADMIN`  | Console                  |
| `bob@example.com`    | 1234 | `EVENT_AUTHOR` | Console                  |
| `player@example.com` | 1234 | (player)       | Events                   |

---

## Testing

Tests run on Jest with support for ESM:

```bash
$ npm test              # run all tests
$ npm run test:frontend # frontend only
$ npm run test:backend  # backend only
$ npm run test:watch    # watch mode
```

### Validation rules

- **MULTIPLE_CHOICE**: `options` must be a non-empty array;
  `correctAnswer` must be one of the option strings.
- **TRUE_FALSE**: `correctAnswer` must be `"true"` or `"false"`.
- **FILL_BLANK**: `correctAnswer` is the expected answer text (any
  non-empty string).
- Invalid combinations return `400 Bad Request`.

### Console UI

On the event edit view in the admin console (`/pages/console.html`), a
**Questions panel** appears below the event form. It shows all questions
attached to the current event with add/edit/delete controls:

- **Type selector** switches between MC / TF / FB.
- **Options list** (add/remove rows) appears only for multiple choice.
- **Correct answer** field is always shown (with a datalist of options
  for MC).
- **Delete** uses a confirmation modal matching the existing event-delete
  pattern.

### Files

- `app/src/backend/db/schema.sql` — `questions` table (additive)
- `app/src/backend/routes/questions.js` — CRUD route file (new)
- `app/src/backend/server.js` — route registration (additive)
- `app/src/frontend/pages/console.html` — Questions panel + delete modal
- `app/src/frontend/js/console.js` — question CRUD logic (appended)
- `app/src/frontend/css/style.css` — question panel styling (appended)

Test files are matched as `*.test.js` under each project's `rootDir`.

---

## Formatting

Code style is maintained with Prettier:

```bash
$ npm run format        # write formatting fixes
$ npm run format:check  # verify formatting (CI-friendly, no writes)
```

A gate middleware in `server.js` checks the request path: PIN-specific
paths (`/login`, `/register`, `/me`, `/logout`) bypass Better Auth and
fall through to the PIN auth router. All other `/api/auth/*` paths go to
Better Auth.

### Frontend auth

- The **console page** (`/pages/console.html`) uses PIN login
  (`POST /api/auth/login` with `{ email, pin }`).
- The **map page** (`/`) uses Better Auth via the auth drawer
  (`auth-client.js` → Better Auth client SDK).

---

## Testing Accounts

The accounts below are provided for testing:
1. Bob
    * Email: `bob@example.com`
    * Password: `1234`
1. Alice 
    * Email: `alice@example.com`
    * Password: `1234`

---

## Team

Developed by **404 Found Us**, Software Design Project — University of the Witwatersrand.
