# Business Insights — first reporting phase

Owner and Team Leaders can open **Reports → Business Insights** at
`/dashboard/insights`. The date range covers up to 93 Philippine dates from
workspace launch through today. Page filters retain current Page permission;
financial and work facts also retain seller-branch restrictions, including
recorded activity by archived branch accounts.

The first phase consumes existing records rather than adding the proposed
master BI schema, cost ledger, models or decision automation. It reports:

- Selected-period inquiries, distinct clients/orders with recorded payments,
  first full-payment milestones, new orders and distinct refunded orders.
- Receipts, refunds and net receipts by original currency. Multiple payments
  do not multiply contacts or orders. These are recorded workspace cash flows,
  not complete profit, payroll payout or bank reconciliation.
- Current balances from existing order facts, across all visible orders since
  launch. Negative net-paid exceptions make the affected currency's balance
  unavailable and expose a review count.
- Current working, overdue and ready/waiting counts, oldest age and the five
  oldest working orders. Totals cover all eligible records, not just the list.
- Undated Page contacts, dated inquiry origin coverage, and per-Page identity
  sync attempt/error timestamps. No missing date or origin is invented. Identity
  sync is not proof of full message, ad-spend or payment coverage.

Period activity and current snapshots have separate labels. Changing a past
date filter does not reconstruct historic receivables or production state.
Full-payment milestones remain historical after refunds; present balances are
a separate measure. System work deadlines are not contractual payment dates.
Existing Calendar/Creative reports remain the source for commissions, ad costs
and their financial definitions; the new page links to them.

Migration `202611200005` adds one service-only, read-only reporting RPC with an
eight-second statement limit. It creates no data table, materialized snapshot,
index or cron. The RPC validates the active account, role, Page scope and dates,
defers during known resource pressure, and shares the existing nonblocking heavy
database-capacity lock. Receipt and login paths do not take this report lock.
The HTTP endpoint coalesces simultaneous identical reads after rechecking current
authorization; completed results are not kept in a permission cache. The page
loads on demand and has an explicit Refresh button, without automatic polling.

Tests cover multiple orders/payments, refunds, currencies, seller branches,
missing inquiry dates, current-versus-period state, unavailable balances,
permissions, pressure, concurrent reads and denied refreshes. A production
preflight must reconcile recorded period money to the ledger and stay below
five seconds before the migration is installed. The local release receipt is
stored under `.vercel/business-insights-preflight.json`.

This phase does not collect new customer data or change sales, staff assignment,
commission rules, quotas, advertising budgets or model behavior. Expense/cost
entry and further cohort/model features require their own subsequent changes.
