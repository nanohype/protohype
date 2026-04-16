# Chorus Eval Harness — Labeled Set Schema

This file defines the schema for the labeled evaluation set that will be used
once the matching-accuracy harness is implemented (not shipped in v0.1.0).

## File Format: JSONL at `evals/labeled-set.jsonl`

```json
{"id": "item-001", "feedback_text": "...", "correct_entry_id": "pb-feature-123", "source": "zendesk"}
{"id": "item-002", "feedback_text": "...", "correct_entry_id": null, "source": "delighted"}
```

`correct_entry_id=null` means the item should propose a NEW entry.

## Target Composition (500 items)
- 40% Zendesk, 30% Delighted, 20% Gong (v2), 10% edge cases
- 70% should LINK, 30% should propose NEW
- 10% adversarial (similar-sounding but different pain point)
