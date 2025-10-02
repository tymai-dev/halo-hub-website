# HaloHub Website

A single-page launch site for **HaloHub**, a community platform that circulates physical, enriching resources so children can flourish beyond the screen. The project now ships with a Cloudflare Worker backend that validates pilot sign-up submissions, verifies Cloudflare Turnstile tokens, and persists data to a D1 database.

## Getting started

Open `index.html` in your browser to explore the experience. The page is fully static and styled with `styles.css`; interactive touches (dynamic year, form submission flow, Turnstile integration) live in `script.js`.

### Front-end configuration

The page reads two data attributes from the `<body>` element:

- `data-worker-endpoint` – the fully qualified URL for your deployed Worker endpoint (for example, `https://halo-hub-submissions.your-account.workers.dev/submissions`).
- `data-turnstile-sitekey` – the Turnstile site key created in the Cloudflare dashboard.

Update those values after you provision the Worker and Turnstile site.

## Structure

- `index.html` – landing page markup with mission, product story, pilot sign-up forms, and Turnstile widgets.
- `styles.css` – global design language featuring gradients, glassmorphism, responsive layouts, and form state styles.
- `script.js` – form submission logic that renders Turnstile, validates client-side configuration, and sends JSON payloads to the Worker.
- `worker/` – Cloudflare Worker source (TypeScript), Wrangler configuration, and helper files.
- `migrations/` – SQL migrations for the D1 database schema.

## Cloudflare Turnstile setup

1. Sign in to the [Cloudflare dashboard](https://dash.cloudflare.com/).
2. Navigate to **Turnstile** → **Add site**.
3. Choose a descriptive name, select the widget type (managed recommended), and add your domains (`https://tymai-dev.github.io` and `https://halohub.com`).
4. Copy the generated **Site Key** and **Secret Key**.
5. Update `index.html` so that `data-turnstile-sitekey` equals your site key.
6. Store the secret key in the Worker with Wrangler:

   ```bash
   cd worker
   npx wrangler secret put TURNSTILE_SECRET
   ```

## Worker configuration and deployment

The Worker code lives in `worker/src/index.ts`. Wrangler reads configuration from `worker/wrangler.toml`.

### D1 schema

The D1 tables for the three pilot forms are defined in `migrations/0001_create_tables.sql`:

```sql
-- D1 schema for HaloHub pilot submissions
CREATE TABLE IF NOT EXISTS families (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  region TEXT NOT NULL,
  interest TEXT,
  submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS donors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  focus TEXT,
  message TEXT,
  submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS collaborators (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  expertise TEXT,
  idea TEXT,
  submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_families_email ON families(email);
CREATE INDEX IF NOT EXISTS idx_donors_email ON donors(email);
CREATE INDEX IF NOT EXISTS idx_collaborators_email ON collaborators(email);
```

### Create the D1 database binding

1. Provision a D1 database in the Cloudflare dashboard (Workers &amp; Pages → D1 → Create Database).
2. Copy the database ID and replace `REPLACE_WITH_D1_DATABASE_ID` in `worker/wrangler.toml`.
3. Optional: adjust `ALLOWED_ORIGINS` in `worker/wrangler.toml` to include additional domains separated by commas.

### Run migrations with Wrangler

From the `worker/` directory:

```bash
cd worker
npx wrangler d1 execute halo_hub_submissions --file=../migrations/0001_create_tables.sql
```

Replace `halo_hub_submissions` with the database name you chose if it differs.

### Deploy the Worker

```bash
cd worker
npx wrangler deploy
```

Wrangler will bundle the TypeScript Worker, upload it to Cloudflare, and print the deployed URL. Copy that URL into the `data-worker-endpoint` attribute in `index.html`.

### View submissions from D1

Use Wrangler to inspect your records (again from `worker/`):

```bash
npx wrangler d1 execute halo_hub_submissions --command "SELECT * FROM families ORDER BY submitted_at DESC LIMIT 25;"
npx wrangler d1 execute halo_hub_submissions --command "SELECT * FROM donors ORDER BY submitted_at DESC LIMIT 25;"
npx wrangler d1 execute halo_hub_submissions --command "SELECT * FROM collaborators ORDER BY submitted_at DESC LIMIT 25;"
```

Adjust the `SELECT` statements to filter or paginate as needed.

## What the Worker does

- Accepts JSON `POST` requests containing `formType`, `data`, and a `cf-turnstile-response` field (alias `turnstileToken` supported).
- Rejects requests that fail schema validation, Turnstile verification, or originate from outside the allowed domains.
- Writes valid submissions into the corresponding D1 table.
- Responds with `{"ok": true}` on success or a descriptive error message on failure.
- Supports CORS (restricted to `https://tymai-dev.github.io` and `https://halohub.com`) and handles `OPTIONS` preflight requests.

Once the Worker is deployed and the front-end attributes are updated, visitors can complete the Turnstile challenge, submit the form, and receive immediate confirmation without leaving the page.
