# Audit timing research

**Review-only; not wired into the evaluator.** `timing_probe.py` records only fixed phase labels, outcomes and elapsed milliseconds to a caller-provided sink. Events are non-authoritative and must never decide approval. Telemetry governance and deployment need separate review.

Run `python3 -m unittest -v test_timing_probe` from this directory in this repository. The test imports the bot's evaluator and uses synthetic transport responses; it does not run a model or measure GitHub Actions. `benchmark_offline.py` needs the Python `tokenizers` dependency and `TOKENIZER_PATH` pointing to the verified pinned tokenizer JSON; it runs against a loopback mock and is not predictive of hosted performance.

Existing nested limits (30-minute job, 300 seconds per HTTP request, 45-minute dashboard audit ceiling, 50-minute authority boundary and 2-minute reserve) are competing limits, not a guarantee each call receives its maximum. All three named votes remain required, and timeouts fail closed. No hosted timing baseline is established by these tests.
