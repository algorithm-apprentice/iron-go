# ADR 0025: Verify Go test reruns against the captured package snapshot

Status: Independently reviewed design. See [structured Go test results](../design/go-test-results.md).

Bind each rerun request to a literal workspace directory, import path, and
full test name. After the ordinary save barrier, verify the effective Go
environment and package identity under the same owner that launches Go Test.
Reject manifests and redirects outside the verified source signature and
refuse a changed snapshot at handoff.

Use Go's anchored component name filter with `-count=1`, without promising
identity Go itself cannot distinguish when names contain slash separators.
Report when the selected name has no observed run event.
