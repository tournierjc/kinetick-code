# TUI capability coverage

The current capability target is **TUI 0.4.12**; see [version and evidence baseline](open-source-status.md#version-and-evidence-baseline) for the separate workspace and embedded-tool versions. “Restored” below describes implementation and assembly, not acceptance of every account or online service.
## Regular-mode terminal history
Regular mode preserves native terminal history, including shell output from before
MCode started. Rows already emitted into scrollback are snapshots of what was shown
at that time; folding, completed tools and later edits do not rewrite those rows.
The live application view remains the source for the current transcript.

Long turns keep a bounded live projection. Dropping its oldest cells does not replay
the welcome banner or erase earlier output. When activity or Todo panels shrink,
released rows temporarily remain blank between the transcript and footer; new
output consumes that space. Tables and code blocks remain contiguous. Short
conversations also anchor the welcome rows, so background status changes and
footer completion do not replay the banner or duplicate existing warnings.
Accepting a submitted message retains its emitted row identity, so the first
prompt does not introduce a refresh boundary or duplicate a long message.

When an unrelated transcript replaces the current projection, a labelled refresh
boundary separates the retained output from the new document. Resize and forced
redraw preserve pending output and native history, including consecutive resizes
while output is held or fullscreen mode is active. Mode changes preserve the main
state after its final pending frame is flushed. Explicit resume-start history
clearing remains a separate startup policy. Native image history is retained until
the terminal itself evicts it.

Transient overlays use an alternate buffer so opening, nesting or resizing panels
cannot place menu rows in native history. Closing the last overlay restores the
main buffer and reconciles background output; terminal shutdown also restores it.
Unchanged overlay frames produce no terminal output. Text changes update only
affected rows, while cursor changes preserve IME positioning and visibility.
Forced redraws and geometry changes invalidate that frame cache; image changes
retain full-frame repaint.
## Output speed
The activity line and completed-turn summary show provider output tokens divided by
model generation time. Timing starts at the first nonempty text, reasoning, or tool
token and ends when the model finishes, excluding first-token wait and tool execution.
Multiple responses in a turn use total tokens divided by total generation time.

Speed appears after the first response with both provider usage and generation timing;
streaming text is not estimated. Confirmed speed stays visible during later requests
and tools, duplicate messages do not count twice, and a new turn resets the samples.
Messages without generation timing are excluded. Values below 10 tok/s use one decimal
place; higher values are rounded to integers. Batched provider events measure the
observed generation window, not server hardware throughput.
## Terminal titles and notifications
Terminal titles show the current state, session name and MCode, for example
`Needs approval | Fix login | MCode`. Renaming or switching a session updates the
title. Unnamed sessions use the project name and a short session ID. Titles are
cleared when MCode exits or suspends and reapplied when it resumes.

Configure these presentation settings in the MCode data directory's `config.yaml`:

```yaml
tui:
  terminalTitle: [status, session-name, app-name]
  notifications:
    when: unfocused
    method: auto
    events: [turn-complete, turn-failed, permission-required, question-required]
```

Title items can be ordered or omitted; `project-name` is also available. Set
`terminalTitle` to `null` or `[]` to disable title updates. Unknown items are ignored.
Notification `when` accepts `unfocused`, `always` or `never`; `method` accepts
`auto`, `osc9`, `osc777` or `bel`. Omitting `events` enables all four events; `[]`
disables them. Apply configuration changes by restarting MCode.

Notifications identify the session and suppress duplicates. Completion waits for
the session's queue to finish; failed turns and requests for input can notify
independently. Known foreground focus suppresses notifications by default. When
focus is unknown, delivery is best-effort; cmux manages its own surface focus.
Automatic delivery uses the detected terminal's notification protocol or falls
back to a bell. The existing Windows toast bridge is restricted to local Windows
or WSL interop. Terminal settings and OS notification permissions still apply.

VS Code normally displays a process name in its terminal tabs. To display MCode's
session titles, use this VS Code setting:

```json
"terminal.integrated.tabs.title": "${sequence}"
```

A manually assigned tab title overrides automatic titles. VS Code's bell is a
terminal-tab indicator, not a guarantee of a desktop notification. See the
[VS Code terminal appearance documentation](https://code.visualstudio.com/docs/terminal/appearance#_tab-text).
Inside tmux, OSC notifications require passthrough and support from the outer
terminal; use `method: bel` for a bell fallback.

The evidence column summarizes the historical TUI 0.3.11 restoration record from 2026-09-11. It does not claim fresh TUI 0.4.12 live-service acceptance. Use [current verification status](verification.md#current-source-verification-status) for checks run against the updated source and explicit NOT RUN boundaries.

| Capability | Implementation | Evidence |
| --- | --- | --- |
| MiniMax login, logout, Token Plan, quota, check-in | OAuth Core, account clients, and TUI / CLI entry points restored | Login-state, auth-command, check-in, provider, and ACP tests; production Token Plan session and resume passed |
| BYOK / custom models | Retained; headless model overrides no longer inherit the default Token Plan login requirement | Local protocol server drives runtime, resume, and file tools; live BYOK session passed; managed models still reject unauthenticated requests |
| mcode-tools | Public package's unchanged 0.0.4 artifact, launcher, and short-lived token leases restored | Archive SHA-512, CLI SHA-256, real CLI startup, lease and host integration tests; production shared-broker authentication passed |
| Search and Matrix image / audio / video tools | Matrix MCP and tool assembly restored; search is independent of mcode-tools | MCP configuration and auth-isolation tests; actual search passed; generation requests not run |
| Official and local plugins; runtime GitHub importer | `/plugins` and `mcode plugin` manage official installations and discovered local packages; arbitrary marketplace registration and GitHub URL import are not exposed in the CLI/TUI. See [plugin management](examples.md#4-manage-plugins) | Plugin application, source-page, and offline local CLI tests; actual official catalog read passed |
| Managed connectors | Cloud client, permissions, and invocation adapters restored | Connector runtime and cloud transport tests; actual tool discovery passed; business writes not run |
| Updates | Update entry points, install-source detection, and signature verification restored; public packages use public npm | Update application and service tests; no real installation / upgrade on the development machine |
| Feedback and diagnostic uploads | Reviewed feedback text and minimized diagnostic summaries | Synthetic fixtures exercise session collection and capture/decode the final ZIP upload; no live uploads or real content |
| Automatic LLM error reports | Disabled by default; requires `telemetry.diagnostics` opt-in; bounded diagnostic facts minimized before encryption | Synthetic provider errors and native Headers; final HTTP batches captured and decrypted locally |
| Telemetry | Usage, metrics, and diagnostics each disabled by default with separate opt-ins; `MCODE_DISABLE_TELEMETRY` / `DO_NOT_TRACK` override all channels; usage-event identifiers removed | Privacy regression tests intercept and decode requests locally; no live upload |
| Auto permissions | Cloud classifier restored; local rules and confirmation on failure retained | Classifier client, permission facade, and sandbox tests |
| Model catalog | Online catalog and bundled snapshot fallback restored | Actual build boundary checks and offline startup; online catalog contents not accepted |
| Files, shell, subagents, sessions, headless, ACP | Actual runtime retained | BYOK, file reads, session resume, ACP, sandbox, and status protocol tests |
| Built-in skills, MCP, plugin tools | Original TUI assets and activation conditions retained | Asset build, plugin, and MCP tests; no claim that every skill has passed a real task |
## Local Bash execution
When the current turn includes native `task_output`, foreground Bash waits up to
60 seconds before returning the same command's background task ID. Its total
command timeout defaults to 600 seconds and is capped at 600 seconds; a shorter
requested timeout applies. Backgrounding and output reads preserve the original
deadline. Without native `task_output`, Bash stays in the foreground with a
120-second default and a 300-second cap, and its schema omits `run_in_background`.
Explicit background commands use the requested timeout; when omitted, the
existing 30-minute runtime watchdog applies.

Only exit code zero is success. Results retain available exit, signal, timeout,
cancellation, and partial-output facts. Large output keeps its original beginning
and end within a 24 KiB first-response text budget, with a full-log reference when
persistence succeeds. `task_output` reads use byte offsets; a successful read can
report a failed command. Stop failures and incomplete logs are reported separately.
An optional `description` supplies the TUI summary while execution and permission
checks continue to use the original command.
## Process sandbox
The default is no process sandbox. `getDefaultSandboxSettings` returns
`enabled: false` and filesystem mode `full_access`, and `full_access` is
normalized back to sandbox disabled. In that state bash is a host shell of the
user who started Kinetick Code. Permission checks still apply.

Turning the sandbox on with `read_only`, `workspace_write`, or `delete_guard`
is a filesystem cage when the sandbox backend is ready. An enabled sandbox
whose backend is not ready fails closed and does not run the command on the
host. Grep and glob spawn host `rg` and stay outside that cage.

The sandbox does not restrict the network. A saved `sandbox.network` block,
including `policy.mode: deny` and `deniedDomains`, is accepted so older config
files still parse, then normalized to unrestricted network
(`network.enforce: false`, `allowAll: true`). Outbound host policy is the
separate egress guard in [Egress policy](egress-policy.md).
## Stopping a conversation and its background work
An explicit user stop (Esc in the TUI) also cancels background Bash commands and
subagents owned by that conversation in the current process, including activated
`task_append` continuations and work spawned by their child turns. Completion
notices for those tasks no longer automatically wake the conversation. Their
terminal results remain unread so the next turn can inspect them through the
background-task reminder and `task_output`.

Leaving a conversation with `/clear` or a session switch still stops its current
turn and pauses its Goal and queued instructions, but leaves background work
running. This pause also applies when unconsumed steering must fall back to the
queue after a history-write failure. A stop rejected because it names an older
turn does not cancel the current turn's background work.

Only locally owned running tasks are canceled; tasks held by another runtime
process are left alone. Child cleanup follows the task's owning child turn, so a
later continuation in the same child session is preserved. Delivery suppression
is held in process memory. If a turn does not release within the abort timeout,
work created later during its shutdown is outside the stop boundary. A delivery
already being admitted can also race with a stop.

Offline regression tests cover cascade ownership, delivery suppression, late
task creation, repeated stops, append completion/shutdown, and queue fallback.
The host integration tests use a scripted runner and real background processes;
they do not establish live-model or cross-platform acceptance.
## Agent spawn policy
Declarative agent-to-agent spawn rules are Kinetick Code behavior, carried by
a Custom Agent's canonical `agent.md` under `x-mavis`. They compose with — and
never replace — the runtime-owned built-in feature policy (`features.delegation`)
and the canonical role tool ceilings; those decide capability, this decides
permission between named Agents.

- `x-mavis.spawnMode: subagent-only | master-only | both` (default `both`,
  today's behavior). A `master-only` Agent rejects `task` spawns from a task
  child; a `subagent-only` Agent rejects user-initiated Session creation
  (TUI, CLI, and `POST /sessions`) and remains spawnable by other Agents.
- `x-mavis.canSpawn: [names]` restricts which parent Agents may spawn this
  Agent through `task`. Entries are stable Agent names (case-insensitive). A
  task-child spawn with an allowlist and an unresolvable parent identity is
  denied (fail closed on an explicit restriction).
- An Agent with no `x-mavis` policy block behaves exactly as before: the gate
  fails open on missing policy, missing port, and unreadable policy files.
- Built-in Agents (`mavis`, `explore`, `worker`, `verifier`) carry no Custom
  file policy; their runtime-owned policy remains the only gate.
- `agent list` (native `mavis` tool) and the management `listAgents` response
  expose `spawnMode`/`canSpawn` so clients can render the spawn graph.

## Skill directory links
Workspace `.agents/skills`, `.claude/skills`, and `.minimax/skills` support
directory symlinks, both for the entire skill root and for individual skill
directories. Targets may live outside the workspace. Existing external-source
enable settings and duplicate-name priority still apply. Linked directories are
watched for `SKILL.md` creation and edits; broken links are skipped. `SKILL.md`
itself must remain a regular file.
## ACP Skill commands
ACP clients receive enabled Skills alongside built-in slash commands when a session
is created, loaded, resumed, or forked. Discovery uses the session's Agent and
workspace, including installed plugin Skills. Command names come from the runtime
Skill roster (for example, `/review` or `/plugin:review`), not the installation
package name. Select a command and append instructions to invoke it through the
normal Agent turn. ACP `/skills [filter]` only lists the session's available Skills.
Session policy and proposal review are interactive TUI commands; ACP does not
advertise them.

Built-in command names take priority over conflicting Skill names. Disabled,
duplicate, and invalid command names are omitted. If Skill discovery fails,
built-in commands remain available. Reopen the session after installing or enabling
Skills to refresh its command menu. Protocol tests cover command discovery and
prompt forwarding; this does not establish live Zed or model acceptance.
## Skill and Memory management
Session Skill policy, prompt-conditioned Skill and Memory reminders, and
human-reviewed idle drafts are Kinetick Code behavior. They are not part of
upstream MiniMax Code. Upstream synchronization must not treat these paths as
inherited product surface.

Interactive control is `/skills` in the TUI:

- `/skills [filter]` lists Skills. The words `require`, `optional`, `forbid`,
  `clear`, `policy`, `review`, `approve`, and `reject` are reserved verbs, so a
  Skill literally named `review` cannot be filtered with `/skills review`.
- `/skills require|optional|forbid <name>` sets that Skill's disposition for the
  current Session. Mandatory Skills stay in the catalog even when an Agent
  allowlist omits them. Forbidden Skills are removed from the system-prompt
  catalog and from prompt-match reminders.
- `/skills clear <name>` removes an explicit disposition. An open Session then
  treats that Skill as optional again. A closed Session hides Skills that have
  no explicit disposition.
- `/skills policy` shows the Session's mandatory, optional, and forbidden Skills.
- `/skills review` lists pending Skill and Memory drafts.
- `/skills approve|reject <proposal-id>` applies or discards one pending draft.
  Approval writes the draft only after the write succeeds. A failed write leaves
  the proposal pending so it can be retried or rejected. Rejection never writes.

The session server exposes the same writes to remote clients:
`POST /sessions/<id>/skill-policy` sets one Session's dispositions, and
`GET /skills/proposals` plus `POST /skills/proposals/<id>/review` list and decide
pending drafts. Routes, query parameters, and status codes are in
[harness integration](harness-integration.md). Direct Skill file create, edit, and
delete remain unexposed over HTTP.

Each user turn may add a `<prompt-skill-match>` reminder for Skills whose name
or description overlaps the latest prompt, and a `<relevant-memory>` reminder
for short overlapping Memory excerpts. Forbidden and closed-catalog Skills are
omitted. Mandatory matches are tagged and ranked above optional ones. The
memory reminder is bounded prompt overlap. An earlier default left it out
because unscoped recall spent roughly 500–1000 tokens per turn at low precision.

Idle drafts run after each completed turn of a root Session, not once per
Session and not for branch or task Sessions. The runtime counts persisted user
prompts and reads their recent text, then drafts one Skill proposal and one
agent-Memory proposal when that count reaches eight and the Session has no
pending proposal. The Session title is a label on the draft, not the source of
its themes. Drafts stay in `local-runtime/knowledge-proposals.json` until a
human approves or rejects them. Approving a Memory draft appends agent Memory.
Only a draft whose target is `user` appends user Memory, and the TUI host
refuses that write because it has no user-scoped Memory surface. Memory writes
also follow `memory.enabled`; the headless CLI does not apply them. The store
writes through a temporary file and rename. A corrupt file is left in place
instead of being replaced with an empty list. Pending drafts are kept; older
approved, rejected, and cancelled records are pruned.
## Desktop boundary
Background workspace indexing is removed from this distribution. Runtime startup and conversation turns do not collect workspace snapshots, create workspace ZIP archives, or upload/retry them for cloud indexing. The semantic workspace search tool and its enablement policy are also removed; a saved indexing preference cannot reactivate them. Existing indexing records are left inert. User-directed file reading, search, and Git operations remain available.

Desktop features not enabled by default in the original TUI are outside this restoration commitment: remote encrypted prompt updates, cloud session handoff, and native Electron desktop control. Earlier descriptions incorrectly counted removal of those sources as TUI feature loss. Desktop HTTP services and internal generated IDL remain outside the public repository.

Website deployment tools and routes follow the original tool set. Successful deployment still depends on login, service permissions, and backend support; no real deployment has been performed.
## Release boundary
Production client paths are restored without internal registries or test-service addresses as build dependencies. Real account behavior, quota, billing, model quality, media generation, and deployment require separate acceptance. Mocks, protocol fixtures, successful builds, and the source import do not replace that evidence. Public npm `latest` was 0.4.12 on 2026-09-18; that metadata observation does not validate the installed package or deploy a backend. See [verification records](verification.md) and the historical [release audit](release-audit.md) for recorded acceptance results.
## Diagnostic upload privacy
Automatic LLM error reports use an allowlist before buffering and encryption. Schema 3 retains a numeric release version, the fixed metric error category, known error names/codes, HTTP statuses (100–599), and bounded error/cause/properties relationships. It excludes error messages, stacks, headers (including native `Headers`), prompts, request/model metadata, URLs, arbitrary property names/values, and binary data. Unknown event types are dropped; the event type and code location are fixed at the reporter boundary. Encryption remains a transport layer, not redaction. Authenticated transport still uses the signed-in account token and user ID.

The separate TUI incident reporter uses schema 2. It retains a fixed event category, phase/severity/impact, handled flag, generated IDs, timestamps, numeric release/Node versions, known platform/architecture, known error names/codes and HTTP status, and up to 20 fixed breadcrumb names with an optional phase. It excludes free-form error text, stack/cause/aggregate contents, caller context, component/operation labels, terminal/OS strings, and original code locations. Fingerprints are derived only from the minimized category and error facts, so grouping is intentionally coarser. Legacy schema-1 pending and sent files are deleted best-effort at startup and never uploaded; current-schema pending files are projected again before encryption and replaced with their minimized copy before being marked sent. The gateway wire encryption format is unchanged. Production ingestion of schema 2 has not been tested.

Feedback review describes the actual upload: user-reviewed feedback text, bounded client/platform and optional session metadata, and diagnostic **counts**, not original session files. Recognized credentials are redacted from the reviewed description; arbitrary personal text in that description is still sent, so review it before submitting.

Every collected diagnostic artifact, including prioritized session artifacts, is projected through `diagnostic-counts-v1`. The ZIP contains counts of known roles, states, error types/codes, log levels and HTTP statuses, plus parsing/omission indicators. JSON/JSONL can contribute these facts; malformed data, binary attachments and free-text logs contribute no raw content. Source filenames and paths are replaced with opaque archive names; only a small fixed list of artifact kinds (such as `messages.jsonl`) is retained. Unrelated session manifests are not collected. Local source files are unchanged.

There is no raw-attachment upload option in this flow. Prompts, conversation text, tool arguments/results, command output, workspace excerpts, raw errors and unknown fields are excluded even if they contain no recognizable credential pattern. This intentionally reduces diagnostic detail: reproducing an exact response or inspecting an original stack is not possible from these uploads. Future raw attachments would require a separate, explicit review and consent surface describing their contents and scope.

The regression tests use temporary synthetic files and intercepted HTTP only. They decrypt the final automatic-report request as a receiver would, and unzip the actual feedback PUT body after real session-report collection. They do not validate production ingestion of the new schemas, retention policies, live services, other telemetry paths or other platforms.
## Interactive startup model
Use `mcode -m <provider-id>/<model-id>` or
`mcode "Fix the failing tests" --model <provider-id>/<model-id>` to select the
model for the startup Session. References use the same syntax as `exec --model`,
including `custom_provider:<id>/<model-id>`, model IDs containing `/`, and the
optional `#variant` suffix. The provider must already be configured and the model
must be available to Runtime; invalid references fail before the initial prompt runs.

Without a resume option, this creates a new Session even when no prompt is given.
With `--session <id>` or `--continue`, it updates the opened Session's model before
submitting the prompt. The selection is saved with that Session, so later turns
and resumes keep it. It does not change the global default, and `/new` returns to
the configured default. Omitting `--model` preserves existing startup behavior.
The untargeted `--session` picker cannot be combined with `--model`; provide an ID
or use `--continue` instead. If opening or continuing a Session fails, the override
and initial prompt are not applied.
## Feature panels and chat restoration
In regular mode, independent feature panels occupy the complete visible terminal
area, including short Rewind previews and scope pickers. Closing a panel restores
the current conversation. Closing, replacing or shrinking a transient region
restores the exposed chat rows. This includes inline selectors such as `/theme`,
completion menus, multi-line drafts, image previews, queued messages, task and
Goal summaries, welcome notices and status rows. Short documents refresh in place;
history is reconstructed only when the smaller layout needs to bring scrolled
rows back into view. This rule follows the rendered layout, including asynchronous
updates, rather than requiring each close handler to request a special redraw.
When background running content shrinks entirely within the current screen and
the transient layout stays unchanged, the renderer keeps native scrollback and
the Composer position stable.
Freed rows temporarily remain blank at the top of the active screen and subsequent
output reuses them. This avoids resetting the host's scroll position when a turn
finishes. Redundant resize notifications with unchanged dimensions do not rebuild
history. Viewport-only redraws erase rows in place so terminals that save a cleared
screen to scrollback, including Apple Terminal, do not retain the old Composer,
status line or duplicate transcript rows.

When a change removes or replaces text already in scrollback, the renderer still
reconstructs the current session to avoid stale or duplicate history. Real resizes
and image layout changes also retain the existing reconstruction behavior. A
reconstruction clears earlier shell scrollback and can reset the host's scroll
position; ordinary updates keep native scrolling and selection behavior.

Rewind and Fork history-loading hints disappear as soon as their lists are ready.
Returning from a cancelled operation must not leave a stale loading message in the
Composer. Rewind displays its completed result after a successful operation.
## Temporary side conversations
Use `/btw [question]` (or `/side [question]`) to open a temporary side conversation
while the main task continues. The side conversation inherits the latest complete
prefix of persisted history. Completed tool calls retain all their results; an
unfinished group of tool calls is excluded together. The selected boundary is
fixed before creation, so later main-task output does not change that fork.
Inherited tool calls are context and are not executed again.

Press `Ctrl+/` to switch between the main and side views, or `/parent` to return
to the main view. Press `Ctrl+C` on an empty Composer to discard the side
conversation. Side conversations retain the main session's permission mode and
remain hidden from `/sessions` and `/resume`.

Creation and activation failures record a bounded, redacted cause chain in the
local `session.side.failed` diagnostic event. Feedback uploads still apply the
existing diagnostic-counts projection; raw error text, stacks and session IDs
are not added to the uploaded ZIP. Offline tests cover persisted tool histories,
archives, concurrent parent output, side-session cleanup and local diagnostics;
this does not establish native-terminal or live-model acceptance.
## Open Session tabs
Every Session that has been opened in this run stays in a tab bar above the
Composer. A tab shows its slot, its title and one live status: `working` for a
turn on that Session, `waiting` while it holds a permission or question request
— a waiting tab is highlighted in the bar so it stands out — and `unread` when
a turn settled while the tab was in the background. The bar
appears from the second tab on and stays visible while a panel is open, so a
Session waiting for an answer can always be reached from the bar.

Switch tabs with `Ctrl+Shift+Left` / `Ctrl+Shift+Right`, or jump straight to a
slot with `Alt+1`…`Alt+9`. `Alt+N` opens a new tab, `Alt+W` closes the visible tab and shows its
neighbour; closing the last tab starts a new Session. `Alt+R` renames the visible
tab, `Alt+G` turns project grouping on or off and `Alt+H` folds every other
project group or unfolds them all again. The equivalent commands are `/tabs next`,
`/tabs prev`, `/tabs close`, `/tabs rename [title]`, `/tabs group [on|off]`,
`/tabs collapse` and `/tabs 1-9`. `/hotkeys` lists the effective bindings, and
`tui/keybindings.json` can remap any of them.

The bar keeps insertion order — a new tab goes to the end — and moves only when you
ask: `Shift+Alt+Left` / `Shift+Alt+Right` (or `/tabs move left`) push the visible tab
one slot along the bar. Because the direct slots are positional, this is how a Session
is put on the `Alt+<n>` key you expect. A move is clamped at either end rather than
wrapped, and it is not a switch: the Session on screen stays, and a running turn is
untouched. The order lives in the running TUI and is not persisted, so a restart
reopens tabs in insertion order.

A new tab is created with `Alt+N`, by `/new`, or by choosing "new" in `/sessions`: the Session is
created there and then, in the workspace of the Session you were on, so the tab appears
before you type anything — a fresh Session with an empty Composer is what a new tab is.
It is navigation rather than a clear, so it works while a turn is running: the Session
you leave keeps its tab, keeps its pane and keeps streaming its turn into it. Text typed
while no Session was on screen (after archiving one, for instance) follows into the
Session the new tab opens.

`/clear` starts the fresh conversation in the tab that is already there instead of
adding one: the bar keeps its length and the new Session takes the replaced tab's
position, and with it its direct `Alt+<n>` slot. The Session it replaces keeps its
history and stays resumable from `/sessions` — nothing is closed, archived or deleted;
only its pane goes, with the tab it lost. Because that would leave a running turn with
no tab to return to, `/clear` is refused while the visible Session's turn runs, the same
way closing its tab is. Closing the last tab is the third way to get a fresh
conversation: it returns to an empty view and the next prompt creates the Session.

Because a tab is always a real Session, `/new` and `/clear` show an empty conversation
rather than the Welcome screen: Welcome is what a start with nothing opened shows, and
with it the startup update notice.

`/pin` (or `/pin on`) pins the visible Session and `/pin off` unpins it. A pin is a
runtime-level, ordered list rather than a field on the Session, so it survives restarts
and is shared with any other client: pinned Sessions lead the `/sessions` list and the
session manager, in the runtime's pin order, and the rest follow by recency. The tab
bar is not re-sorted by pins — it keeps the order you set with `/tabs move` — but a
pinned tab is marked with a `*` before its label, and a folded project group carrying a
pinned Session shows one on its header. A pin does not switch, resume or archive
anything. `session.pinned_updated` refreshes the catalogue when the pin was written
elsewhere.

Renaming a tab renames its Session: the tab label is the Session title, so
`/tabs rename`, `/rename` and the inline rename in `/sessions` all write the same
field and the bar follows on the next frame. There is no separate tab-only label,
and a rename is refused while a turn is running.

When the open tabs span more than one project — the Session's workspace
directory, labelled by its folder name — the bar groups them: one header row per
project showing its tab count and combined status, then one row of tabs per
expanded project. Grouping switches itself off when every open tab belongs to the
same project. The grouped bar is capped at five rows; groups past the cap are
replaced by a `+N` counter, never the group holding the visible tab. Folding only
changes what the bar draws: it hides the *other* projects and leaves the visible
tab's own group open, while cycling and the direct slots still reach every open
tab.

Closing a tab only closes the tab: the Session keeps its history and reappears in
the bar the next time it is opened from `/sessions`. The visible Session is always
an open tab, so a tab cannot be closed without showing another one first.

Switching tabs does not stop work. A Session whose turn is running keeps running
in the Runtime when you switch away: the TUI stops watching its stream and lets the
run continue, the bar keeps showing that Session as running from the Runtime
events, and the tab turns to `unread` when the turn settles. Switching back
re-adopts the Session's own pane instead of rebuilding it: the cells it already
showed are still there, including the streaming tail of a turn that is still
running, and its saved messages are reconciled into them.

The TUI keeps a pane per Session on the bar — the visible one plus the most recently
opened others — and drops a Session's pane when its tab closes, or when the Session
is archived or deleted, so a Session that comes back is projected from its saved
messages again. A turn you started keeps streaming into its own tab after you switch
away: the TUI goes on watching that Session's turn and projects it into that
Session's pane, and the pane shows the output when you come back. A turn that starts
in a Session you are not looking at is watched too, as soon as that Session has a tab
on the bar — a drained queue item, a delegation or an automation streams into its tab
rather than waiting to be saved. Two limits are worth knowing: a Session whose tab was
never opened has no pane to stream into, so its output appears when you open it; and a
background turn does not update usage, cost or the todo panel, which describe the
Session on screen. If a background stream is lost, its pane is dropped rather than
patched, so its next visit reloads saved messages. A permission or questionnaire
prompt raised by a background Session is recorded against that Session and shows when
you switch to its tab.

Some commands still require a stopped Session, because they end or rebind its
context: `/rename`, `/parent`, and archiving or deleting a Session from
`/sessions`. `/new` does not: opening a Session in a new tab leaves the one on
screen, and its turn, alone. Closing the tab of a running Session is refused, so a
live Session is never left without a tab to return to. Offline tests cover the tab
reducer, the bar rendering at narrow widths, the key bindings, the switch/close
ordering and the allowances above; a Session that keeps streaming into its own pane
while you are elsewhere is implemented, and the limits of that pane are stated in the
tabs section above.
## Copying a Session
`/clone` copies the visible Session into a new Session that holds the same
conversation, then opens the copy as another tab. The copy starts from the latest
complete reply: it is a `/fork` with the boundary chosen for you, so no prompt
picker appears. The confirmation card names the suggested title and states what
the copy includes.

The source Session and its files are untouched — the runtime writes a new
Session, copies the display history, assets, plan and permission rules, and
leaves the original in place with its own tab. Like `/fork`, the command needs a
settled turn: during a run it keeps the draft and asks you to stop the turn
first, and it is refused while a permission or question request is waiting. The
runtime's suggested title names the copy, so repeated copies of one Session stay
distinguishable in `/sessions`. Offline tests cover the request the command
sends, the confirmation card in both modes, the running-turn guard and the
unavailable reason; whether the clone keeps MCP connections and queued messages
is not covered.
## Grouping the Session list by project
`Ctrl+G` in `/sessions` swaps the recency headers (Today, Yesterday, …) for one
header per project, ordered by their newest Session, so a project's Sessions stay
together. `Ctrl+O` folds every other project or unfolds them all again.

Folding never makes a Session unreachable: the project holding the selected
Session always stays open, and a folded header counts what it hides
(`▸ other-workspace (2 folded)`). Moving the selection into a folded project
opens it again. Both keys are ignored while a query is active, where the list is
flat and matched by search instead.

Grouping is a view state of the open panel: it is not persisted, and it does not
change the Session order outside the panel.
## Finding a Session by what was said in it
`/sessions <query>` matches a Session's title, ID, workspace, Agent, model, status
and branch without reading any history. When a query matches none of those, the
manager searches the saved user prompts of the Sessions it has loaded and lists
the Sessions whose prompts contain every token, marked `prompt match` with the
matching prompt quoted in the detail block.

This is not a full-text index. The TUI reads the persisted user-prompts list of
each candidate Session — head-truncated to 200 characters by the runtime — so
Assistant replies, tool output and file contents are not searched, and a match
beyond the first 50 prompts of a Session is invisible. One query reads at most 50
Sessions, eight at a time, chosen from the current view (active or archived) and
workspace scope, so widen the scope with `Ctrl+A` before searching across
everything. A Session whose history cannot be read is skipped rather than failing
the search, and a search that matched nothing says so.

The prompt search only starts when a title match would leave the list empty, so a
query that names a Session never pays for it.
## Deleting a Session
`/sessions` can remove a Session for good: select the row, press `Ctrl+X` and
confirm. The confirmation opens on **Archive instead**, because the delete has no
undo — the runtime removes the Session's rows and its canonical history files on
disk and re-parents any child Sessions. Archiving keeps the history under the
Archived view, so the safe choice is the one Enter takes by default.

Move between the two rows with the arrow keys. Choosing *Delete permanently*
removes the row and reports that the history files are gone; `Esc` leaves the
Session untouched. Deleting the Session you are looking at is allowed: the shell
resets to a fresh Session, exactly as it does after archiving the visible one. A
running turn blocks the delete.

Offline tests cover the confirmation's default choice, the permanent path calling
the runtime, the cancel path, the footer hint, the controller's removal of the row
(including the visible Session) and the running-turn refusal. There is no trash
and no retention window: nothing here can bring a deleted Session back.
## Select a plugin for a message
Type `@` in the Composer to search files and installed, enabled plugins. Plugin
candidates show their source so packages with the same display name can be
selected independently. Choose a plugin with Tab or Enter, then describe the task.
The Composer shows `@Name` and retains the plugin identity through editing, undo,
prompt history, queued-message recovery, saved drafts, and `/edit` after a
message is sent. Ctrl+C clearing/restoration and external-editor edits retain
unchanged plugin bindings. If external edits make duplicate labels ambiguous,
reselect those plugins in the Composer. Displayed messages remain readable; Runtime retains
the original input separately when needed to recover the plugin identity for editing.

Selection applies to that message. Runtime checks the plugin's effective Skills,
MCP tools, and App tools again for the turn and asks the Agent to prefer relevant
capabilities. Selecting a plugin does not install or enable it. An unavailable
selection is reported to the Agent rather than redirected to a same-named package.

Exec and ACP text prompts can use the durable linked form, for example
`[@Notes](plugin://notes%40local) summarize these files`. The ID is the package
name plus its `local` or `official` source; display labels do not determine the
selection. Legacy whitespace-delimited `@package-name` text remains supported
when it identifies exactly one effective plugin.