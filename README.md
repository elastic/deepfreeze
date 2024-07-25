# deepfreeze
A project to examine the idea of retaining searchable snapshots after an index is deleted by ILM so that it can later be remounted if needed.

The idea is to use an ILM policy whose `delete` action only removes the index, not the searchable snapshot like this:

```
{
  "policy": {
    "phases": {
      "delete": {
        "min_age": "180d",
        "actions": {
          "delete": {
            "delete_searchable_snapshot": false
          }
        }
      },
```

The challenge becomes tracking what was in each snapshot so that finding the right one to remount (using the `_mount` API) is easy.

## Tracking Index
We need an index to track all searchable snapshots which maps the following fields for ease of search & retrieval:

- index_name
- start_datetime
- end_datetime
- repository
- snapshot_name
- [anything else we need?]

Given this index's importance, let's make it default to having a replica on every content and hot node. Maybe every data node? Look to enrich indexes and see what they do.

No need to update, just insert. What about deletions? Probably a good idea.

## Intelligent Tiering

How does this play with IT? If a searchable snapshot ages into the deepfreeze while ES is still actively working with searchable snapshots in the same bucket, does any data move down in temperature? Will the "ignored" searchable snapshots be ignored by ES sufficiently that they can age to glacier eventually?


## Code
Python or bash? Keep this as simple as possible and run it daily so that it can update newly-minted searchable snapshots in the deepfreeze index.

Another job to go through the list of snapshots and make sure they all still exist, deleting those that don't? Alerting somehow when that happens?
