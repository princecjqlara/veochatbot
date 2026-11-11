# Creating orders and marking them paid

**Create order: Closed Deal** and **Mark as paid: Done Deal** are separate
actions in Receipts & payments and the contact shortcuts.

For a Closed Deal, create the client's invoice/order in Facebook Business
Suite, choose **Fetch Facebook orders** in VEO, select the matching invoice,
and choose **Use this Facebook order**. Order creation/import records no
payment and does not mark the order Done. The Closed Deal receipt requires
that order, the saved Qualified/Converted stage evidence, the down payment,
and the existing seller, Page and Telegram checks. Direct manual order
creation in VEO remains disabled under the existing Business Suite policy.

For a Done Deal, choose **Turn this Closed Deal into Done Deal** to retain
the same order and its down payment. Enter only the amount actually received
this time, its transaction reference and Philippine payment time. Review the
calculated total and remaining balance, verify the payment evidence, then
choose **Verify payment and mark as paid**. Existing down payments are
reconciled once. An already paid order shows its status and does not display
another payment form. A fully paid new sale can also link its order and then
perform the separate payment step without an earlier Closed Deal receipt.

The database enforces the order requirement for new Closed Deal submissions,
including direct receipt-save calls. Settlement permits a new order's own
linked Closed Deal while continuing to reject unrelated earlier deals.
Existing records are retained. The migration changes functions only and does
not rewrite orders, payments, receipts, salary or launch cutoffs. Existing
payment verification, settlement tolerance and commission rules still apply.

The application records verified VEO payments and Done Deal eligibility;
Facebook's own payment status is managed in Business Suite. A screenshot or
a chat saying "paid" does not verify payment.

Order fetching uses the background source worker. The picker shows queued
progress and polls saved results while open and visible, retrying temporary
read failures without dropping choices. Client changes cancel old reads.

Validation covers the full schema and the actual create/link -> Closed Deal
receipt -> verified payment -> Done Deal transition, payment retry
idempotency, unrelated-deal rejection, private RPCs, submission guards and
component behavior. No production sale or customer message is created by
release verification. Browser visual review is unavailable in this session.
