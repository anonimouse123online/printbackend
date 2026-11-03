# Post-Stage A verification and Stage B readiness

## Stage A verification status

Automated verification run for this review:

- Backend unit suite: 8 passed.
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

## Stage B status: blocked before production implementation

No R2 adapter, upload-intent/completion API, upload lifecycle schema, direct browser upload, malware scanner, cleanup worker, or storage quota implementation is present. The current `/files` route uses in-memory Multer, parses PDFs in the request process, writes to local filesystem storage, then creates an orderable file record. The existing file authorization checks are retained, but this is not safe for Render Free's ephemeral disk and is not a malware quarantine flow. Production startup now fails closed with an explicit configuration error until object storage and scanning are implemented.

The code currently permits `STORAGE_DRIVER=s3` in configuration but `src/storage.js` still uses local filesystem functions. Do not set `STORAGE_DRIVER=s3` expecting R2 support. Keep this app off production until a real adapter, fail-closed document lifecycle, and scanner are implemented and tested. Existing files in `storage/private` were not modified or migrated.

Cloudflare R2 supports short-lived S3-compatible presigned `PUT`, `HEAD`, and `GET` operations. A browser upload also requires bucket CORS for the exact frontend origin and needed methods/headers. Presigned URLs are bearer tokens and must remain narrowly scoped and short lived. See [R2 presigned URL documentation](https://developers.cloudflare.com/r2/api/s3/presigned-urls/).

ClamAV is a reasonable low-cost scanner candidate, but it requires a running `clamd` service with updated signature databases. ClamAV documents its TCP protocol as unauthenticated and unencrypted, so it must remain on a private network. A separate worker/scanner service or managed scanning provider is required; the Render Free web service cannot run background workers or one-off jobs, and its filesystem is ephemeral. See [ClamAV daemon protocol](https://docs.clamav.net/manual/Usage/ClamdProtocol.html) and [Render Free service limits](https://render.com/docs/free). Do not mark any document `AVAILABLE` until both server-side PDF validation and a successful scanner verdict have been persisted.

Required deployment configuration once implemented (not currently consumed by a functioning R2 adapter): R2 account ID/endpoint, bucket, access key ID, secret access key, allowed frontend origin(s), scanner service endpoint and authentication, database URL with a deployment-appropriate connection limit, JWT secret, and explicit trusted CORS origins. Never expose R2 credentials in Vite variables or frontend code. Configure R2 bucket CORS for the exact frontend origin, `PUT`/`HEAD`/`GET`, and only required headers such as `Content-Type`.

## Resource measurements

Express/Pino already records response duration. This review adds process RSS, heap, and external-memory values to request completion logs, plus PDF validation duration and concurrency. These are point-in-time diagnostics, not benchmark results. No before/after load test, query-count capture, or production memory profile was available. `MAX_CONCURRENT_PDF_VALIDATIONS` defaults to 1 and accepts 1–4; this bounds simultaneous PDF parser calls but does not move parsing off the Express process.

## Render readiness

Not deployment-ready. Local file persistence is incompatible with Render Free's ephemeral filesystem; private object storage and scanner infrastructure are absent. Production DB migration state, connection limits, bucket CORS, external credentials, cleanup scheduling, and cold-start behavior were not verified. The health and readiness endpoints exist, graceful SIGINT/SIGTERM shutdown is present, and CORS is configured from `TRUSTED_ORIGINS`; these checks do not resolve the storage and scanning blockers.
