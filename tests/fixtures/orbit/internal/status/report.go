package status

import (
	"fmt"
	"time"
)

// Report describes the service at a point in time.
type Report struct {
	Name    string
	Version string
	At      time.Time
}

func NewReport(name, version string, at time.Time) Report {
	return Report{Name: name, Version: version, At: at.UTC()}
}

func (r Report) Summary() string {
	return fmt.Sprintf("%s v%s is online", r.Name, r.Version)
}

func (r Report) Render() string {
	return fmt.Sprintf("%s\nChecked: %s", r.Summary(), r.At.Format(time.RFC3339))
}
