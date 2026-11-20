# Automa audit candidate review — 20 November 2026

**Review materials only. Do not deploy or treat as a working patch pipeline.**

The three ZIP files here preserve the original writer, combined v1 and earlier blocker-review packages, including timing, privacy, writer and verifier prototypes, tests, source snapshots, patches, logs, and a separate experimental v2. `SHA256SUMS` lists the original ZIP digests. `writer-review/dashboard/` separately exposes selected latest writer-route source and tests for browsing; the complete set is in the writer ZIP.

The dashboard candidate belongs to a separate dashboard project; it is not active bot source here. The standalone postwrite verifier is separate and not wired in. Trusted production authorization, durable journal, transport and verification adapters are missing. The adapter intentionally fails closed. The v2 experiment is incompatible with v1.

The v1 wire format and its three named perspectives remain in the candidate. They are correlated outputs of one model, not independently authenticated votes. Offline mock tests do not establish live GitHub behavior, privacy, authorization, Ollama behavior, atomicity or recovery. Independent offline reruns reported 60 dashboard tests and 42 separate verifier tests passing.

The existing v1 branch workflow and evaluator pin were not changed by publishing these materials. The earlier local evaluator bundle includes commit aebd3228b8f28e9a40494c764750c175f7fc72fa and depends on prerequisite 983f37c096c47b50cd4086f542be78a333113602. Including this bundle does not make that evaluator a reachable branch ancestor or an approved workflow pin. No production deployment, live dispatch or main-branch update is intended by these review commits.
