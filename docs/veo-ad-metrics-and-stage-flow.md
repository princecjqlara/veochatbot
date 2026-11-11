# Ad metrics, graphs and Messenger stage audit

## Delivery reporting

Creative performance supports custom date windows up to 93 days, one assigned
Page and one ad placement at a time. The graph offers impressions, daily unique
reach, daily frequency, messaging conversations started, cost per conversation,
clicks, link clicks, CTR, link CTR, CPC, cost per link click, CPM, video plays,
ThruPlays, completions, video completion rate, video costs, inquiries, conversions,
paying clients, acquisition costs, spend, verified receipts, profit and ROAS.
The daily delivery table exposes exact source values alongside the existing
inquiry-cohort financial table. An accessible day selector exposes graph values.
Missing dates are gaps, real zero values remain zero, and losses plot below zero.

Meta messaging starts use the action
`onsite_conversion.messaging_conversation_started_7d`; cost per message is spend
divided by that count. It is not the cost per individual chat bubble or the cost
per VEO inquiry. Costs use the chosen currency. A zero result denominator makes
the cost unavailable. CPC uses all clicks; cost per link click uses link clicks.
CPM uses spend / impressions * 1,000. Completion rate uses completions / plays.

Range unique reach and frequency use a separate ad-level Insights read for the
exact displayed ad and date window, including the initial default selection.
These are ad-account reporting dates. Daily reach is never added into range
unique reach. The separately labelled reach-weighted daily frequency is not an
exact period frequency. Expired permissions or unavailable range metrics leave
the saved report usable without fabricating a range audience.

Financial ROAS and profit still use the verified inquiry-cohort definitions in
[the budget and creative audit](veo-ad-budget-creative-audit.md). Current-day,
incomplete, unreconciled or non-PHT delivery cannot certify final cost ratios.
Field support follows [Meta's Insights SDK](https://github.com/meta/facebook-python-business-sdk/blob/main/facebook_business/adobjects/adsinsights.py).

## Can the proposed conversation flow work?

Yes, when Meta exposes the administrative message. Meta's
[official Conversations API collection](https://www.postman.com/meta/messenger-platform-api/folder/22794852-255610cd-47f5-4f4d-b3fa-71aec360be9a)
documents Page conversations, conversation messages, sender and sent time. It
requires a Page token, the appropriate Page task and permissions, and Advanced
Access for public conversations. It does not establish a guarantee that every
Business Suite lead-stage change appears as a readable message.

Current implementation:

1. `fetchBusinessOrderNotices` locates the conversation through
   `/{PAGE_ID}/conversations?user_id={PSID}`, verifies its participant and reads
   messages with `id,message,from,created_time`. Expanded first-page messages and
   paginated message reads are equivalent to the separate message endpoint.
2. Exact `Lead stage set to ...` text is recognized only from the matching Page.
   Customer-authored copies and ordinary staff prose cannot establish a stage.
3. The Page-scoped contact ID and PSID are checked before saving observations.
   Database constraints reject cross-Page contacts and scope message deduplication
   to Page, contact and message. Duplicate or older notices do not overwrite a
   newer current stage or an acknowledged reset/manual update.
4. `syncMessengerStageHistory` writes the observed history and its corresponding
   local `History: <stage>` tag through `apply_messenger_lead_stage`. These are
   VEO tags, not Facebook custom labels.
5. In workspace mode, source jobs and signed webhook processing collect these
   observations. The older `processOneMessagingAutoTagPage` scanner is disabled.
   Its `messaging_auto_tag_enabled` toggle is not a gate for workspace evidence.
   Workspace stage history has **no seven-day last-inbound cutoff**; older saved
   evidence is retained, while report and financial rules apply their own dates.

Consequently, the proposed seven-day/optional-tag rule describes a different
policy from the current durable evidence flow. No new seven-day restriction or
legacy-toggle behavior was silently applied during this reporting change.
Reading history or saving a local tag does not itself send a Messenger message.
An order notice remains order evidence and does not prove payment or Done Deal.

## Read-only live sample, 2026-11-11

All 15 connected Pages were readable. A bounded sample checked 24 conversations
(up to two per Page, up to 100 messages each) and found two Page-authored stage
notices; both predated workspace launch. The database independently contained
42 Qualified, three Converted, two New and one Not Qualified observations,
including retained history. Source jobs had recent successful scans.

This proves the endpoints and some notices are accessible, not that every stage
change or every historical message is available. No contacts, tags, messages,
orders, payments or Meta budgets were changed by the sample. Ad-account read
consent remains a separate requirement for real ad delivery metrics and spend.
