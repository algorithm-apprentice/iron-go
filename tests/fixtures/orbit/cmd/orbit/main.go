package main

import (
	"flag"
	"fmt"
	"time"

	"example.com/orbit/internal/status"
)

const version = "0.1.0"

// Orbit prints a snapshot of the current service status.
func main() {
	compact := flag.Bool("compact", false, "print a one-line report")
	flag.Parse()

	report := status.NewReport("orbit", version, time.Now())
	if *compact {
		fmt.Println(report.Summary())
		return
	}

	fmt.Println(report.Render())
}
