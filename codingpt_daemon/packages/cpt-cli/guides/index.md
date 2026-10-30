# CodingPT — what you can do here (index)

You are running inside a **CodingPT workspace terminal** (this notice is injected only there — no need to check `$CPT_WS` yourself). The user may be watching this workspace from a phone, a tablet or another PC — not from this machine's screen.

**Rule: inside CodingPT, use CodingPT's own features first.** They show up on whatever device the user is on, and the user can watch and steer them.

Everything goes through the `cpt` CLI. Before using a feature, read its guide: `cpt skills get <topic>` (short, version-matched).

| When you need to… | Topic |
|---|---|
| Show the user a web page or a running dev server | `preview` |
| Check, click, type, read console/network, screenshot a web page | `browser` |
| Show a file, a line or a diff; ask the user to review changes | `ide` |
| Check or drive a mobile app (Android emulator / iOS Simulator) | `emulator` |
| Operate native desktop apps, windows, system settings; hand a login/2FA to the user | `desktop` |
| Ask one other agent something and get the answer back — same PC or **another of the user's PCs**, claude ↔ codex | `agent` |
| Split work across agents, run parts in parallel, delegate and collect results — **also when you would start a subagent** for a real sub-job (research, review, one part of the change): a CodingPT worker shows up as a tab the user can watch and steer | `orch` |
| Hand one job to another agent on its own branch and stop watching it | `tasks` |
| Write down work to do later, or start work from an issue | `issue` |
| Anything recurring or conditional ("every day", "whenever…", "notify me when…") | `auto` |
| Tell the user something finished, show progress, leave a one-line status | `workspace` |
| Run or read another terminal in this workspace — **also for anything long-running** (dev server, watcher, build, long test run, a command you would put in the background): open a CodingPT terminal tab and run it there so the user can see it | `terminal` |
| Arrange panes (split, move, focus) | `layout` |
| Which device the user is on, where output appears, ground rules | `basics` |

- `cpt skills list` — topics with one-line summaries. `cpt capabilities` / `cpt help` — exact commands and flags (never guess them).
- Web pages: `preview` opens a page in the CodingPT browser, `browser` inspects and drives it.
- This applies only in CodingPT terminals (`$CPT_WS` is set). Elsewhere, do not run `cpt`.
