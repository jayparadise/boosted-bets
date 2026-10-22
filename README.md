# bet365 → DST Data Entry import

Static page + Vercel functions, no build step. Traders: team password (once per browser) → league → drop bet365 "Webpage, Complete" saves → Import.

## Environment variables (Vercel → Settings → Environment Variables, all environments)
- `DE_USERNAME` / `DE_PASSWORD` — the data-entry account the app saves as (a dedicated import user).
- `APP_PASSWORD` — the shared team password for this page. Leave unset only if the page should be open.
- `BLOB_READ_WRITE_TOKEN` — injected automatically when a Blob store is connected (aliases + import log).

Redeploy after changing environment variables.

## Behaviour
- Players are matched by exact or unambiguous partial name (plus any stored alias); anything else is skipped and listed.
- Games already COMPLETE in the app: only empty cells are filled.
- Games are marked completed only when all five tabs were provided.
- Every game is re-read after saving and any mismatch is reported.
