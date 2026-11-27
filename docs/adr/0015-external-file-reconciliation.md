# ADR 0015: Reconcile native filesystem changes against document baselines

Status: Independently reviewed design. Verification is tracked in the
[external file reconciliation design](../design/external-file-reconciliation.md).

Bind a native directory descriptor to workspace admission and inspect open
paths relative to it. Reject a replaced root, follow no symlinks, and read
bounded regular UTF-8 files. A file that changes while being inspected must
not set a document baseline.

Use the native watcher as an invalidation source. Publish a latest-value
revision with one outstanding wait per workbench, rather than forwarding a
queue of filesystem events to the WebView. Reconcile from current disk state
on notifications, activation, and explicit refresh. Stop the subscription on
workspace retirement.

The renderer applies observations only to the same live document and
save/reload revision. A readable change can update a clean document; dirty,
missing, and unavailable files retain their buffer. A watcher observation
never authorizes a write or changes the conditional save contract in
[ADR 0009](0009-save-transactions.md).
