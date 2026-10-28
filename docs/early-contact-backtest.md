# Projections before a commercial agreement

A projection is available from the first identifiable inquiry, before selecting a package or completing business details. It forecasts first documentary payment/deposit confirmation within 7, 14 or 30 days from that inquiry.

The following group had only inquiry / conversation signals at the frozen checkpoint: no completed business-details form, no selected duration, and no recorded reply after a quote. This is a behavioral proxy; explicit agreement was not independently labeled.

| Checkpoint | Payment horizon | Contacts still unconfirmed | Later confirmations | Predicted average | Observed rate | AUC | Timing error, days |
|---|---|---:|---:|---:|---:|---:|---:|
| 0 hours | 7 days | 5,514 | 192 | 4.07% | 3.48% | 0.568 | 1.13 |
| 0 hours | 14 days | 5,219 | 196 | 4.43% | 3.76% | 0.579 | 1.78 |
| 0 hours | 30 days | 2,423 | 107 | 4.79% | 4.42% | 0.608 | 2.93 |
| 6 hours | 7 days | 4,015 | 28 | 0.96% | 0.70% | 0.671 | 1.67 |
| 6 hours | 14 days | 3,821 | 35 | 1.23% | 0.92% | 0.693 | 3.19 |
| 6 hours | 30 days | 1,731 | 22 | 1.54% | 1.27% | 0.679 | 5.02 |
| 24 hours | 7 days | 3,901 | 19 | 0.54% | 0.49% | 0.675 | 1.40 |
| 24 hours | 14 days | 3,713 | 24 | 0.77% | 0.65% | 0.734 | 2.79 |
| 24 hours | 30 days | 1,688 | 18 | 1.07% | 1.07% | 0.726 | 5.75 |
| 72 hours | 7 days | 3,795 | 6 | 0.26% | 0.16% | 0.721 | 0.92 |
| 72 hours | 14 days | 3,616 | 13 | 0.47% | 0.36% | 0.750 | 2.67 |
| 72 hours | 30 days | 1,641 | 11 | 0.75% | 0.67% | 0.686 | 6.67 |

AUC measures ranking (0.5 is chance), not the percentage of correct buy/no-buy decisions. Timing error is measured only among later confirmations. Early probability is available even when an individual date is withheld for insufficient stage-specific evidence.

The underlying model and probabilities are unchanged. This audit adds stage-specific accuracy disclosure and applies the existing minimum of 30 replay confirmations to dates in that stage. It does not establish that the forecast has become more accurate.

Conversation snapshots use checkpoints at 0, 1, 6, 24, 72, 168 and 336 hours. Source refreshes check for documented payment and use the latest completed checkpoint; new messages between checkpoints are not claimed to be continuously scored.

Refreshing source data does not retrain the model. The versioned forecast ledger supports a future prospective test once outcomes mature. Source observation ends October 24, 2026 at 18:05:59 PHT.
