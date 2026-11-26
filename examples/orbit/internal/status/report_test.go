package status

import (
	"testing"
	"time"
)

func TestSummary(t *testing.T) {
	r := NewReport("orbit", "0.1.0", time.Unix(0, 0))
	if got, want := r.Summary(), "orbit v0.1.0 is online"; got != want {
		t.Fatalf("Summary() = %q, want %q", got, want)
	}
}
