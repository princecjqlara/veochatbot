# VEO fresh database recovery

The owner authorized a fresh start on Supabase project
`mjuluaqrvbnycisnarzi`, retaining available workforce identities and saved
chatbot setup/knowledge. Customer contacts, transcripts, orders, payments,
archives and old follow-up jobs were not imported. The original project remains
intact, with no billing change.

## Recovered data

All 134 committed migrations are installed, including the bounded hierarchy
guards and the two fresh-start recovery functions. The private submission bucket
is private. Anonymous access to workspace scope, finance and recovery functions
is denied. The database occupied about 39 MB immediately after recovery.

The verified November 3 setup backup supplied 12 chatbot configurations,
479 knowledge documents, 504 vector chunks, 476 Drive references,
12 pricing experiments and 48 packages. Every selected setup value was compared
with the source after importing. The knowledge belongs to Azshinari in that
backup; it was not duplicated into other Pages. Later changes unavailable from
the failed project cannot be represented as recovered.

The saved November 7 roster restored seven account identities, their roles,
supervisor links, Page grants and three teams. All seven Page scopes were
verified. Their existing identity IDs and the tenant ID were retained.

Old password hashes and six staff emails were unavailable. The owner's saved
email received a new random password stored only in the ignored local file
`.vercel/veo-fresh-start/owner-sign-in.txt`. Owner can set each remaining member's
email and new password in **Accounts**, preserving their identity, role,
supervisor and Page grants. Recovery cannot reactivate a departed account.

## Facebook connections

Fourteen saved Page tokens still read their correct Facebook identities.
Six Pages have the current app's webhook subscription. Eight saved tokens use
the previous app connection and require **Connect → Refresh Permissions**:
Azshinari, Habi Media Agency, Manawari Studios, Onset Media Agency,
Salin Media Agency, SAMA KANA MEDIA, Strix Media Agency and Vista Media Agency.
Their setup remains saved; they must not be presented as ready to receive
current-app webhook events. The current app's active callback was verified as
`https://veochatbot.vercel.app/api/facebook/webhook`.

Facebook connection setup was removed from this application version. Restoring
the database does not recreate a Facebook permission grant. These pending Pages
need current-app credentials through a separate owner-authorized connection
recovery; do not direct the owner to the removed Connect screen.

AIkita Studio has no backed-up Facebook identity/token and needs connecting
separately. No identity or token was invented, no app routing checks were
bypassed, and no customer messages were sent during verification.

## Fresh contact sync and operation

Owner starts identity sync from **Sync**, one batch of at most 50 contacts per
request. It imports names and Page-scoped identities without transcripts,
historical stage events or source-processing jobs. Duplicate identities are
ignored and existing records retain their values. Each request has a deadline
and a Page lease to prevent overlapping syncs. Normal tagging remains available.

The recovery RPCs are restricted to service-role calls with explicit owner and
Page/tenant checks. Account recovery records private audit entries without
passwords or hashes. A new session secret invalidates old workspace sessions.

Production and local environment settings select the new project. Production
cutover requires a successful build, owner sign-in, account directory, restored
Page inventory, chatbot settings/knowledge, contact search and sync authorization
checks. Verification distinguishes restored Pages from connections needing
Facebook reauthorization. Ignored receipts are kept in
`.vercel/veo-fresh-start/`; they must not be committed with credentials.

The schema installer accepts only the original VEO project or this explicitly
approved replacement and validates all configured connection/key routes. It
normalizes SQL line endings for function-body patches while hashing original
file bytes. Initial database maintenance jobs remain inactive. The fresh setup
importer and owner activator reject a second application after recovery; do not
rerun them against the populated database.
