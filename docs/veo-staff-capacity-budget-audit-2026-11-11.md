# Staff data, capacity and budget audit

## Live findings

The seven retained workspace identities, roles, hierarchy and 53 Page grants are
present. Six staff accounts have no recovered email/password and disabled sign-in.
No staff Telegram identities, verified group memberships, or attendance
declarations are saved. Their identities and Page grants are retained for Owner
login recovery; these accounts are not evidence of currently available workers.

The authorized fresh database start on November 9 retained the workforce and
available chatbot setup. Older customer/financial history was intentionally not
imported; the original project was retained. The current workspace has no new
orders, verified payments, receipts, Closed Deals or salary-day records. No
historical performance or earnings were invented to fill these gaps.

Four retained selling accounts (Managers/Members) appear in three teams. Current
Page allocation divides four default capacity slots across 22 team/Page rows;
the allocation conserves those four slots. Active quota is zero because no
participation has been declared. Both today and tomorrow were checked. This is
retained potential capacity, not proof that four staff can currently receive work.

There are no saved budget plans, ad credentials, spend rows or complete ad-cost
coverage. Actual CPA, ROAS, estimated net profit after advertising and detected
Meta budgets cannot yet be certified. The Owner must connect Meta Ads; staff
access, Telegram routes and attendance also need setup.

## Calculation checks

- Personal production capacity uses the best three positive, completed Done Deal
  dates in the previous 14 days, at 80% of their average rounded down, minimum one.
  With fewer than three eligible dates, one is the default, not measured output.
- Full team capacity sums retained selling-worker estimates. Declared active
  workers contribute operating quotas; unknown attendance is distinct from inactive.
- Page allocation uses integer largest remainders and authorized Page weights.
  Assigning several Pages does not multiply a worker's target. Completed capacity
  snapshots and personal commission targets retain their existing semantics.
- The budget model uses authoritative participation and Page quota. Its capacity
  ceiling is quota × estimated CPA, rounded down to the configured money unit.
  Growth, outcome, ramp and reserve settings may lower that recommendation. The
  historical capacity buffer and planner reserve are not applied twice.
- With no active workers, recommended spend is zero. Without declared participation
  this is not proof that the business has zero production ability. Saved budget
  recommendations do not directly change Meta campaign settings.
- Salary remains 40% only when both personal Closed and Done targets are reached;
  otherwise 35%. Zero operating quota does not create salary qualification. Actual
  verified settlements, refunds, corrections, separate currencies and cent-preserving
  Page allocations remain authoritative.
- Staff net profit requires complete reconciled advertising costs. Missing cost
  coverage stays unavailable rather than being treated as free advertising.

## Repairs

The Capacity page called `veo_salary` with `p_actor`, although the installed
PostgreSQL function takes `p_user`. This caused HTTP 503 on the entire panel.
The request now uses the actual function signature. A regression check rejects
the wrong argument, and salary/directory failures remain recoverable errors.

Capacity and budget responses now expose scoped login readiness counts. The UI
warns when retained roster estimates include disabled or unknown login states,
links to account review, and explains the default target. Budget counts
deduplicate staff across Pages and query only the authorized planning roster.
No password/hash is selected by these reads, and unavailable source data is
never counted as enabled sign-in. The formulas and historical snapshots were
not changed to compensate for incomplete setup.

Tests cover the corrected RPC contract, login coverage/privacy, full account
pagination, budget ceilings, reserve behavior, Page conservation, current/default
capacity, salary/cost handling and existing profile/graph behavior. Live checks
cover both planning dates, the capacity panel, staff directory, ad-source status
and the Jaucian operations report. No fake sale, salary, attendance, identity
mapping or customer message is created by this audit.
