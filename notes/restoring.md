# Restoring a snapshot

Basically, at its most simple:

```
POST _snapshot/$repo/$snapshot/_mount?wait_for_completion=true
{
  "index": "$index_name"
}
```

### NCAVE

Here's the script we developed for pulling snapshots and creating scriptlets for each.

```
#!/bin/bash

policy="migration"
prefix=""
file="index_settings.json"
frozen=false

usage() {
    cat <<EOF
Usage:

    split_searchable_snapshots [-f] [-i filename] [-p policy_name] cluster

    cluster     Cluster ID for the destination cluster

    OPTIONS
    -i filename     Alternate input filename (instead of index_settings.json)
    -f              Frozen; Append "-dtf" to ILM policy name and import to frozen
                    nodes as appropriate by setting _tier_preference to "data_frozen"
                    and mount as a partial. If not set, "-dtc" will be appended,
                    indicating a cold mount instead and the _tier_preference will
                    likewise be set to data_cold.
    -p policy_name  Base name of ILM policy. This assumes there will be two
                    policies, named policy_name-dtc and policy_name-dtf, for 
                    direct-to-cold and direct-to-frozen, respectively.  These policies
                    simply move data to the selected tier at 0m, have no rollover, and
                    then age the data to subsequent tiers or deletion as usual.

EOF
exit
}

OPTIND=1

while getopts "i:fp:h?" option; do
  case "$option" in
    i*)
      file=$OPTARG
    ;;
    f*)
      frozen=true
    ;;
    p*)
      policy=$OPTARG
    ;;
    [?h])
      usage
  esac
done
shift "$((OPTIND - 1))"
if [[ $# -lt 1 ]]; then
  usage
fi
cluster=$1
keys=($(jq -r keys $file))
lines=${#keys[@]}

echo "$lines templates in $file"

[[ -d searchable_snapshots ]] || mkdir searchable_snapshots
v=$(( lines - 1 ))
c=0
if $frozen; then
  prefix="partial-"
  index_list="frozen_indices.txt"
  tier_preference="data_frozen"
  partial="true"
  policy="${policy}-dtf"
else
  prefix="restored-"
  index_list="cold_indices.txt"
  tier_preference="data_cold"
  partial="false"
  policy="${policy}-dtc"
fi
cat /dev/null > $index_list
for (( n=0; n<=v; n++ )); do
  name=$(echo ${keys[$n]} | tr -d '",')
  if [[ ! $name =~ ^$prefix ]]; then
    echo "skipping $name - $(( n + 1 )) of $lines"
    continue
   else
    echo "Splitting $name - $(( n + 1 )) of $lines"
    snapshot=$(jq -r ".[\"$name\"].settings.index.store.snapshot.snapshot_name" $file)
    index_name=$(jq -r ".[\"$name\"].settings.index.store.snapshot.index_name" $file)
    repo=$(jq -r ".[\"$name\"].settings.index.store.snapshot.repository_name" $file)
    cat <<EOF >searchable_snapshots/$name.snapshot
#!/bin/bash
source /etc/profile.d/elastic-services.sh
postcurl $cluster "_snapshot/$repo/$snapshot/_mount?wait_for_completion=true" "{\"index\": \"$index_name\", \"renamed_index\": \"$name\", \"index_settings\": {\"index\": {\"lifecycle_name\": \"$policy\", \"routing.allocation.include._tier_preference\": \"$tier_preference\", \"store.snapshot.partial\": \"$partial\"}}}"
echo

EOF
    chmod +x searchable_snapshots/$name.sh
    echo $name >> $index_list
  fi
done

# vimn: ts=4 sts=4 sw=4 et ft=sh
```
