# Tmux Split And Directory Path Fix Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add top-bar tmux split controls and fix incorrect `/root/...` directory defaults so all terminal-launch flows resolve the correct per-machine user path.

**Architecture:** Extend the existing browser -> relay -> machine WebSocket protocol with focused tmux pane actions and shared directory-default metadata. Keep tmux as the execution primitive on the machine side, and centralize directory fallback logic so FileBrowser, new terminals, resume flows, and pane splits all derive paths from the same machine-reported home/project context.

**Tech Stack:** React 19 frontend, Node.js relay/server, machine-side WebSocket client, tmux, node-pty, Node test runner, Vite, ESLint.

---

## Chunk 1: Parallel Worktree Setup

### Task 1: Create isolated worktrees from the current baseline

**Files:**
- Modify: `.gitignore` only if `.worktrees/` must be ignored first
- Create: `.worktrees/tmux-split-feature/`
- Create: `.worktrees/directory-path-fix/`
- Create: `.worktrees/integration-review/`

- [ ] **Step 1: Verify worktree directory choice**
Run: `ls -d .worktrees worktrees 2>/dev/null`
Expected: Use `.worktrees/` if present; otherwise create it.

- [ ] **Step 2: Verify `.worktrees/` is ignored**
Run: `git check-ignore -q .worktrees`
Expected: exit code `0`.

- [ ] **Step 3: Capture current local baseline patch for relevant files**
Run: `git diff -- packages/server/frontend/src/Dashboard.jsx packages/server/frontend/src/TerminalPanel.jsx packages/server/frontend/src/SessionTabs.jsx packages/server/relay.js lib/pty-manager.js lib/ws-client.js > /tmp/tmux-dir-baseline.patch`
Expected: Patch file contains current uncommitted baseline adjustments so worker worktrees do not regress local in-progress changes.

- [ ] **Step 4: Create feature worktrees**
Run:
`git worktree add .worktrees/tmux-split-feature -b feat/tmux-split-controls`
`git worktree add .worktrees/directory-path-fix -b fix/directory-path-resolution`
`git worktree add .worktrees/integration-review -b chore/tmux-dir-integration`
Expected: Three isolated worktrees exist.

- [ ] **Step 5: Apply the captured baseline patch in each worktree**
Run: `git apply /tmp/tmux-dir-baseline.patch`
Expected: Each worktree starts from the same effective file content as the current workspace for overlapping files.

- [ ] **Step 6: Install dependencies where needed**
Run:
`npm install`
`cd packages/server/frontend && npm install`
Expected: Node dependencies available in each worker worktree.

- [ ] **Step 7: Run clean baseline verification**
Run:
`npm test`
`cd packages/server && npm test`
`cd packages/server/frontend && npm run build`
Expected: If any baseline command fails, stop and surface before implementation.

## Chunk 2: Tmux Split Feature

### Task 2: Add browser-visible split controls and protocol messages

**Files:**
- Modify: `packages/server/frontend/src/Dashboard.jsx`
- Modify: `packages/server/frontend/src/TerminalPanel.jsx`
- Modify: `packages/server/relay.js`
- Test: `packages/server/tests/relay.test.js`

- [ ] **Step 1: Write a failing relay test for split forwarding**
Add a test proving a browser `split_terminal` message is forwarded to the target machine with direction, sessionId, cwd, and command/default-shell metadata.

- [ ] **Step 2: Run the relay test and confirm it fails for the missing message type**
Run: `cd packages/server && node --test tests/relay.test.js`
Expected: FAIL because relay does not yet handle split requests.

- [ ] **Step 3: Implement minimal relay support**
Add a new browser message branch that forwards `pty_split` to the machine WebSocket, reusing existing machine lookup and error-safe patterns.

- [ ] **Step 4: Re-run the relay test**
Run: `cd packages/server && node --test tests/relay.test.js`
Expected: PASS.

- [ ] **Step 5: Add a failing frontend-facing behavior test or equivalent focused assertion**
If no frontend test harness exists, add a minimal Node-level assertion around the split action helper or keep coverage at relay level and verify UI behavior manually later. Do not skip evidence of the new direction mapping.

- [ ] **Step 6: Implement top-bar split controls in `Dashboard.jsx`**
Add four controls in the existing top action area for `up`, `down`, `left`, `right`. The action should resolve the active terminal context and send `split_terminal` with current machine, session, cwd, and shell/command context.

- [ ] **Step 7: Add frontend guardrails**
Disable or no-op split controls when there is no active terminal context; surface alert/error feedback when required context is missing.

- [ ] **Step 8: Add minimal terminal-side refresh behavior if needed**
If a split should cause the active terminal or session lists to refresh, reuse existing scan/refresh messages instead of inventing a second state channel.

- [ ] **Step 9: Verify the targeted commands**
Run:
`cd packages/server && npm test`
`cd packages/server/frontend && npm run build`
Expected: PASS.

### Task 3: Implement machine-side tmux split execution

**Files:**
- Modify: `lib/ws-client.js`
- Modify: `lib/pty-manager.js`
- Test: `tests/*.test.js` if an existing root-level PTY/unit test file is appropriate, otherwise add a focused new test file under `tests/`

- [ ] **Step 1: Write a failing machine-side test for split behavior**
Cover the command assembled for tmux split execution: direction maps to the expected tmux flags, target cwd is honored, and the shell command defaults correctly.

- [ ] **Step 2: Run the machine-side test and confirm RED**
Run: `node --test tests/*.test.js`
Expected: FAIL because split support does not exist yet.

- [ ] **Step 3: Implement tmux split helper in `pty-manager.js`**
Add a helper that uses tmux native split-window flags for up/down/left/right, sets the pane start directory with `-c`, and runs the target shell/command in that pane.

- [ ] **Step 4: Handle `pty_split` in `ws-client.js`**
Wire the new relay message to the helper, using the machine’s default shell when no explicit command is provided.

- [ ] **Step 5: Re-run the machine-side tests**
Run: `node --test tests/*.test.js`
Expected: PASS.

- [ ] **Step 6: Self-review for tmux safety**
Confirm the helper does not kill sessions, does not mutate existing pane contents, and only targets the intended session/window.

## Chunk 3: Directory Path Resolution Fix

### Task 4: Diagnose and centralize default directory resolution

**Files:**
- Modify: `lib/ws-client.js`
- Modify: `packages/server/relay.js`
- Modify: `packages/server/frontend/src/FileBrowser.jsx`
- Modify: `packages/server/frontend/src/Dashboard.jsx`
- Test: `tests/*.test.js`
- Test: `packages/server/tests/relay.test.js`

- [ ] **Step 1: Write a failing test for machine directory defaults**
Cover a helper that resolves the effective default directory/home per machine and distinguishes root (`/root`) from non-root users (`/home/<user>` or actual home path).

- [ ] **Step 2: Run the targeted test and confirm RED**
Run: `node --test tests/*.test.js`
Expected: FAIL because there is no shared resolver yet.

- [ ] **Step 3: Add machine metadata reporting in `ws-client.js`**
Expose machine-side user/home/default-project information derived from actual runtime environment (`os.homedir()`, `process.env.USER` or equivalent, current project context if available).

- [ ] **Step 4: Forward the metadata through relay**
Include the machine directory metadata in the browser-visible machine/session state without breaking existing consumers.

- [ ] **Step 5: Refactor FileBrowser defaults to use machine-reported values**
Initialize `manualPath`, `treeRoot`, and `treeRootInput` from the selected machine’s resolved default directory instead of only recent history or empty string.

- [ ] **Step 6: Reuse the resolver for terminal launch paths**
Ensure `launchInDir`, split actions, and any fallback `cwd` logic use the same resolver and never hardcode `/root` or `/home/<fixed-user>`.

- [ ] **Step 7: Add root/non-root coverage**
Keep at least two cases in automated tests: one where the actual home is `/root`, another where the actual home is a non-root directory.

- [ ] **Step 8: Re-run targeted verification**
Run:
`node --test tests/*.test.js`
`cd packages/server && npm test`
Expected: PASS.

## Chunk 4: Integration, Review, Merge, Deploy

### Task 5: Review and integrate both branches

**Files:**
- Modify: integrated merge result in `.worktrees/integration-review`

- [ ] **Step 1: Request spec-compliance review for the split branch**
Reviewer context: PRD requirements for top-bar split buttons, tmux native split behavior, shell/cwd handling.

- [ ] **Step 2: Request code-quality review for the split branch**
Focus: tmux command safety, message-shape consistency, React state handling.

- [ ] **Step 3: Request spec-compliance review for the directory-fix branch**
Focus: real home-directory resolution, root vs non-root handling, shared fallback logic.

- [ ] **Step 4: Request code-quality review for the directory-fix branch**
Focus: avoiding duplicated resolver logic, state initialization drift, machine-switch correctness.

- [ ] **Step 5: Merge both reviewed branches into the integration worktree branch**
Run:
`git merge feat/tmux-split-controls`
`git merge fix/directory-path-resolution`
Expected: Integration branch contains both features; resolve conflicts without dropping baseline local changes.

- [ ] **Step 6: Run full verification on the integrated branch**
Run:
`npm test`
`cd packages/server && npm test`
`cd packages/server/frontend && npm run build`
Expected: PASS before any completion claim.

- [ ] **Step 7: Run final code review subagent on the integrated diff**
Reviewer context: merged branch diff plus PRD.

### Task 6: Redeploy the service from the integrated branch

**Files:**
- Modify: deployment side effects only

- [ ] **Step 1: Confirm deployment command from repo conventions**
Run: `node bin/cli.js --server status`
Expected: Observe current local service status.

- [ ] **Step 2: Rebuild frontend assets on the integration branch**
Run: `cd packages/server/frontend && npm run build`
Expected: PASS.

- [ ] **Step 3: Restart or redeploy using the existing CLI path**
Preferred local command:
`node bin/cli.js --server stop`
`node bin/cli.js --server start`
If systemd deployment is required and permissions are available:
`sudo node bin/cli.js --deploy dashboard`

- [ ] **Step 4: Verify deployed status**
Run:
`node bin/cli.js --server status`
If systemd is used: `systemctl status claude-dashboard --no-pager`
Expected: Service/process is running with the new build.
