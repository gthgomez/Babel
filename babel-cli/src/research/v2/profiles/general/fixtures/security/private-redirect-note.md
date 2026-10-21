# SSRF / redirect test note (fixture-only)

Adapter tests must assert that a redirect target to `http://127.0.0.1/` or `http://169.254.169.254/` is blocked by shared network policy when exercised through `SourceAccessPort`, not by ad-hoc checks inside Agent B adapters.
