# Receipt seller assignment checks

The reviewed receipt form used to confirm Page and branch access before loading
client orders, but a new-sale assignment conflict was detected only when saving
the receipt. That allowed three photos to upload before the seller was told the
client belonged to another worker.

Migration `202611200003` adds the same assignment check to the scoped receipt
context used by the client read and evidence upload. The error identifies the
assigned seller and tells staff to select that seller or request reassignment
from their Manager or Team Leader. Released clients require assignment first.
The form displays this authorization response directly and does not retry it.

An existing seller order or nonvoided Close Deal still permits receipt context
access after client service is reassigned, so the original seller can complete
their existing deal. Final save and approval checks remain authoritative.
The migration preserves function permissions, account suspension checks, client
assignments, photos, existing reviews, orders and payments. Reassignment requires
an explicit business decision; it is not an automatic error recovery action.
