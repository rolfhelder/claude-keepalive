# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/): fixes are patches, new features are minors.

## [1.0.1] - 2026-11-17

### Fixed
- `/keepalive view` back to above the prompt no longer leaves a stale entry in the status line.

## [1.0.0] - 2026-11-17

### Added
- One ping per idle stretch shortly before the prompt cache expires; a ping's own turn never re-arms it, only a turn you start does.
- Working-hours schedule (default Mon–Fri 9 am–5 pm, local time), changeable with `/keepalive setup`.
- `/keepalive` toggles the session; `on` / `off`, with `--global` for the default of new sessions (off by default).
- `/keepalive margin <min>`: how many minutes before expiry to ping (default 2, at most half the cache length).
- `placement` setting and `/keepalive view`: show the line in a fixed row above the prompt or in the status line.
- Skips a minute while you have a draft typed; recovers if a turn is interrupted.
- Unrecognised `/keepalive` input is handed to Claude with the command's help.
- Session state survives `--resume` / `--continue`.
