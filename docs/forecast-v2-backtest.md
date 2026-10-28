# Conversion forecast backtest — October 28, 2026

Release gates: **PASS**.

Source: 43,764 eligible Page contacts, observed through 2026-10-24 18:05:59 PHT. Target: first documented payment/deposit confirmation.

Models were developed on July and August cohorts, then replayed on later weekly cohorts from September 15. Each refit uses only history available before that test week. The final replay contains 5519 unique contacts with at least one mature horizon. Previously reviewed September history is reused; this is not a prospective accuracy claim.

Equal horizon/checkpoint log loss improved 5.8%; Brier error improved 4.1%. These are error reductions, not the percentage of customers predicted correctly.

| Horizon from first inquiry | Checkpoint | Contacts still unpaid | Later confirmations | Old probability AUC | New AUC | Old timing MAE days | New timing MAE days | New within 3 days | New range coverage |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 7 days | 0 hours | 5,519 | 192 | 0.534 | 0.568 | 1.11 | 1.13 | 88.5% | 87.5% |
| 7 days | 24 hours | 5,399 | 72 | 0.778 | 0.834 | 1.45 | 1.26 | 94.4% | 76.4% |
| 7 days | 72 hours | 5,351 | 24 | 0.772 | 0.800 | 1.06 | 1.02 | 100.0% | 83.3% |
| 14 days | 0 hours | 5,224 | 196 | 0.539 | 0.579 | 1.76 | 1.78 | 82.1% | 85.2% |
| 14 days | 24 hours | 5,108 | 80 | 0.783 | 0.831 | 2.64 | 2.36 | 73.8% | 86.2% |
| 14 days | 72 hours | 5,066 | 38 | 0.786 | 0.796 | 2.54 | 2.34 | 63.2% | 86.8% |
| 30 days | 0 hours | 2,426 | 107 | 0.561 | 0.608 | 2.92 | 2.93 | 78.5% | 86.0% |
| 30 days | 24 hours | 2,359 | 40 | 0.701 | 0.761 | 5.69 | 5.41 | 52.5% | 77.5% |
| 30 days | 72 hours | 2,344 | 25 | 0.694 | 0.732 | 6.53 | 6.44 | 24.0% | 84.0% |

Timing is evaluated only among contacts who later confirmed within that horizon. Probability accuracy includes both converted and unconverted contacts. Range coverage is measured on the later replay, after interval corrections were fitted on earlier development cohorts.

Day-30 at 24 hours: paired timing-error difference (new minus old) = -0.28 days; 95% calendar-day bootstrap interval -1.31 to 0.48 days. Negative values favor the new formula.

The forecast cannot reliably promise that a particular person will buy or give an exact purchase date. Early inquiries and small groups need wider uncertainty. The probability refers to remaining confirmation by 7/14/30 days from first inquiry. A closed window is not a never-buying conclusion.

Detailed probability calibration, all checkpoints, five-Page breakdowns, paired uncertainty and every release gate appear in backtest-report.json. No private conversation text is included in this summary.
