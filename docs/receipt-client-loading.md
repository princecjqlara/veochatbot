# Receipt client loading

The reviewed receipt form loads `/api/workspace/deal-reviews/client` with both
the selected client and seller. The server checks the current signed-in account
and `veo_deal_review_context` before reading the contact, that seller's orders,
active Closed Deals and corresponding payments. It does not require demographic
extraction, saved profile fields, legacy finance or lifetime-value calculations.
The full contact profile and its historical branch coverage remain separate.

Each browser read has a 20-second deadline. Temporary server and network failures
receive up to two automatic retries, after two and five seconds. A manual retry
is also available. Retrying keeps payment inputs, selected photos and the
submission request ID. Changing the client or seller cancels the old read and
scheduled retries, and stale responses cannot enable submission. Authorization
errors are shown immediately without automatic retry. Submission remains
disabled until current client and seller orders are available.

The upload and submit endpoints still perform their existing live authorization,
evidence and payment validation. A client-loading retry never submits a receipt,
creates financial records or requests Telegram delivery.

Regression coverage is in `VeoDealEvidenceInbox.test.ts` and the client route's
`route.test.ts`: temporary failures, retained inputs and photo controls, seller
changes, scoped orders/payments, unavailable dependencies and denied access.
