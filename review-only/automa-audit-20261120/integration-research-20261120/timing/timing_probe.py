"""REVIEW-ONLY, offline timing probe; not wired into production evaluator.

The caller chooses a private sink. Events contain only fixed phase names, outcome,
and monotonic elapsed milliseconds. No source, response, exception, paths, nonce,
identifier, or credentials are passed to the sink. Never use as an audit verifier.
"""
import time

PHASES = ('version', 'tags', 'vote_security', 'vote_correctness', 'vote_intent')
PATHS = ('/api/version', '/api/tags', '/api/generate', '/api/generate', '/api/generate')

def wrap_transport(transport, sink, clock=time.monotonic_ns):
    index = 0
    def wrapped(path, payload=None):
        nonlocal index
        # If calls are unexpectedly ordered, remain transparent and do not log
        # arbitrary names; evaluator, not telemetry, enforces the audit contract.
        i = index
        index += 1
        if i >= len(PHASES) or path != PATHS[i]:
            return transport(path, payload)
        start = clock()
        outcome = 'error'
        try:
            result = transport(path, payload)
            outcome = 'ok'
            return result
        finally:
            elapsed_ms = max(0, (clock() - start) // 1_000_000)
            try:
                sink({'phase': PHASES[i], 'outcome': outcome, 'elapsed_ms': elapsed_ms})
            except Exception:
                # Telemetry must not create an approval or break audit semantics.
                pass
    return wrapped
