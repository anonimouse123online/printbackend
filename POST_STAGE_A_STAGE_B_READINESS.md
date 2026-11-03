# Post-Stage A verification and Stage B readiness

## Stage A verification status

Automated verification run for this review:

- Backend unit suite: 11 passed.
- Backend API integration suite: passed (the single end-to-end integration test).
- Frontend production build: passed with Vite; output was written to a temporary directory outside the frontend tree.
- Browser walkthrough: not performed. Browser automation is not available in this environment.
- Frontend automated behavior tests: none are configured. The frontend package currently has no test script or test framework.

Manual browser checklist before release:

1. Explore Shops: search by city and shop text, change city rapidly, load another page, and verify search results do not duplicate or flash stale city results.
2. Customer order creation: upload a valid PDF, try an invalid PDF and a file over the limit, select each order option, submit, and verify the created order and price.
3. Checkout and tracking: verify pending payment refreshes, successful payment stops polling, and API errors show a retryable message.
4. Owner order management: switch between dashboard tabs, load more orders, confirm/reject an order, and verify the list and metrics refresh.
5. Customer and owner chat: open an existing conversation, receive a new message while it is open, send a message, and confirm stable ordering when messages share a timestamp.
6. Admin and owner dashboard queries: verify overview-only requests are lazy, list pagination works, and action results refresh the relevant data.
7. Authentication: log in, log out, switch between two accounts, and confirm cached account data is not shown to the next account, including in a second browser tab.
8. Loading/error/empty states: check initial loading, empty lists, invalid credentials, unauthorized routes, and a failed list request.
9. Navigation: use refresh, browser back/forward, and direct links to Explore, order tracking, and dashboard routes.
10. Temporary API outage: stop the API during list, tracking, chat, and upload requests; restore it and verify errors are understandable and retries recover.

## Stage B implementation status

The code now includes an R2 S3-compatible private storage adapter, PDF quarantine and promotion, authenticated/rate-limited uploads, file signature and PDF parsing checks, a fail-closed ClamAV INSTREAM client, available/quarantined/rejected/expired states, a transaction-locked per-user document quota, authenticated no-store downloads, and expiry cleanup. Production startup requires R2 configuration, a private Render ClamAV hostname, a strong JWT secret, an HTTPS PostgreSQL URL, and exact HTTPS CORS origins. There is no scanner bypass in production.

A new additive Prisma migration adds the document scan lifecycle. Existing records become QUARANTINED by default. The four existing cloud document records each reference a local PDF that is present and matches the recorded byte size. Their metadata is preserved, but they are not orderable or downloadable until the actual PDFs are transferred and scanned. Use `npm run storage:migrate-local` after applying the schema migration and configuring R2 plus a local ClamAV endpoint; it requires a private `PRINTREADY_MIGRATION_DATABASE_URL` pointing to the Render external PrintReady URL with `sslmode=require`. It does not change the local development `DATABASE_URL` or delete local files.

The retention cleanup runs at process start and periodically while the API is running. It deletes expired unlinked documents and removes expired document objects after their attached orders have been terminal for the configured retention period, while preserving linked metadata. On Render, cleanup can be delayed while a service is stopped or unavailable; it catches up on the next process start.

Unit and API tests use Vitest's test-only malware scanner stub. Production code always calls ClamAV. Integration tests are guarded to the local development `printready` database and clean their generated test rows and objects.

R2 uses Cloudflare's S3-compatible API. The bucket must remain private; the API proxies authorized downloads, so browser-to-bucket CORS and public URLs are not used. ClamAV's TCP protocol is unauthenticated and unencrypted, so production configuration only accepts a Render private-network hostname. See [Cloudflare R2 S3 compatibility](https://developers.cloudflare.com/r2/api/s3/) and [ClamAV INSTREAM protocol](https://docs.clamav.net/manual/Usage/ClamdProtocol.html).

## Required production environment

- `NODE_ENV=production`, `PORT` (Render supplies it), `DATABASE_URL` (the existing Render database's internal URL), and a rotated `JWT_SECRET` of at least 64 characters.
- `TRUSTED_ORIGINS=https://printready-z0fn.onrender.com` and `FRONTEND_URL=https://printready-z0fn.onrender.com` unless the frontend uses a different verified origin.
- `STORAGE_DRIVER=r2`, `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY`. Keep all four credentials in Render secrets and grant the key access only to the private bucket.
- `CLAMAV_HOST=<private-service>.internal` and `CLAMAV_PORT=3310`. The scanner daemon must be reachable only over the private network and configured with a stream limit at least as large as `MAX_UPLOAD_BYTES`.
- `USER_STORAGE_QUOTA_BYTES`, `MAX_UPLOAD_BYTES`, and `FILE_RETENTION_DAYS` may use the documented defaults in `.env.example`.

Do not copy the local `.env` into Render wholesale. The local file keeps `STORAGE_DRIVER=local` and the local PostgreSQL URL. Real payment-provider checkout/webhooks are still disabled; the existing manual shop-payment flow remains available.
## Resource measurements

Express/Pino already records response duration. This review adds process RSS, heap, and external-memory values to request completion logs, plus PDF validation duration and concurrency. These are point-in-time diagnostics, not benchmark results. No before/after load test, query-count capture, or production memory profile was available. `MAX_CONCURRENT_PDF_VALIDATIONS` defaults to 1 and accepts 1–4; this bounds simultaneous PDF parser calls but does not move parsing off the Express process.

## Render readiness

NOT READY. The Render account currently has the PrintReady static frontend only; there is no PrintReady backend web service. The backend repository is `https://github.com/anonimouse123online/printbackend`, branch `main`. Suggested service settings once dependencies are provisioned: Oregon, Node, `npm ci && npm run db:generate && npm prune --omit=dev --omit=peer` build command, `npm start` start command, and `/api/v1/health/ready` HTTP health check. The production-only dependency prune was simulated and reported zero advisories; the full development tree still includes Prisma CLI advisories.

No R2 bucket, R2 credentials, private ClamAV service, or backend service was created. Render MCP does not expose the existing database connection URL through the service details available here. The existing internal database URL must be added to the backend service as the `DATABASE_URL` secret when it is created. Render supports private service communication by region and application-level health checks; see [Render web services](https://render.com/docs/web-services) and [Render health checks](https://render.com/docs/health-checks).

Before deployment, approve or provision the private bucket and scanner service, securely configure their credentials, apply the additive Prisma migration to the existing Render database, scan and transfer the four local PDFs, and verify the production startup and readiness endpoint. Do not declare the service ready until the real R2 bucket and ClamAV scanner are reachable and the four legacy records are AVAILABLE.