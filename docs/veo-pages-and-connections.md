# Owner Pages & Connections

Open **Tools & settings → Pages & connections**, or `/dashboard/connect`.
Settings also links to the screen through **Add or manage Pages**. Only the
current workspace Owner can read the management directory, authorize Facebook,
or add/reconnect a Page. Other roles retain their existing assigned-Page tools.

## Adding or reconnecting a Page

1. Select **Authorize Facebook Pages**. Authorize the Facebook account managing
   the Page and approve the requested Page permissions. This authorization is
   separate from VEO email/password sign-in and does not change VEO identity.
2. Select **Connect Page** beside a newly authorized Page, or **Reconnect** beside
   an existing one. New verified Facebook IDs are supported without editing the
   original static Page-name catalog.
3. VEO verifies the credential's Facebook app, actual Page identity and inbox
   access. It subscribes the app to messages, postbacks, echoes and referrals,
   verifies the subscription, and registers the Page's runtime app ownership.
4. Missing utility templates and contact-name/identity collection run by default
   after a successful connection. Each can be switched off before connecting.
   Their results remain separate from connection health. Template approval or
   collection failures retain the saved connection and provide retry controls.
5. Use **Manage team access** to grant the Page down the existing team hierarchy.
   Use **Telegram routing** to assign the Page to the correct delivery group.
   Review the Page's existing or new chatbot configuration before enabling it.

The advanced **Connect using a Page access token** form supports verified Page
credentials for the configured Facebook app when an interactive account grant
is unsuitable. Tokens never appear in returned Page lists. Renewing a Page
updates its existing UUID, token and verified name; it retains contacts, tags,
messages, orders, receipts, payments, templates, chatbot settings and staff grants.
Only the Owner receives a new Page grant automatically. Connections are audited
without storing credentials in audit records.

## Feature comparison with the former connection screen

| Former capability | Current location / behavior |
| --- | --- |
| Facebook Page discovery | Authorize Facebook Pages; all authorized listing pages are read, including new Page IDs |
| Refresh permissions | Refresh Facebook permissions, with an expiring Owner-bound selection session |
| Individual connect/reconnect | Available Page cards and saved Page rows |
| Bulk reconnect | Reconnect selected / Reconnect all saved Pages; reports each failure and continues; disabled Pages require the separate Reconnect & enable action |
| Connection and webhook health | Check connections; distinguishes Connected, Reconnect required, Setup incomplete, Unable to verify and Disabled |
| Failed/expired connections | Retained in the saved directory; unavailable health never removes a Page |
| Automatic template submission | Enabled by default, skips existing templates, reads all missing batches, retains approval/error status |
| Retry template setup | Setup templates and the existing Templates tool, preselected to the Page |
| Contact synchronization | Automatic identity collection, Sync contacts, Sync selected contacts and Sync all connected Pages; follows every cursor and retains in-screen checkpoints |
| Sync progress / recovery | Per-Page progress and Stop after current request; completed batches remain saved |
| Contact-management shortcut | Contacts & bulk tools, preselected to the Page |
| Facebook Page link | Open Facebook Page |
| Existing permissions and bot configuration | Manage team access, AI chatbot, Telegram routing and Webhook settings remain available |

Current workspace rules continue to govern history. Contact sync adds names and
identities while retaining existing records. It does not re-import old messages,
financial records or archived automation, change launch cutoffs, or restart old
campaigns. The previous legacy historical-import API remains retired. Existing
financial and receipt-policy drafts are outside this release.

## Authorization and deployment

The flow reuses `/api/auth/callback/facebook` as the Meta OAuth redirect URL,
while the VEO sign-in providers remain credentials-only. If the Meta app reports
a redirect mismatch, the exact callback URL is displayed in the screen's callback
details. The owner must complete their own Facebook authorization; tests cannot
substitute for that external permission grant.

Migration `202611100001_veo_owner_page_connections.sql` adds one bounded encrypted
authorization row per Owner, a one-use state claim, and an atomic Owner-only Page
connection function. The service role alone can access these. The signed
HttpOnly cookie is bound to the VEO actor; expired, replayed, tampered or
cross-tenant grants cannot authorize connections. New and reconnected tokens are
checked against the configured Facebook app before saving. A failed webhook
setup is reported as saved-but-incomplete, with a deliberate retry action.

The migration creates no orders, messages or financial records and does not
rewrite existing Page data. Deployment should apply only this additive migration
after its transaction-rollback preflight and deploy the clean application commit.
The unrelated local receipt-policy migration must remain excluded.

Implementation references are Meta's [manual authorization flow](https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow/),
[Pages setup](https://developers.facebook.com/docs/pages-api/getting-started/),
and [token debugger example](https://www.postman.com/meta/whatsapp-business-platform/request/i1mz7w8/debug-token).
Live verification checks the installed private functions, unchanged retained
record counts/cutoff, Owner access, anonymous denial and deployed screen assets.
It does not connect an invented Page or send a customer/Telegram message.

## Validation

The final regression suite passes 2,044 tests in 271 files, including the existing
receipt, campaign, messaging, contact and financial suites. A later focused run
passes 34 checks covering Page management, complete directories, authorization,
bulk recovery and credential boundaries. TypeScript checks pass. The migration's
rollback preflight passes against the configured production project and retains
all 14 Pages, 52 access assignments and 12 chatbot configurations, along with
contacts, tags, existing financial records and the launch cutoff.
The production build also passes with the complete Page management screen and
separate authorization callback.

No browser is connected in this environment. The component tests exercise the
screen controls; production checks verify deployed assets and authenticated API
responses. A real Meta authorization/permission dialog still requires the Owner
to complete their own Facebook consent.
