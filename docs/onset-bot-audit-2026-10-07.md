# Onset and Azshinari chatbot audit

Checked saved production settings, recent chatbot states and delivery records, eight Onset Messenger conversations, and the reply, follow-up, and stage-worker code on 7 October 2026. Customer message excerpts are kept outside the repository in the local `veobot/data` audit files.

## Saved setup

Onset and Azshinari have identical chatbot settings after excluding row IDs, Page IDs, and timestamps. They use the same model, instructions, collection fields, stopping rules, and follow-up schedule. Both resolve knowledge to Azshinari's library: 478 knowledge documents, 476 Drive files, and one Drive folder. Responses can still differ because Page identities and customer conversations differ.

Both pages stop at a configured 46% collection target: five of nine requested fields, including the saved Messenger name. Two configured fields request the deadline under different wording. Phone number and email are not configured collection fields. The target and field list were left unchanged pending the user's preference.

## Findings

- Both Page records have a recent stage-worker error, `Default page tags are missing`, despite each currently having a default Paid / Availed Service tag. The local worker also previously aborted if its default tag was missing. The recorded error's wording differs from the local code, suggesting older deployed logic; this is an inference, not a verified deployment revision.
- Scheduled chatbot follow-ups checked saved database stages but did not check the live Messenger stage before sending. A delayed or failed polling worker therefore left those follow-ups eligible.
- Reply stop checks inspected only the first 100 Messenger messages. Older handoff events could be missed. Added bounded pagination, a 20-second check budget, and fail-closed handling when the check cannot finish.
- AI reply context was restricted to the newest 20 text messages even though 100 were retrieved. Earlier customer answers could be omitted. Reply context now includes up to 100 readable messages.
- Saved details were updated only after successful delivery. A Meta delivery error could discard newly extracted answers. Details are now saved before delivery.
- After intake completion or a terminal handoff, later customer answers were not extracted. Incoming text now updates those details without generating or sending a customer reply and preserves the stopped state.
- One reviewed conversation had a printer brand saved as the business name. Extraction rules now distinguish business names from product brands and omit ambiguous values. This remains model-based extraction; the change does not guarantee perfect classification or rewrite historical records.
- Placeholder strings could count toward completion. Known unknown/pending placeholders are now ignored and extracted field names are canonicalized to the configured field list.
- A Messenger handoff to the same Qualified stage previously retained the chatbot stage source. The code now records the Messenger source so the existing photo-reply exception cannot treat that handoff as automatic intake completion.
- An active state snapshot could overwrite a concurrent stop. Active updates are now conditional on the row still being active, and initial active inserts do not overwrite existing rows.

## Changes and validation

The stage worker saves the stop and cancels queued chatbot follow-ups before optional tagging or interruption logging. Follow-ups verify Messenger history and refresh saved eligibility after AI generation. Replies refresh eligibility before saving details and delivering messages. Existing customer-photo handling remains covered by the webhook tests.

Regression coverage includes terminal stages, missing tags, tag/audit errors, eligibility read errors, handoffs during generation, late detail collection, failed delivery, older-message context, placeholder filtering, and history pagination.

Validation: all 412 tests across 71 test files passed. A subsequent check of the final webhook/state changes passed all 40 affected tests. TypeScript validation and targeted ESLint checks passed. The production build completed successfully, with existing dashboard lint warnings.

Release preparation also verified that the lead-stage interruption migration and constraints are already applied in production. The worker now supplies its pre-stop state snapshot to the audit writer so saving the stop first does not suppress the interruption record. All 46 affected tests and TypeScript validation passed after that adjustment.

Live checks were read-only. No Messenger messages were sent, no saved page settings or historical customer records were changed, and no production deployment was performed as part of the audit.
