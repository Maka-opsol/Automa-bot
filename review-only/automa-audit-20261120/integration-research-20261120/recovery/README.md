# Recovery and immutable write verification models

**Research only, not a dashboard integration and not deployable.** `immutable-postverify.js` validates synthetic immutable commit/tree/blob evidence, including the authorized old blob and a single-file full-tree change. It requires a complete, trusted raw-object reader; none is provided. It does not establish provider attribution or operation provenance.

`journal.py` models branch locking, one-use reservations and recording a trusted authenticated provider response before verification. This SQLite experiment is not a production shared durable journal. A write whose outcome is unknown stays locked for separately authorized reconciliation; do not resend or unlock it automatically. Its HMACs do not encrypt or authenticate an entire database. Trusted authorization, caller identity, response authentication, key management, storage durability, compare-and-swap, no-retry transport and operational controls remain unimplemented.

Run locally: `node --test test-immutable.js` and `python3 -m unittest -v test_journal`. `mock_verify.js` is a synthetic test bridge, not a provider adapter. Tests do not prove production atomicity, privacy, failover or crash durability.
