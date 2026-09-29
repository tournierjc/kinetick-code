# Turn a prompt into something that works

[![Pocket Pet browser demo](assets/pocket-pet-demo.png)](assets/pocket-pet-demo.mp4)

[Watch or download the 36-second video](assets/pocket-pet-demo.mp4) · [Build it yourself](../examples/pocket-pet) · [View the finished source](../examples/pocket-pet/finished)

## A new feature, then a new requirement

The starter is a small, predesigned browser pet that blinks and says hello. The first request asks the agent to add a Pomodoro timer. The follow-up changes pause to an 800 ms hold and adds a completion celebration. The finished example runs locally without hardware or frontend dependencies.

The video pairs actual browser recordings with clearly labeled prompt excerpts, generated source, and excerpts of real headless output. The interface shown in the final demonstration includes subsequent maintainer design work. It is an edited demonstration, not a recording of the interactive TUI. See the [full prompts](../examples/pocket-pet) and try the same changes in your own copy.

The source in this repository names **Kinetick Code**. The video and still are the upstream recording and can still show **MiniMax Code** in the page chrome. That caption is the recording, not the identity of this fork.

## Recording and verification

- Recorded upstream on September 28–29, 2026 (Asia/Shanghai), using installed MiniMax Code **0.5.8** with an existing **BYOK** configuration. This is a CLI workflow demonstration, not a model evaluation. Kinetick Code keeps its own version (**0.6.7**).
- The two real agent turns took approximately **102 seconds** and **154 seconds**. Model waiting time is omitted from the 36-second edit; it is not a speed benchmark. Browser footage plays at its captured speed.
- The first run added the timer and passed 6 tests. The follow-up added hold-to-pause and the celebration and passed all 13 tests. Both runs explicitly said browser behavior was unverified; the maintainer then checked it in Chrome.
- Browser checks cover start, short-click behavior, pointer hold/pause/resume, keyboard hold/repeat/release/resume, the default 25-minute setting, canceled holds, completion, reduced-motion behavior, and a 390 px viewport without horizontal overflow.
- `?demo=1` visibly labels a **10-second demonstration**. No 25-minute wait or physical hardware operation is implied. State is in memory and a page reload resets it.
- The visual starter was authored before the agent runs. The reference implementation retains the generated timer and hold logic. Subsequent maintainer work redesigned the HTML/CSS, added session-progress and short-tap feedback, made the mode links visible, avoided repeated live-region text writes, and canceled pending holds when the button loses focus. This visual polish was not produced by the two recorded CLI turns. The video does not claim generation from an empty project.
- Only synthetic project content appears. Private run logs, account state, provider aliases, local paths and session identifiers are excluded. Captions and layout are editorial; the cursor highlight follows actual pointer events. Browser footage is cropped for readability and its interaction segment plays continuously at 1×. No tool results were invented.
- Video assembly uses HyperFrames with locally staged browser footage. The video is silent so it works in muted README and social contexts. The revised cut uses a warm page and a cobalt device, with larger interaction shots and visible action labels.

To edit the starter, install Kinetick Code and configure `kcode` with your own model, or with a MiniMax account that has available credits. Calls may incur charges. Running the finished example requires only Node.js and a browser.

## Code repair exercise

[`examples/clamp`](../examples/clamp) is the small failing-test exercise. Copy it out of the repository before asking Kinetick Code to fix it. The README screenshot is a Kinetick Code session. Older terminal recordings stay in `docs/assets` as historical captures.
