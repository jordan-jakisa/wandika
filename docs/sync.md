# How Wandika syncs

Every vault has a real git repository on the device. libgit2 is built into the app on Mac, iPhone and Android. The repository lives in Wandika's own storage (`vaults/<id>/git`), so a vault folder, such as an Obsidian vault in iCloud, gets no `.git` folder from us. GitHub is the meeting point: every device pushes to and pulls from one branch.

Code: `src-tauri/src/sync.rs`. Tests there run several devices against a local repository: merges, clashes, deletions, held deletions, iCloud placeholders and big uploads.

## One sync

1. **Commit what changed here.**
   - Left out:
     - anything in the vault's `.gitignore`;
     - per-device files: `.obsidian/workspace*.json`, `.DS_Store`, temporary files;
     - iCloud placeholders (`.Name.icloud`).
   - **Files over 50 MB** stay on the device they were added on. GitHub warns at 50 MB and refuses 100 MB.
   - **An iCloud placeholder** means the file still exists, unchanged; it is not a deletion.
   - **Mass deletions are held.** If a sync would delete more than 25 files, and more than a fifth of the vault, nothing is deleted. Wandika asks: bring them back, or delete them everywhere. A moved or emptied folder must never empty the vault on every device.
2. **Fetch GitHub's branch.** When nothing changed, this is one small exchange; otherwise only new objects are downloaded.
3. **Merge.**
   - Only GitHub moved: fast-forward.
   - Both moved: a three-way merge.
     - Edits to different lines in the same note combine.
     - Where the same lines changed, or a file can't merge (images, encrypted notes), this device's version stays. The other version is saved beside it as `Name (conflict 2026-11-03 0930).md`.
     - An edit beats a deletion, whichever side made it.
   - Connecting a vault to a repository that already has files merges the two histories by the same rules.
   - Files you change during a sync are not overwritten; the next sync takes them in.
4. **Push**, fast-forward only.
   - A change over 100 MB goes up as a chain of commits, each under 100 MB: deletions first, then the smallest files. There are 10 seconds between parts.
   - If GitHub moved meanwhile, fetch, merge and push again (up to 4 rounds).

Stop works at any point: nothing changes on GitHub until a push succeeds.

## When it runs

- 20 seconds after you stop typing.
- Every 3 minutes while the app is open and in front.
- When the app comes back to the front, and when it starts.
- When you ask: the status line, pull down on the phone list, ⌘S, or Settings.

After a failure, automatic syncs wait longer each time: 3, 6, 12, 24, then 48 minutes. A sync you start yourself always runs.

## Staying within GitHub's rules

| GitHub's rule | Wandika |
|---|---|
| REST API: 5,000 requests an hour; content-creating requests at most 80 a minute and 500 an hour; keep making requests while limited and the integration can be banned | Files travel over git, not the REST API. The API is used only to sign in, list repositories and create one; those writes are paced under 70 a minute and 450 an hour. After a limit answer, nothing is sent until GitHub's `retry-after` or reset time, and never sooner than a minute. |
| Pushes: recommended at most 6 a minute per repository; 2 GB per push | At most one push per sync. A big upload's parts go 10 seconds apart, each under 100 MB. |
| Files: warning at 50 MB, blocked at 100 MB | Files over 50 MB stay local, and the sync says which. |
| Repositories: ideally under 1 GB, strongly recommended under 5 GB | Settings shows the synced size, and suggests `.gitignore` for big folders past 1 GB. |
| Git reads: recommended at most 15 a second per repository | At most one fetch per sync, at the times above. |

Sources (read 2026-11-03):
- [REST API rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- [Repository limits](https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits)
- [About large files](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github)
- [Acceptable use policies](https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies)

## Sign-in

Git uses the same GitHub token as the rest of the app (device-flow OAuth, `repo` scope), over HTTPS. The token stays in the system keychain.
