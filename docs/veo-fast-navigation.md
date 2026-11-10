# Faster shared loading and simpler navigation

The dashboard shell no longer loads the Page directory for an unused global
selector. Each tool retains its own working Page filter. This removes one
duplicate authenticated database read and its Facebook probes on entry.

Page discovery still checks the signed-in user's current Page assignments and
workspace scope on every request. Only Facebook connection health is shared in
memory for up to 30 seconds, keyed by Page, token fingerprint, app and check mode.
Concurrent identical probes share a promise; unknown health expires after three
seconds. Explicit connection-details requests recheck health. Token/app changes
invalidate the key. Probes use fourteen workers, the cache has 500 slots, tokens
never appear in cache keys or API responses, and errors are not retained.
The default connected/reconnect-needed classifications remain the same.

Accounts uses a focused live directory instead of calculating dashboard
finances, orders and capacity. Identity and Page-grant reads run together after
account lookup. Staff and membership results are fully paginated, with small
ID batches and a shared deadline. Missing identities or failed sources return
an unavailable result rather than a successful partial directory. Profile
requests retain their actor-only scope. The Page directory is also paginated.

The workspace entry splits large panels into separate JavaScript chunks and
loads the client drawer only when a client is opened. The executive dashboard
loads detailed results and budgets after the user opens their labelled panels;
staff alerts remain visible. Worker queues remain in the worker dashboard.
Changing areas cancels obsolete workspace requests. Hidden navigation links do
not prefetch every tool.

Navigation uses five groups, highlights query-based workspace areas correctly,
opens the active group and offers a collapsed mobile Menu. The redundant row of
open dropdowns becomes one closed Switch workspace area control. Existing
features remain reachable, including tags, receipts, salary, chatbot, pricing,
team setup and earnings. Route/API authorization remains authoritative.

No schema migration is required. The single Singapore Supabase project remains
`mjuluaqrvbnycisnarzi`. Environment verification receipts and sequential live
before/after measurements are stored under ignored `.vercel/veo-wide-release/`.
Sensitive Vercel values cannot be read back; verification combines successful
write receipts, unchanged variable metadata and live checks. Development values
can additionally be compared directly with local values.

UI interactions are covered by component tests. No browser was connected for
visual inspection during this release. API smoke checks are not a production
concurrency benchmark. External Facebook credentials, staff passwords and
ad-spend coverage remain separate operational inputs.

The split loading follows [Next.js 14 lazy-loading guidance](https://nextjs.org/docs/14/app/building-your-application/optimizing/lazy-loading).
