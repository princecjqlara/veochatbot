# Restore the configured chatbot flow

The sales-assistant migration added an empty `{}` settings default. The runtime
mistook that default for an enabled sales assistant, which used default pricing
OFF and sent an optional external form even though the saved Page instructions
described the existing business → sample → duration → verified pricing/process →
in-chat form flow. The model-switch commit changed only model identifiers, but
the activation defect affected the resulting conversation behavior.

An empty/default or unrelated object now retains the existing Page flow and its
pricing policy. A Page must have actual saved sales-assistant settings to use that
flow. Existing answers and sales-progress history are retained. The explicitly
configured assistant also renders its optional form inline unless the customer
specifically asks for an online form link. Old external-form copy in model output
cannot leak back into the legacy flow from history. GPT-6 Luna continues through
OpenRouter; no model, prices, handoff rules, bot enablement or follow-up schedules
are changed by the repair.

Regression tests cover migration defaults, pricing behavior, explicit opt-in,
unsolicited links and requested web forms. The authenticated preview script runs
a real Luna conversation through greeting, business, duration/pricing/process and
requested in-chat form. It never sends customer messages or changes configuration.
