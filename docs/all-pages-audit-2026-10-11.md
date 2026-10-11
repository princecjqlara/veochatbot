# Enabled Page audit

Checked the live configuration, Messenger subscriptions, recent reply/follow-up records, old processing claims, and the latest 60 conversations on each of the five other enabled Pages after the Onset repair.

| Page | Verified active handoffs repaired | Queued chatbot follow-ups cancelled |
| --- | ---: | ---: |
| Azshinari | 7 | 5 |
| Vista Media Agency | 0 | 0 |
| Manawari Studios | 0 | 0 |
| SAMA KANA MEDIA | 0 | 0 |
| Loki Media | 0 | 0 |

Each repaired contact was backed up before mutation. Read-back checks found stopped states and zero remaining pending, processing, or manual-ready chatbot jobs on the seven contacts. The four zero-result Pages had no verified active handoff in the sampled conversations; this does not describe all historical conversations.

All six enabled Pages, including Onset, returned valid Messenger subscription reads with `messages`, `messaging_postbacks`, and `message_echoes`. Stage-worker errors were empty. Some workers were still paging through older history. No stale processing reply claims or old claimed follow-up jobs were found in the checked records.

## Additional corrections

Manual messages sent through VeoBot use API echoes, which the chatbot correctly excludes from human-echo detection. The send routes previously logged a staff interruption without saving a durable chatbot stop. Manual replies, attachments, and utility-template sends now save the stop before contacting Meta. They cancel other chatbot follow-ups and retain the current lead stage with manual ownership. A specific staff-approved follow-up is excluded from cancellation so its existing ready-to-send workflow can finish. Database handoff failures prevent delivery. The interruption audit receives the pre-stop state so staff attribution remains visible after saving the stop.

The reply handler incorrectly attributed shared Drive carousels to the knowledge-library Page. They now belong to the sending Page, while media lookup continues to use the shared library. The live audit identified 91 Onset records with that mismatch. Those records were backed up and repaired by matching each message's contact to its actual Page. Messenger messages were not modified or resent.

The retained failure records include Meta rejecting HUMAN_AGENT sends without approval, unavailable recipients (551), and follow-ups blocked for lack of readable customer history. All six current configurations have empty later-day automated follow-up schedules, so the unapproved schedule remains disabled. These historical failures were retained. No customer test messages were sent during this audit.

Audit reports, state/job backups, and attribution backups are in the parent workspace's ignored `data/` directory. Stage-only Business Suite edits that Meta does not expose remain subject to the limitation described in the Onset handoff report.

## Release validation

All 537 tests across 76 files passed, including pre-send handoff persistence, database-failure blocking, preservation of a concurrent lead-stage update, staff interruption attribution, and shared-library media ownership. TypeScript and targeted ESLint checks passed. Vercel compiled, linted, and typechecked the final source successfully.

Deployment `dpl_7xEWM7bJyVKeAoFgxSsCkoiWgEg6` is ready and aliased to `https://veochatbot.vercel.app`. All six signed Page routing probes passed with empty messaging arrays. The four Tokko-app Pages each routed one entry to the chatbot and zero entries to the legacy application; the two Barra-app Pages passed the primary webhook. Webhook verification and dashboard availability also passed. These probes sent no customer messages.

Read-back confirmed all seven repaired Azshinari chats are stopped and have no queued chatbot follow-ups. The final Drive attribution scan found zero remaining mismatches in the audited records. Source changes remain in the local working tree; no Git commit or push was performed.
