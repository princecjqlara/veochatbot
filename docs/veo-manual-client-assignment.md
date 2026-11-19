# Manual client assignment

Managers, Team Leaders and Owners can use **New Clients → Assign client
manually**, search for a client, load the current assignment, select a selling
worker and enter a reason. Each client card also has **Correct assignment**.
When the receipt form reports a client access or assignment error, supervisors
can open **Correct client assignment** from that form.

The change takes effect immediately, without requiring a Ready offer or worker
acceptance. Managers can act within their own branch and assigned Pages. Team
Leaders cover their Manager branches. Owners can transfer across branches.
The current owner and chosen worker must be within the supervisor's authority;
workers must be active, unsuspended, assigned to a selling team and permitted
on the Page. Members cannot use this override.

The save locks the contact, compares the expected owner and records the reason,
actor and previous assignment in the existing audit table. A stale assignment
returns a conflict and requires reloading. Repeating a completed assignment is
a no-op. A failed or unconfirmed write is never automatically retried.

Manual assignment changes client service and new-sale ownership. Past receipts,
orders, payments, commissions and existing work assignments retain their saved
attribution. The chosen worker becomes Busy, conflicting pending offers end,
the client's automatic intake dispatch closes, and its chatbot pauses for human
handling. The operation does not send a Telegram message or create a sale.

Migration `202611200004` adds two service-only, bounded RPCs:
`veo_client_assignment_context` and `veo_manual_client_assignment`. The HTTP
route rechecks the signed-in account and role; the database independently
enforces Page, branch, account status and expected-owner checks. No new table,
recurring scan or background job is added.
