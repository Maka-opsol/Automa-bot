# Automa audit integration research

**Review-only. Not deployable or integrated.** These independently exercised models do not implement dashboard authentication, confidential transport, a production writer, durable shared recovery, a trusted Git-object reader, or provider compare-and-swap. Do not merge or deploy based on these tests. No live production traffic, model inference, workflow dispatch or write was used.

- `authorization/`: generic receipt and single-use authorization boundary model and fake-adapter tests.
- `recovery/`: immutable Git-object verification and crash-recovery journal models with synthetic tests.
- `timing/`: privacy-minimal timing probe and offline tests; not wired into the evaluator.

All authorization, transport, object-reading, persistence and operation-provenance adapters must be trusted, implemented and independently tested before any deployment. Ambiguous writes remain locked pending authorized reconciliation; do not retry automatically. Preserve the exact security, correctness and intent votes and fail closed. The dashboard is a separate repository: these models do not alter its route.

The branch baseline when this research was prepared was `532db01f5cfd4661e1e384a8d90b6db716bd62b2`; the evaluator was pinned to commit `36414530844a00eb0df5ff1e912299ee57dfe62e6` and blob `5189f8d83debf8b7b78f3bb1cf03db9255a97d63`. Tests are offline only and do not validate production safety, privacy, recovery, hosted timing or independent authentication of votes.
