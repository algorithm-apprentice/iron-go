# ADR 0022: Overlap independent feedback layers

Status: Independently reviewed design. See [feedback test efficiency](../design/feedback-test-efficiency.md).

Keep the test layers in [ADR 0002](0002-test-feedback-loop.md). Run static and
service checks, headless Chromium, and native acceptance concurrently while
keeping native app groups sequential. Wait for every layer and surface each
failure. The acceptance-only frontend build omits the duplicate static
typecheck; the feedback check stage and normal app build retain it.

Keep operating-system teardown with the native runner. The feedback process
signals the native coordinator on interruption, while independent browser
and check stages finish their own cleanup.
