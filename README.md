# Deep Freeze
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

We then keep a certain number of searchable snapshot repositories mounted, while unmounting those which exceed that
total. This allows us to quickly bring back older data without the burden of keeping it in our frozen tier indefinitely.

## Intelligent Tiering

How does this play with IT? If a searchable snapshot ages into the deepfreeze while ES is still actively working with searchable snapshots in the same bucket, does any data move down in temperature? Will the "ignored" searchable snapshots be ignored by ES sufficiently that they can age to glacier eventually?


## Code

There is one script, rotate-monthly-repository.py. It manages the whole process, including:
1. Creating a new S3 bucket,
2. Mounting that S3 bucket as a new snapshot repository,
3. Updating ILM Policies which use the current bucket to use the new one, and
4. Unmounting older repositories

It has a few command-line options and a config file, rotate-monthly-repository.yml with explanations of all settings.

```
# ./rotate-monthly-repository.py -?
```

to see current options.