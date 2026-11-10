# Creating orders and recording payments

Open **Receipts & payments** in the dashboard. Choose the client and seller,
then **New fully paid deal** or **Turn this Closed Deal into Done Deal**.
Create the matching invoice/order in Facebook Business Suite. Back in VEO,
choose **Fetch Facebook orders**, select the correct invoice, and choose
**Use this Facebook order**. Direct manual order creation in VEO remains
disabled under the existing Business Suite order policy.

Order fetching queues the existing background source worker. The picker now
shows pending/running progress and checks the saved results automatically with
read-only requests while the screen is open and visible. It accepts the actual
`items` plus `source.sync` response, without requiring the old immediate `scan`
object. Completed refreshes stop polling; temporary read failures retry with
backoff while retaining saved choices. Switching clients aborts old progress
reads and late responses cannot replace the current client's order list.

In **Record what the client sent**, enter the verified amount received this
time, its transaction reference and Philippine payment time. Review the
calculated received amount and remaining balance, confirm the payment evidence,
and choose **Verify amount sent and mark Done**. Existing down payments can be
reconciled against the appropriate Closed Deal without double-counting them.
Done Deal status requires the existing stage, order and settlement checks.
The application records VEO payments and commission eligibility; Facebook's
own payment status is managed in Business Suite. A screenshot or a chat saying
"paid" does not verify a payment.

This fix changes order-refresh feedback and progress reads only. Existing
payment validation, permissions, invoice linking, settlement tolerance,
receipt requirements, commission rules and retained history remain unchanged.
It does not apply the unrelated local receipt-policy draft or create a
production order, payment, receipt or Telegram message for verification.

Validation: 2,114 regression tests in 279 files, 23 focused order/payment checks,
and the production build pass. A protected read-only production check confirms
the current saved-order/source-job response contract, no-store caching,
anonymous denial and rejection of cross-origin refresh requests. Browser visual
review is unavailable in this environment; asynchronous component tests cover
queued refresh, completion, retries, retained choices and client switching.
