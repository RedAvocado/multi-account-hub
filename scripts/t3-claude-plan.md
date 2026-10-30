# Claude plan labels in T3 0.1.1

The hub reads confirmed Claude plan multipliers and Team seat tiers from the
OAuth profile. `/v1/usage` exposes the short `plan`; the Claude client usage
body also exposes a complete `plan_type`, such as `Claude Max 20×`.

T3 0.1.1 hardcodes `Claude Subscription` in its CLIProxy usage adapter.
`t3-claude-plan.cjs` is a local compatibility hook until that adapter consumes
the provided plan metadata. It enriches generic Claude labels using the same
hub and device credential, matching both account ID and email. Quotas, reset
credits, account grants and Codex records pass through unchanged. Unsupported
adapters and unavailable metadata retain the existing labels.

On this installation, the existing T3 `NODE_OPTIONS` preload at
`~/.t3/scripts/guard-workspace-indexer.cjs` calls this module's `installStartup()`.
It briefly sets a local debugger breakpoint after the usage adapter initializes,
wraps `readAccounts`, resumes immediately and disconnects. It opens no inspector
port and requires no T3 executable changes. The live service was updated using
the same method at its next normal usage refresh, preserving active sessions.

Remove that startup call when T3 supports the hub's `plan_type` natively.
Removing it restores T3's original behavior on the next service restart.

Validation: `node --test tests/t3_claude_plan.test.cjs`.
