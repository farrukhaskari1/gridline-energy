# Gridline Energy

Gridline Energy is a self-hosted solar and home-energy dashboard. It collects data from an iTel-compatible energy account, stores normalized telemetry in Cloudflare D1, and presents live power flow, historical production, battery state, grid usage, devices, and multi-site views.

![Gridline Energy dashboard](public/og.png)

## What it includes

- Live solar, load, grid, battery, and generator power
- Daily, monthly, and yearly energy history
- Multiple provider accounts and stations
- Encrypted provider credentials at rest
- Stale/offline state detection instead of presenting old data as live
- Weather-aware dashboard themes using Open-Meteo
- ChatGPT Sites identity support with a safe local-preview mode

## Architecture

The web client reads only from Gridline's API routes. Server-side routes authenticate the viewer, obtain the correct site's encrypted credentials, call the upstream energy provider, normalize readings, and store telemetry and rollups in D1.

```text
Browser -> Gridline API -> D1
                    \-> iTel-compatible provider API
                    \-> Open-Meteo
```

Provider passwords are encrypted with AES-256-GCM before storage. The encryption key belongs in deployment secrets and must never be committed.

## Requirements

- Node.js 22.13 or newer
- An iTel-compatible energy account
- A Cloudflare D1 database exposed to the worker as `DB`
- OpenAI Sites for the included hosted authentication flow, or equivalent trusted identity headers in your own deployment

## Local setup

1. Install dependencies:

   ```bash
   npm ci
   ```

2. Copy the safe environment template and fill in your own values:

   ```bash
   cp .env.example .env.local
   openssl rand -base64 32
   ```

   Put the generated value in `GRIDLINE_CREDENTIAL_KEY`. Never reuse a production key locally or commit an environment file.

3. Configure a D1 binding named `DB`. For OpenAI Sites, create your own local `.openai/hosting.json` from `.openai/hosting.example.json` and replace the placeholder project ID with your project ID. Without that local file, the Sites packaging plugin is intentionally disabled.

4. Apply the SQL migrations in `drizzle/` to the database.

5. Start the development server:

   ```bash
   npm run dev
   ```

The first local request can bootstrap the account from `ITEL_USERNAME` and `ITEL_PASSWORD`. Hosted users can add accounts through the settings UI when `GRIDLINE_CREDENTIAL_KEY` is configured.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `GRIDLINE_CREDENTIAL_KEY` | Hosted multi-account use | Base64-encoded 32-byte AES key used to encrypt provider credentials |
| `ITEL_USERNAME` | Optional | Local bootstrap or legacy single-account username |
| `ITEL_PASSWORD` | Optional | Local bootstrap or legacy single-account password |
| `SITE_LATITUDE` | Optional pair | Weather fallback latitude when station metadata is unavailable |
| `SITE_LONGITUDE` | Optional pair | Weather fallback longitude when station metadata is unavailable |
| `NEXT_PUBLIC_APP_URL` | Production metadata | Public origin used for social-preview metadata |

If weather coordinates are omitted and the selected station has no coordinates, the weather endpoint returns an unavailable response rather than using a hidden default location.

## Verification

```bash
npm run lint
npm test
```

`npm test` performs a production build and runs the unit and rendered-HTML tests.

## Security and privacy

- Do not commit `.env` files, provider credentials, D1 exports, deployment configuration, access tokens, or signing files.
- Use a unique `GRIDLINE_CREDENTIAL_KEY` per environment and keep it in the hosting platform's secret store.
- Rotating that key makes existing encrypted provider credentials unreadable; reconnect accounts after rotation.
- Keep production deployments private unless you have reviewed the authentication and access policy for your host.
- Treat station names, coordinates, device serial numbers, and energy readings as private household data.

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## Provider notice

The iTel-compatible integration uses an independently implemented, undocumented provider API and may stop working if the provider changes it. Gridline Energy is not affiliated with or endorsed by iTel or the upstream API operator. Use it only with accounts and systems you are authorized to access.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## License

Gridline Energy is available under the [MIT License](LICENSE).
