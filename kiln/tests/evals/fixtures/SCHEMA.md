# Corpus schema

Each eval case is two files:

```
<pkg>-<fromVersion>-<toVersion>.md          changelog body
<pkg>-<fromVersion>-<toVersion>.expected.json  ground truth
```

The filename is split on dashes from the right: the last two segments are `fromVersion` and `toVersion`; everything before is `pkg`. So `zod-3.22.0-4.0.0.md` parses to `pkg=zod from=3.22.0 to=4.0.0`.

**Don't use scoped package names directly** (e.g., `@aws-sdk/client-s3`). Substitute the scope: `aws-sdk-client-s3-3.0.0-3.1.0.md` and document the real package in the changelog body.

`.expected.json` shape:

```json
{
  "ids": ["remove-legacy-fn", "rename-foo-to-bar"],
  "notes": "optional free-text explaining the ground-truth labels"
}
```

`ids` are the expected breaking-change slugs. The classifier gets graded on F1 against this set. Slug choice is somewhat fuzzy — prefer semantic names (`remove-`, `rename-`, `behavior-change-`) over model-specific spellings.
