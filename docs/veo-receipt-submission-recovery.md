# Receipt submission recovery

Receipt uploads previously used the bulk-work storage gate. That gate pauses
when CPU monitoring is stale, maintenance is delayed, or the database is under
resource pressure. It therefore blocked required member evidence even when
storage had room. Small private receipt uploads now use a separate capacity
check. Critical storage and unavailable capacity checks still stop uploads;
bulk imports retain their original gate. Page and seller authorization, image
validation, the 3 MB limit, and photo expiration remain enforced.

Team auto-approval previously rolled back the member's entire intake if its
order or payment checks failed. Migration `202611170002` isolates that approval
attempt. Evidence remains pending with a review notice and retry delay, while
all changes from the failed approval roll back. Intake authorization and photo
validation still reject invalid requests. Retrying the same saved submission
returns its existing review without approving it again.

Validation covers member uploads during a bulk pause, critical capacity,
revoked access, invalid image contents, existing review behavior, and actual SQL
rollback and duplicate handling against the complete migration chain. No
payment or Telegram message is needed to verify the upload endpoint.

The 95 focused tests and hosted production build passed. The migration was
applied after a rollback preflight verified that existing receipt, order,
payment and delivery counts were unchanged. Both fixes were released to
`https://veochatbot.vercel.app` on November 17, 2026. Live checks also observed
intermittent database statement and connection timeouts, including permission
reads before uploads; successful build and regression checks alone do not
establish complete service recovery.

After deployment the member receipt context returned HTTP 200. The private
upload probe subsequently encountered a database connection timeout, so full
member submission recovery remains unverified. No test sale or Telegram
message was created.

Follow-up release: migration `202611170003` now saves member evidence before
scheduled automatic approval. This also protects intake from an approval query
timeout, which PostgreSQL does not catch with `WHEN OTHERS`. The inbox labels
automatic approval as pending. Connection-timeout errors retain HTTP 503
semantics so retries keep the original request reference. After this release,
the live member receipt context and review list returned HTTP 200 and a private
member upload returned HTTP 201; the temporary upload was removed. See
[member warning and suspension controls](veo-member-warnings-and-suspensions.md)
for the combined release verification.
