# Regression audit of recent releases

The audit found and repaired two further issues:

1. Empty sales-assistant settings were expanded into defaults on PUT and dashboard
   draft preview. This could reactivate the alternate flow after the runtime fix.
   Empty settings now survive GET/default, PUT and preview round trips. The UI
   identifies the active flow and requires an explicit action to configure the
   alternate assistant; users can also return to the saved in-chat flow.
2. A 201-message profile review repeatedly failed on its final one-line Page
   follow-up. Short final chapters now include up to five preceding messages,
   bounded to 5,000 characters. Only new messages advance the checkpoint; exact
   citation validation remains required. The affected review completed on retry
   without rereading or deleting its 200 already-analyzed messages.

Verification included the full 1,273-test suite before the final chapter repair,
seven worker tests including its new context/checkpoint regression, TypeScript,
production build, a real Luna preview through greeting/sample/pricing/process/form
and follow-up, and read-only real-data checks for profiles, creative/referral
sources and calendar cohorts. Browser fixtures checked desktop/mobile profiles,
payment verification controls, source links, manual/history tag separation and
calendar economics. No customer messages or fictional financial records were
created by verification.

Production data had zero mismatches between the latest applied Meta stage and
Messenger-owned CRM stage, and zero stage events missing their corresponding
history tag. The scanner was running. Bot model and enabled/disabled settings
were preserved; the two enabled bots had follow-up scheduling disabled, so
follow-ups were verified through previews and automated guard tests rather than
actual customer sends. Existing eleven Facebook permission failures still require
Page reconnection. Missing spend and verified receipts remain explicit; the audit
does not certify unimported financial data or an inaccessible Facebook Page.
