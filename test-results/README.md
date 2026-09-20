# test-results

Copied diagnostic bundles from live testing live here, organised as:

```
test-results/
  live/
    YYYY-MM-DD/
      Txx-scenario-name/
        run-001/
          *.zip
          analysis/
        run-002/
          *.zip
          analysis/
```

**This directory is gitignored.** A bundle is evidence from a real session and
is not committed. Only a sanitized, minimal regression fixture may enter Git,
and it belongs under `tests/fixtures/boss/regression/<issue-id>/`.

See `docs/live-testing/RUNBOOK.md` for the procedure and
`docs/diagnostics/PRIVACY.md` for what a bundle does and does not contain.
