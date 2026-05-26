# bk1 kimball skill assets

Only one file ships here: `kimball.db`, a SQLite + FTS5 index of the *Data Warehouse
Toolkit* (3rd ed.) chapter summaries. `/kimball` reads it via the `kimball_query` tool;
nothing else in bk1 touches it.

## What got removed (and how to bring it back)

This directory used to also contain `knowledge_base/` with ~42 markdown summary files
(the source of truth from which the DB was built). The markdown was removed because:

- bk1 never reads it at runtime — the DB has all the content.
- It's content from a published book; we don't edit it in normal use.
- 1.6MB of dead weight in the repo + cluttered source-control views.

If you ever need to regenerate `kimball.db` from scratch:

1. Copy the markdown back into place:
   ```
   cp -r ~/.claude/skills/kimball/knowledge_base ./skills_data/kimball/
   ```
   (The original lives in the upstream Claude Code kimball skill.)
2. Run `bun run build:kimball`.
3. Commit the new `kimball.db`. You can `rm -rf ./skills_data/kimball/knowledge_base/`
   again afterwards.

## Editing content without regenerating from markdown

For one-off edits (rare), open `kimball.db` with any SQLite client and update the
`sections` or `concepts` table directly. Remember to also update `sections_fts` /
`concepts_fts` — or just rebuild them with:

```sql
INSERT INTO sections_fts(sections_fts) VALUES('rebuild');
INSERT INTO concepts_fts(concepts_fts) VALUES('rebuild');
```
