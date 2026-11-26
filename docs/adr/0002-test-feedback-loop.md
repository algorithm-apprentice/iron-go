# ADR 0002: Document-first, Test-driven Autonomous Feedback

Date: 2026-11-26.

Status: Accepted. Verification is tracked in the linked design.

Design: [Autonomous Testing](../design/test-feedback-loop.md).

## Context

A coding agent must be able to exercise features without relying on users to
open a project, type in the editor, or confirm that Go tools ran. Iron C++
uses focused tests and a separate macOS WebDriver acceptance build. A
browser-only test cannot validate Tauri commands, macOS WebKit, or the real
Go toolchain.

## Decision

1. First document change scope and acceptance oracles, then add a failing
   regression test, implement to green, and record verification. Keep durable
   decisions in ADRs and step-by-step behavior in linked design documents.
2. Use Node and Rust focused tests, Playwright for headless workbench
   behavior, and Iron C++'s embedded `tauri-plugin-wdio-webdriver` for native
   acceptance of real filesystem and Go processes.
3. Native acceptance uses deterministic, copied fixtures, a separate app
   identifier/assets, and a short-lived loopback driver. Never compile the
   driver into production. Bypass only the system folder picker and W3C
   keyboard differences; exercise real commands and Monaco models.
4. Provide one full-loop command plus individually runnable layers. Fail
   nonzero, preserve concise per-case evidence and failure diagnostics, and
   clean up processes and fixture directories even on failure.

## Consequences

Native tests need macOS, the Go toolchain and a working macOS app session.
The focused and headless layers give quicker failure localization. New
features should place tests at the least costly layer that can prove the
behavior, with native coverage for OS and bridge boundaries.
