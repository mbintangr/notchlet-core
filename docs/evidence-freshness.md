# Evidence freshness semantics

Verification evidence records when a check passed and which source it observed. Freshness answers one
question: **does this record still describe the code the check verified?**

## Fingerprint versions

| Version | Used for | Freshness rule |
| --- | --- | --- |
| 1 | Legacy records without `verificationFingerprint` | Change-artifact hash and content revision must match. |
| 2 | Legacy Git and non-Git records | Change-artifact content plus a whole-worktree Git digest (tracked and untracked). A truncated observation (for example a tracked file above the 2 MiB read limit) is `unknown`. |
| 3 | New records recorded inside a Git repository | Change-artifact content plus verified-path binding, described below. |

Version 2 records stay readable: the parser accepts versions 2 and 3, and version 2 keeps its previous
evaluation rules. Nothing is migrated in place.

## Verified-path binding (version 3)

At record time the evidence stores the commit (`git.repository.head`) and the filtered list of tracked
source paths observed (`git.trackedPaths`). Untracked files and excluded paths (dependencies, build
output, `.env`, credentials, `.notchlet` state) are not verified paths.

Freshness compares the recorded commit to the current worktree with a path-level Git diff and
intersects the changed paths with the recorded list:

- **Fresh** — no verified path changed. This holds after a fast-forward merge and after a merge
  commit, because unrelated files that arrived through the merge are not verified paths. Arbitrary
  later commits that add new files also stay fresh.
- **Stale** — a verified path was edited, deleted, or replaced, including uncommitted edits. The
  reasons name the affected paths (up to three, then a count).
- **Unknown** — the recorded commit or path list is unavailable (legacy record, rewritten history, or
  evidence recorded outside a repository being evaluated inside one).

`change close --preview` reports the aggregated status per declared check (`current`, `stale`,
`unknown`, `failed`, `missing`) and requires current, source-bound evidence for every required check.

## Oversized files

Version 3 does not hash file contents for freshness, so a tracked file above the 2 MiB fingerprint
read limit no longer forces `unknown`. The digest fields remain for version 2 evaluation and for the
resume summaries.
