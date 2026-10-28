# Forecast revision, October 28, 2026

The target remains the first documented payment or deposit acknowledgement.
Customer claims, CRM labels and unobserved private intent are not confirmed outcomes.
The complete source covers 43,764 eligible Page contacts through October 24, 2026.

Develop candidates on July 1–14 and August 1–14 inquiry cohorts only. Train each
model strictly before that cohort starts; later training outcomes are censored at
the training cutoff. Freeze conversation features at their actual historical
landmarks. Do not use final industry labels or later messages in earlier scores.
Select tree complexity and a single hazard calibration multiplier using those
development periods. All Day-30 development outcomes mature before September 14;
the August 1–14 Day-30 outcomes are NOT fully available at September 1. Therefore
the locked final replay must begin September 15. The earlier September 1–14 period
may be reported as development-context only and must not count as a holdout.

After parameters are locked, replay incoming weeks from September 15 through
October 19. Refit each week on information available before that week. Never tune
parameters using final replay results. Assess each horizon only for inquiries with
that full follow-up period; recent unpaid leads are not labelled as failures.
Historical replay is not a prospective test, and earlier reports already inspected
some September outcomes. Disclose this reuse rather than calling it fresh evidence.

Compare identical eligible contacts, horizons and checkpoints. Report probability
log loss, Brier error, calibration, AUC and actual/predicted payer rates. Report
timing error and 50%/80% interval coverage among the same later converters, without
improving apparent accuracy by dropping difficult timing cases. Bootstrap the
paired differences by first-inquiry calendar day, preserving within-day dependence.

Production probability replacement requires at least 2% lower equal-cell log loss,
no worse Brier error, and no Day-30/24-hour AUC decline greater than 0.02. A timing
replacement must not worsen Day-30/24-hour MAE on the same contacts; label weak
evidence honestly. Report all three horizons and their timing errors. Show estimated
remaining days and a conditional range, not a guaranteed date. Suppress unsupported
individual dates and identify broad-cohort estimates where only broad evidence
exists. If the candidate fails these gates, retain the existing probability model
and ship only independently supported improvements.
