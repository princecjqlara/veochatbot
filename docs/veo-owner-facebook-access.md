# CJ Lara's Facebook sign-in

Only the retained CJ Lara Owner account may use Facebook sign-in. Its original database ID is pinned in `src/config/veo-owner.ts`. The server requires that account's existing Facebook binding, active account and launched stored Owner role. It does not auto-link through email, create users, or grant Facebook access based on a display name or the selected role.

The sign-in screen shows the Facebook button only when Owner is selected. Members, managers and team leaders sign in through their administrator-created email/password accounts. CJ retains email/password access too and can reauthorize the retained Facebook Page connections through Page Connections.

Older non-owner Facebook sessions are refused both when refreshing the session and at the API middleware boundary. Switching to an email/password account clears any old Facebook identity and access-token fields.

Validation covers the sign-in UI, CJ's positive Facebook callback and token path, denial of other linked accounts (including an account labelled Owner), mismatched Facebook identities, email/name impersonation, disabled stored role, old Facebook sessions, credential session isolation, and Page reauthorization. All 18 focused tests passed, with the updated token handling also rechecked separately. No user identity, password, financial record, Page connection or launch cutoff is changed by this policy update. Deployment verification checks CJ's retained binding without exposing its Facebook ID or tokens.

Deployed November 6, 2026, at `https://veochatbot.vercel.app`. Local and deployed production builds passed. Read-only live verification confirmed CJ's retained Facebook binding, HTTP 401 for a non-owner Facebook session, Owner API access and all 15 ready Page connections. An interactive Facebook authorization round trip was not performed.
