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


## Installing

*Provide better directions for installing from here until we're stable enough to warrant publishing to pypi*

```
$ pip install deepfreeze
```

### Environment variables

Deepfreeze requires several environment variables to work. These can also be given through command-line options.

Sensible defaults are provided wherever possible. If you accept them, then all that's required is the URL of your elasticsearch instance (given by DEEPFREEZE_ELASTICSEARCH or the "--elasticsearch" option) and the password for the elastic user (prompted for on each invocation).

*Note: We will be adding a way to provide the password securely so that the deepfreeze command can be run in a cron job.*

You can define the values in a file (the values given below are the defaults):

```
export DEEPFREEZE_ELASTICSEARCH=https://192.168.1.256:9200
export DEEPFREEZE_CA=/etc/elasticsearch/certs/http_ca.crt
export DEEPFREEZE_USERNAME=elastic
export DEEPFREEZE_KEEP=6
export DEEPFREEZE_REPO_NAME_PREFIX='deepfreeze-'
export DEEPFREEZE_BUCKET_NAME_PREFIX='deepfreeze-'
export DEEPFREEZE_STYLE=monthly
export DEEPFREEZE_BASE_PATH=snapshots
export DEEPFREEZE_CANNED_ACL=private
export DEEPFREEZE_STORAGE_CLASS=intelligent_tiering
```

Then, source this file before running the command:

```
$ source my-deepfreeze-env.sh
```

## Bootstrapping

*Do we want a bootstrapping function, which sets up the initial deepfreeze repository & bucket? We'd need to know what current repo(s) it's replacing, but it could be done.*

Currently, deepfreeze expects that at least one repo with the expected name pattern exists. You will need to have created this by hand.

## Code

[![Code style: black](https://img.shields.io/badge/code%20style-black-000000.svg)](https://github.com/psf/black)

There is one script, rotate-monthly-repository.py. It manages the whole process, including:
1. Creating a new S3 bucket,
2. Mounting that S3 bucket as a new snapshot repository,
3. Updating ILM Policies which use the current bucket to use the new one, and
4. Unmounting older repositories

It has a few command-line options and a config file, rotate-monthly-repository.yml with explanations of all settings.

```
# deepfreeze --help
Usage: deepfreeze [OPTIONS] [YEAR] [MONTH]

  deepfreeze handles creating a new bucket, setting up a repository for
  that bucket, updating ILM policies to use the new bucket, and unmounting
  buckets we no longer wish to keep online.

  It uses a configuration stored in /etc/deepfreeze/config.yml. A template
  is provided at /etc/deepfreeze/deepfreeze.yml.reference.

  Optionally, a year and month can be provided. If not, the current year
  and month will be used in naming the next bucket and repository. Default
  values for all other parameters will be taken from environment variables
  named "DEEPFREEZE_<paramter>", eg DEEPFREEZE_USERNAME. Any missing values
  will result in an error.

  Even though we don't recommend it, you can set DEEPFREEZE_PASSWORD as an
  environment variable if your security posture allows. The only way
  to securely provide the password for the elasticsearch username is on the
  command line using secure entry, and so that's what we do.

Options:
  -v, --verbose                   Display extra debugging output during
                                  execution
  --elasticsearch TEXT            URL to use when connecting to
                                  elasticsearch
                                  (https://elasticsearch.local:9200)
                                  [required]
  --ca TEXT                       path to ca cert file  [required]
  --username TEXT                 username for elasticsearch connection
                                  [required]
  --repo_name_prefix TEXT         prefix for naming rotating repositories
                                  [required]
  --bucket_name_prefix TEXT       prefix for naming buckets  [required]
  --style [oneup|monthly]         suffix can be one-up like indices or
                                  date-based (YYYY.MM)  [required]
  --base_path TEXT                base path in the bucket to use for
                                  searchable snapshots  [required]
  --canned_acl [private|public-read|public-read-write|authenticated-read|log-delivery-write|bucket-owner-read|bucket-owner-full-control]
                                  Canned ACL as defined by AWS  [required]
  --storage_class [standard|reduced_redundancy|standard_ia|intelligent_tiering|onezone_ia]
                                  Storage class as defined by AWS
                                  [required]
  --keep INTEGER                  How many repositories should remain
                                  mounted?  [required]
  -?, --help                      Show this message and exit.
  --version                       Show the version and exit.
```

to see current options.

## Setup

First, install the required modules using pip.
```
$ pip install -r requirements.txt
```

