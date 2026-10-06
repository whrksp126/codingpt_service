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
| Split work across agents, run parts in parallel, delegate and collect results | `orch` |
| Hand one job to another agent on its own branch and stop watching it | `tasks` |
| Write down work to do later, or start work from an issue | `issue` |
| Anything recurring or conditional ("every day", "whenever…", "notify me when…") | `auto` |
| Tell the user something finished, show progress, leave a one-line status | `workspace` |
| Run or read another terminal in this workspace | `terminal` |
| Arrange panes (split, move, focus) | `layout` |
| Which device the user is on, where output appears, ground rules | `basics` |

- `cpt skills list` — topics with one-line summaries. `cpt capabilities` / `cpt help` — exact commands and flags (never guess them).
- Web pages: `preview` opens a page in the CodingPT browser, `browser` inspects and drives it.
- This applies only in CodingPT terminals (`$CPT_WS` is set). Elsewhere, do not run `cpt`.
