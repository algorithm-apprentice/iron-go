# Orbit

Orbit is a small Go module used exclusively as an Iron Go test fixture. It
prints a service status report and uses only the standard library.

```sh
go run ./cmd/orbit
go test ./...
```

Native tests run disposable copies. Orbit is not bundled with the IDE.
