# Security Policy

## Supported Versions

Only the latest minor release gets security fixes. Update before reporting.

## Reporting a Vulnerability

Do not open public GitHub issues for security vulnerabilities. Public disclosure before a fix is available puts all users at risk.

Instead, use [GitHub's private vulnerability reporting](https://github.com/rolfhelder/claude-keepalive/security/advisories/new): open the **Security** tab and choose **Report a vulnerability**. This keeps the report confidential until a fix is ready.

Include the plugin version, Claude Code version, steps to reproduce and the impact you see.

## Scope

In scope:

- Command injection through settings, arguments or anything the plugin passes to a shell
- The hooks module: what it runs, and when
- Pings sent into a session you did not ask for (wrong session, after `off`)
- Files the plugin writes (settings files it writes for `--global`): location, permissions, contents
- Data leaving the machine. The plugin is not meant to send anything anywhere
- Prompt injection through the unknown-command handoff, where an unrecognized argument is passed to the model

Out of scope: bugs in Claude Code itself (report those to Anthropic), and issues that need an already compromised machine.

## Response

This is a personal project. Responses are best effort, usually within 7 days. There is no bug bounty.
