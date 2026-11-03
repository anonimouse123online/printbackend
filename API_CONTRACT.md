# PrintReady API contract

Base URL: `http://localhost:5001/api/v1`. JSON responses use `{ "data": ... }`; errors use `{ "error": { "code", "message", "details?" } }`. Send `Authorization: Bearer <JWT>` for protected routes. The default token expires after one hour; logout is client-side token disposal because this MVP uses stateless JWTs.

## Authentication and accounts

| Method | Path | Access | Behavior |
|---|---|---|---|
| POST | `/auth/register` | Public, rate limited | Customer registration. Fields: `fullName`, `email`, `password` (12+ chars). |
| POST | `/auth/register/shop-owner` | Public, rate limited | Shop owner registration; role is fixed server-side. |
| POST | `/auth/login` | Public, rate limited | Returns user and bearer token. |
| POST | `/auth/logout` | Authenticated | Stateless logout acknowledgment; discard token in client. |
| GET | `/auth/me` | Authenticated | Current account. |
| PATCH | `/users/me` | Authenticated | Update `fullName`. |

Roles are `CUSTOMER`, `SHOP_OWNER`, `ADMIN`. Roles and ownership IDs are never accepted from registration or order payloads. Password reset is not implemented; configure a verified email delivery and single-use reset-token workflow before launch.

Health checks: `GET /health` is a liveness check; `GET /health/ready` runs `SELECT 1` against PostgreSQL and returns `503 DATABASE_UNAVAILABLE` when the database is not ready.

## Shops

| Method | Path | Access | Behavior |
|---|---|---|---|
| GET | `/shops?city=&lat=&lng=&radiusKm=` | Public | Lists verified, open shops; optional geographic distance filter. |
| GET | `/shops/:id` | Public | Verified shop, services, hours. |
| POST | `/shops` | Shop owner | Register shop; starts `PENDING`. |
| PATCH | `/shops/:id` | Owning shop owner | Update profile/status. |
| GET | `/shops/:id/services` | Public | Available services and price configuration. |
| PUT | `/shops/:id/services` | Owning shop owner | Replace services/pricing. Rates are integer cents per page, keyed like `A4:BW:SINGLE`; optional `bindingCents` maps binding name to cents per copy. |
| PUT | `/shops/:id/hours` | Owning shop owner | Replace weekday schedule (`weekday`: 0 Sunday through 6 Saturday; times `HH:mm`). |
| PUT | `/shops/:id/payment-qr` | Owning verified shop owner | Multipart fields `qrImage` (PNG/JPEG, up to 2 MiB), `paymentMethod` (`GCASH` or `MAYA`), `recipientName`, optional `walletNumber`. Stores a private QR for future order confirmations and returns non-secret account settings. |

Growing list endpoints accept optional `limit` (1–200; shop discovery caps at 100) and opaque `cursor` query parameters. Existing response arrays remain unchanged; paginated responses add `pagination: { limit, hasMore, nextCursor }`. Send `nextCursor` unchanged to retrieve the next page. Ordering is stable by creation time and ID. This applies to `/shops`, `/orders`, `/owner/orders`, `/admin/shops/pending`, `/admin/orders`, and `/admin/disputes`. Clients that omit pagination parameters receive the first page (up to the existing endpoint limit, or 100 for previously unbounded lists).

Shop owner example:

```json
{"fullName":"A. Owner","email":"owner@example.ph","password":"use-a-long-password"}
```

Service configuration example:

```json
{"services":[{"serviceName":"Document printing","serviceType":"DOCUMENT","isAvailable":true,"pricingConfiguration":{"rates":{"A4:BW:SINGLE":200,"A4:BW:DOUBLE":300,"A4:COLOR:SINGLE":1000,"A4:COLOR:DOUBLE":1600},"bindingCents":{"none":0,"comb":2500}}}]}
```

## Files

| Method | Path | Access | Behavior |
|---|---|---|---|
| POST | `/files` | Customer | Multipart `file` field, PDF only, private storage, page count and size validated. |
| GET | `/files/:id` | Owner, admin, or assigned shop after payment | Authenticated PDF download. |
| GET | `/orders/:orderId/files/:fileId` | Customer or assigned shop owner for an order containing the file | Authenticated PDF download scoped through the PostgreSQL order/shop relationship. |
| DELETE | `/files/:id` | Owner/admin | Deletes unattached file. |

The local storage adapter stores files outside public web roots with random names. Configure S3-compatible private storage before horizontal production deployment. A malware scanning/quarantine integration is not implemented and is a launch blocker. Expired file cleanup must be scheduled by operations; automatic deletion worker is not included.

## Orders and pickup

| Method | Path | Access | Behavior |
|---|---|---|---|
| POST | `/orders` | Customer | Creates a submitted order. Items specify `fileId`, `serviceId`, `paperSize`, `colorMode` (`BW`,`COLOR`), `printSides` (`SINGLE`,`DOUBLE`), `copies`, optional `pageRange`, `bindingType`, and `specialInstructions`. Server computes cents total. |
| GET | `/orders` | Authenticated | Customer's, owner's shop orders, or admin orders. |
| GET | `/orders/:id` | Customer (own), assigned shop owner, or admin | Order details, customer fulfillment contact, shop, printing services/specifications, items/files metadata, and status history. Other customers and owners receive `404` to avoid revealing order existence. |
| PATCH | `/orders/:id/confirm` | Assigned shop owner | Atomically changes `SUBMITTED` → `AWAITING_PAYMENT` and creates an idempotently retrievable manual-payment record with exact amount and recipient/QR snapshot. Requires the verified shop owner to configure QR details first. |
| PATCH | `/orders/:id/reject` | Assigned shop owner | `SUBMITTED` → `REJECTED`; optional `reason`. |
| PATCH | `/orders/:id/status` | Assigned shop owner | Advances to `IN_QUEUE`, `PRINTING`, or `READY_FOR_PICKUP` per state graph. |
| POST | `/orders/:id/cancel` | Customer, assigned owner, admin | Cancels eligible unpaid orders. Paid-order refund processing is not exposed. |
| POST | `/orders/:id/pickup/confirm` | Order customer or assigned shop owner | Empty JSON body. Requires `READY_FOR_PICKUP` and a verified (`SUCCEEDED`) payment. The authenticated caller is recorded as confirmer; returns `{ "data": { "order": ..., "idempotent": boolean } }`. Repeating after completion is safe and preserves the original confirmer. |
| POST | `/orders/:id/pickup/verify` | Retired | Returns `410 PICKUP_TOKEN_RETIRED`; legacy pickup tokens remain stored for historical compatibility and are not required for active pickup. |
| POST | `/orders/:id/pickup/disputes` | Order customer or assigned shop owner | Body `{ "reason": "..." }` (10–2000 characters). Opens one administrator-reviewed pickup dispute per order; duplicates return the existing dispute. |
| GET | `/admin/disputes` | Administrator | Lists pickup disputes with order, shop, customer, opener, and reviewer details. |
| PATCH | `/admin/disputes/:id` | Administrator | Body `{ "status": "RESOLVED"|"DISMISSED", "resolutionNotes": "..." }`; records reviewer/time and an audit event. |
| POST | `/reviews` | Customer | Review own completed order once. |
| GET | `/orders/:id/messages?limit=50&before=<ISO timestamp>` | Customer or assigned shop owner | Returns paginated messages in ascending time order, sender details, timestamps, `readAt`, `hasMore`, `nextBefore`/`nextBeforeId`, and (for polling) `nextAfter`/`nextAfterId`. Fetching marks messages addressed to the caller as read. Use `after=<ISO timestamp>` for polling; optionally pair it with `afterId=<message id>` to safely continue when messages share a timestamp. `beforeId` works the same way with `before`. Do not combine `before` and `after`. |
| POST | `/orders/:id/messages` | Customer or assigned shop owner; 30/minute | Body `{ "message": "..." }`; trimmed text, 1–4000 characters. Returns `{ "data": { "message": ... } }`. |
| GET | `/orders/messages/unread-count` | Customer or shop owner | Returns `{ "data": { "unreadCount": number, "byOrder": [{ "orderId": "...", "count": number }] } }`. |

Statuses: `DRAFT`, `SUBMITTED`, `AWAITING_PAYMENT`, `PAID`, `IN_QUEUE`, `PRINTING`, `READY_FOR_PICKUP`, `COMPLETED`, `REJECTED`, `CANCELLED`, `REFUND_PENDING`, `REFUNDED`.

Valid transitions: `SUBMITTED` → `AWAITING_PAYMENT`, `REJECTED`, `CANCELLED`; `AWAITING_PAYMENT` → `PAID`, `CANCELLED`; `PAID` → `IN_QUEUE` or `REFUND_PENDING`; `IN_QUEUE` → `PRINTING` or `REFUND_PENDING`; `PRINTING` → `READY_FOR_PICKUP` or `REFUND_PENDING`; `READY_FOR_PICKUP` → `COMPLETED`; `REFUND_PENDING` → `REFUNDED`. `DRAFT` currently exists in the enum but order creation submits immediately. Pickup token records are retained for historical compatibility, but no active token or QR is issued or required for pickup. READY_FOR_PICKUP orders become COMPLETED only through authenticated manual confirmation by the order customer or assigned shop owner after payment is verified.

Order creation example:

```json
{"shopId":"shop-id","items":[{"fileId":"file-id","serviceId":"service-id","paperSize":"A4","colorMode":"BW","printSides":"SINGLE","copies":2,"pageRange":"1-3"}]}
```

## Manual wallet payments and gateway status

| Method | Path | Access | Behavior |
|---|---|---|---|
| GET | `/orders/:id/payment-instructions` | Order customer; only `AWAITING_PAYMENT` | Exact `amountCents`, currency, recipient method/name/wallet snapshot, review status, and private QR image endpoint. States that funds transfer directly to the shop and are not held by PrintReady. |
| GET | `/orders/:id/payment-qr` | Order customer; only `AWAITING_PAYMENT` | Streams the private PNG/JPEG QR snapshot from confirmation; response is `private, no-store`. |
| POST | `/orders/:id/payments/proof` | Order customer; 10/minute | JSON `{ "referenceNumber": "...", "note"?: "..." }`, or multipart fields plus optional `receipt` image (PNG/JPEG, up to 3 MiB). Creates/updates a `PENDING_VERIFICATION` review and never marks an order paid. Repeating the same pending reference is idempotent. Reused references return `409 DUPLICATE_PAYMENT_REFERENCE` with `duplicateReferenceWarning: true`; rejected proofs may be resubmitted. |
| GET | `/orders/:id/payment-proof` | Customer or assigned shop owner | Streams the private receipt screenshot, if submitted. |
| PATCH | `/orders/:id/payments/review` | Assigned shop owner | Body `{ "status": "APPROVED" }` or `{ "status": "REJECTED", "reason": "..." }`. Approval changes payment to `SUCCEEDED` and order to `PAID`; rejection records a reason and allows resubmission. Transaction-safe, idempotent for the same decision, and audited. |
| GET | `/orders/:id/payments` | Order participant/admin | Payment status, review status, reference, and rejection reason; no storage keys or credentials. |
| POST | `/orders/:id/payments/checkout` | Order customer | Returns `503 PAYMENT_NOT_CONFIGURED`; gateway checkout remains disabled. |
| POST | `/payments/webhook/:provider` | Provider | Currently returns `503 PAYMENT_NOT_CONFIGURED`; webhooks are disabled until provider-specific verification is implemented. |

Manual QR transfers are made directly by the customer to the shop outside PrintReady. PrintReady does not receive, hold, or settle wallet funds. Screenshots never count as payment; only the assigned shop owner can verify the transfer in their actual wallet and approve proof. No gateway, fake payment success, card storage, escrow, or settlement flow is enabled. Provider checkout/webhooks remain disabled until a real merchant account and provider verification are configured.

Successful responses use the standard `{ "data": ... }` wrapper. Payment instructions return `{ "data": { "payment": { "id", "amountCents", "currency", "reviewStatus", "referenceNumber" }, "recipient": { "method", "accountName", "walletNumber" }, "qrImageUrl", "transferNote" } }`. Proof submission returns `{ "data": { "payment": { "id", "reviewStatus": "PENDING_VERIFICATION", "referenceNumber", "amountCents", "currency", "submittedAt" }, "duplicateReferenceWarning": false }`; repeat same-reference submissions also include `idempotent: true`. Review returns `{ "data": { "payment": { "id", "reviewStatus", "status", "rejectionReason", "reviewedAt" } } }`. A conflict returns the usual `{ "error": { "code", "message", "details?" } }` form.

QR and receipt images accept content-sniffed PNG/JPEG, use private random storage keys, and have upload size/dimension limits. Images are served only to authorized order participants. Confirmation snapshots amount, currency, recipient details, payment method, and QR reference so later shop changes do not affect existing instructions. Payment reviews record reviewer, timestamps, and audit events. PostgreSQL uniquely constrains submitted reference numbers.

## Order chat

One PostgreSQL-backed conversation exists per order. Only its customer and assigned shop owner can read/send; admins and other accounts cannot access it. History is paginated with `limit` (1–100, default 50) and `before`/`after` ISO timestamps. Reading messages marks those addressed to the caller as read. `GET /orders/messages/unread-count` returns total and per-order counts for polling. Sends are limited to 30/minute and 4000 characters. No WebSockets are used.

## Owner and admin

| Method | Path | Access |
|---|---|---|
| GET | `/owner/dashboard`, `/owner/orders`, `/owner/shops` | Shop owner; scoped to their shops. |
| GET | `/admin/dashboard`, `/admin/orders` | Admin dashboard metrics and order list. |
| GET | `/admin/shops/pending` | Admin; lists pending shops with owner, services, hours, contact, address, registration, and current review state. |
| GET | `/admin/shops/:id` | Admin; full shop review details, services, hours, and reviewer details. |
| PATCH | `/admin/shops/:id/verification` | Admin; body `{ "status": "VERIFIED" | "REJECTED", "notes"?: "review note" }`. Records reviewer, timestamp, status, notes, and an audit entry. |

Admin accounts are provisioned only through the local one-time `npm run admin` CLI. Public registration cannot create or promote an administrator. The CLI accepts `PRINTREADY_ADMIN_EMAIL` and `PRINTREADY_ADMIN_PASSWORD` or prompts locally with hidden password input, refuses to overwrite existing accounts, and refuses duplicate initial admins. Shop owners can read `verificationStatus`, `verificationReviewedAt`, `verificationNotes`, and reviewer ID through `/owner/shops`; the frontend refreshes pending status every ten seconds and on window focus. The admin shop review page is at `/admin` → **Shop verification**. Approval makes a shop eligible for `/shops` discovery when `operatingStatus` is `OPEN`; order creation also requires `VERIFIED` and `OPEN`.

## Validation and errors

Malformed or invalid inputs return HTTP `422` with `VALIDATION_ERROR` and Zod field details. Other common codes: `UNAUTHENTICATED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `INVALID_STATUS_TRANSITION` / `CONCURRENT_UPDATE` (409), `INVALID_FILE` / `UNSUPPORTED_MEDIA_TYPE` (415), `FILE_EXPIRED` (410), `PAYMENT_NOT_CONFIGURED` (503). Do not interpret a client redirect as proof of payment; only a verified provider webhook may set `PAID`.

## Environment

Copy `.env.example` to `.env` and replace `YOUR_PASSWORD` with the actual local PostgreSQL password; `npm run dev` generates a secure JWT secret if it is absent. Defaults: backend `http://localhost:5001`, frontend `http://localhost:5173`, prefix `/api/v1`. `npm run dev` loads `.env`, validates the schema, safely creates the local `printready` database if absent, deploys committed migrations, ensures Prisma Client matches the schema, verifies tables, columns, foreign keys, enum values, and applied migration checksums, then starts the server. It stops if local PostgreSQL credentials fail, the target is not a local development database, existing tables lack Prisma migration history, or schema/migration drift is detected. Other database commands: `npm run db:setup`, `npm run db:status`, `npm run db:migrate:dev -- --name <migration_name>`, `npm run db:migrate:deploy`, `npm run db:generate`, and `npm run db:verify`. `npm run test:integration` runs isolated API integration tests against the local development database and removes its generated test records/files. Production deployments must use `npm run db:migrate:deploy` as a separate reviewed step. Set `TRUSTED_ORIGINS` to comma-separated exact origins. `STORAGE_DRIVER=local` is for a single development instance; S3 driver is reserved but not implemented. Configure upload cap and retention through environment variables. Direct-to-shop manual wallet payments are available after owner review; real provider checkout/webhooks remain disabled until a verified provider integration is configured. No database reset or `db push` is used.
