# Automa audit candidate review — 20 November 2026

**Review materials only. Do not deploy or treat as a working patch pipeline.**

- `writer-review/` contains browsable files for the newest v1 dashboard route candidate, its tests and logs. The dashboard source belongs to a separate dashboard project and is not an active bot source file here. The immutable postwrite verifier is separate and not wired in.
- `packages/` contains lossless Base64 representations of the three original ZIP review packages. They preserve the earlier timing, privacy, writer, v1, and v2 experimental artifacts, including tests, logs, prior source snapshots, patches and local evaluator history. Decode each `*.zip.base64` to obtain the original ZIP; `SHA256SUMS` records the original ZIP digests.
- v1 wire format and its three named Ollama perspectives are retained in the v1 candidate. They are correlated perspectives of a single model, not independently authenticated votes. The separate v2 experiment in the packages is incompatible and is not a substitute for v1.
- The writer candidate has no trusted production authorization, durable journal, production transport or commit-verifier adapters. Its adapter intentionally fails closed; offline mock tests do not establish live GitHub behavior, privacy, deployment safety, Ollama behavior, or recovery. The published v1 branch workflow and evaluator pin are not changed by this review-material commit.
- The earlier local evaluator bundle has commit aebd3228b8f28e9a40494c764750c175f7fc72fa and depends on prerequisite 983f37c096c47b50cd4086f542be78a333113602. Including the bundle does not make this evaluator a reachable branch ancestor or an approved workflow pin.
- Independent offline reruns for the newest package reported 60/60 dashboard tests and 42/42 separate verifier tests. No production deployment, live audit dispatch or main-branch update is intended by this commit.

Package digests are those of decoded original ZIP bytes.
