# ADR 0024: Keep structured Go test results independently of visible output

Status: Independently reviewed design. See [structured Go test results](../design/go-test-results.md).

Use the Go test JSON protocol under the existing native task owner. Keep its
human-readable output in Output, but apply separate wire and display budgets.
Clipping the display does not stop result collection; losing wire events or
interrupting unfinished tests marks results incomplete.

Group results by the originating package and full test name, keeping Go build
variant attribution. A successful repeated attempt does not erase an earlier
failure. Link only known absolute source paths under the admitted workspace.
