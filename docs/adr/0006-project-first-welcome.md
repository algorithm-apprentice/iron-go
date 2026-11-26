# ADR 0006: Project-first Welcome with No Default Project

Status: Accepted.

Design: [Project-first onboarding and opening on macOS](../design/goland-projects.md).

Follow GoLand's project-oriented entry flow, not a pre-opened mock project.
Start at welcome and limit Orbit to development tests; neither desktop nor
browser builds bundle a default project. Keep the Go module/workspace context and ordinary
project lifecycle; no GoLand project file format is required. Keep selecting
project roots natively, with a standalone panel rather than an attached sheet.

This supersedes the bundled sample in ADR 0001, not its platform or Go tooling decisions.
