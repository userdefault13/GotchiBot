# Examples — aarcadeghst-changes

## Example entry (surveys + bounce gate)

```json
{
  "id": "agc-20260830-081800",
  "status": "pending",
  "areas": ["surveys", "bounce-gate", "installations-drawers"],
  "summary": "Surveys tab shows per-round alchemica; Bounce Gate group defaults open with item 145 thumb.",
  "files": [
    "src/components/MyLand/ParcelRealmPanel.vue",
    "src/composables/useParcelRealmDetail.ts",
    "src/helpers/installationThumbs.ts"
  ],
  "authorHero": "owned-954",
  "consumerHero": "owned-22899",
  "createdAt": "2026-08-30T08:18:00.000Z",
  "updatedAt": "2026-08-30T08:18:00.000Z",
  "planRef": "docs/CPARCEL_REVOKE.md",
  "notes": ""
}
```

## Example: left column cycle UX

```json
{
  "id": "agc-20260830-090000",
  "status": "pending",
  "areas": ["left-column"],
  "summary": "Prev/next parcel cycle buttons wrap gallery order; disabled when only one parcel.",
  "files": ["src/views/MyLand.vue"],
  "authorHero": "owned-954",
  "consumerHero": "owned-22899",
  "createdAt": "2026-08-30T09:00:00.000Z",
  "updatedAt": "2026-08-30T09:00:00.000Z"
}
```

## Example: DAI ack patch

After pickup, merge into the entry:

```json
{
  "status": "acked",
  "updatedAt": "2026-08-30T09:05:00.000Z",
  "ack": {
    "hero": "owned-22899",
    "at": "2026-08-30T09:05:00.000Z",
    "note": "Files match summary; starting verify."
  }
}
```

## Chat one-liner to DAI

```
aarcadeghst-changes: sync agc-20260830-081800. Skill dir .opencode/skills/aarcadeghst-changes/
```
