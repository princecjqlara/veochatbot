# Owner email and password sign-in

Facebook sign-in and account connection setup have been removed. All four roles use administrator-created email/password credentials. CJ keeps the original Owner identity, tenant, team permissions and saved VEO Page connections. The Owner email/password was updated through an audited database transaction; only the password hash is stored, and neither the plaintext password nor its value is present in source or logs.

The application advertises only the credentials provider. Old Facebook sessions are rejected, and the browser clears those invalidated sessions to show the email login form. The former Facebook connection page redirects to the workspace; the connection setup APIs return 410. Saved Page tokens and signed Facebook message webhooks remain available to the chatbot and collection workers.

The generic scripts `set-veo-owner-password.mjs` and `verify-owner-credentials.mjs` accept credentials over non-echoing standard input. The first preserves the original Owner ID and page grants, hashes the password, clears the account login limiter and records a password-change audit without storing the password or hash in the audit. The second exercises CSRF, the real credentials callback, session role and workspace access while keeping cookies only in memory.

The supplied Node warning concerns legacy `url.parse()` calls in the older framework/OAuth dependency code. The application login now uses the credentials route; changing authentication does not claim that every framework deprecation warning has been eliminated.
