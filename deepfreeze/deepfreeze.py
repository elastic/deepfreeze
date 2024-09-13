#!/usr/bin/env python3
#
import click
import logging
import re
import sys
import boto3
import os
from botocore.exceptions import ClientError
from datetime import datetime
from elasticsearch import Elasticsearch
from dotenv import load_dotenv

logger = logging.getLogger("deepfreeze")
load_dotenv()


class Deepfreeze:
    """
    The Deepfreeze is responsible for managing the repository rotation given
    a config file of user-managed options and settings.
    """

    def __init__(
        self,
        year,
        month,
        debug,
        verbose,
        elasticsearch,
        ca,
        username,
        password,
        repo_name_prefix,
        bucket_name_prefix,
        style,
        base_path,
        canned_acl,
        storage_class,
        keep,
    ) -> None:
        self.year = year
        self.month = month
        self.elasticsearch = elasticsearch
        self.ca = ca
        self.username = username
        self.password = password
        self.repo_name_prefix = repo_name_prefix
        self.bucket_name_prefix = bucket_name_prefix
        self.style = style
        self.base_path = base_path
        self.canned_acl = canned_acl
        self.storage_class = storage_class
        self.keep = keep

        if verbose:
            logging.basicConfig(level=logging.INFO)
            print("INFO")
        elif debug:
            logging.basicConfig(level=logging.DEBUG)
            print("DEBUG")
        else:
            logging.basicConfig(level=logging.WARNING)
            print("WARNING")

        self.es_client = Elasticsearch(
            self.elasticsearch,
            ca_certs=self.ca,
            basic_auth=(self.username, self.password),
        )

        suffix = self.get_next_suffix()
        self.new_repo_name = f"{self.repo_name_prefix}{suffix}"
        self.new_bucket_name = f"{self.bucket_name_prefix}{suffix}"

        self.repo_list = self.get_repos()
        self.repo_list.sort()
        self.latest_repo = self.repo_list[-1]

        if self.new_repo_name in self.repo_list:
            raise Exception(
                f"Requested repo name {self.new_repo_name} " "already exists!"
            )

    def create_new_bucket(self) -> bool:
        """
        Creates a new S3 bucket using the aws config in the environment.

        :returns:   whether the bucket was created or not
        :rtype:     bool
        """
        logging.info(f"Creating bucket {self.new_bucket_name}")
        try:
            s3 = boto3.client("s3")
            s3.create_bucket(Bucket=self.new_bucket_name)
        except ClientError as e:
            logging.error(e)
            return False
        return True

    def create_new_repo(self):
        """
        Creates a new repo using the previously-created bucket.
        """
        logging.info(
            f"Creating repo {self.new_repo_name} using bucket {self.new_bucket_name}"
        )
        self.es_client.snapshot.create_repository(
            name=self.new_repo_name,
            type="s3",
            settings={
                "bucket": self.new_bucket_name,
                "base_path": self.base_path,
                "canned_acl": self.canned_acl,
                "storage_class": self.storage_class,
            },
        )

    def update_ilm_policies(self):
        """
        Loop through all existing IML policies looking for ones which reference
        the latest_repo and update them to use the new repo instead.
        """
        if self.latest_repo == self.new_repo_name:
            logging.warning("Already on the latest repo")
            sys.exit(0)
        logging.info(
            f"Attempting to switch from {self.latest_repo} to " f"{self.new_repo_name}"
        )
        policies = self.es_client.ilm.get_lifecycle()
        updated_policies = {}
        for policy in policies:
            # Go through these looking for any occurrences of self.latest_repo
            # and change those to use self.new_repo_name instead.
            p = policies[policy]["policy"]["phases"]
            updated = False
            for phase in p:
                if "searchable_snapshot" in p[phase]["actions"]:
                    if (
                        p[phase]["actions"]["searchable_snapshot"][
                            "snapshot_repository"
                        ]
                        == self.latest_repo
                    ):
                        p[phase]["actions"]["searchable_snapshot"][
                            "snapshot_repository"
                        ] = self.new_repo_name
                        updated = True
            if updated:
                updated_policies[policy] = policies[policy]["policy"]

        # Now, submit the updated policies to _ilm/policy/<policyname>
        if not updated_policies:
            logging.warning("No policies to update")
        else:
            logging.info(f"Updating {len(updated_policies.keys())} policies:")
        for pol in updated_policies:
            logging.info(f"\t{pol}")
            self.es_client.ilm.put_lifecycle(name=pol, policy=updated_policies[pol])

    def get_next_suffix(self):
        """
        Gets the next suffix, depending on the naming style chosen.
        """
        if self.style == "monthly":
            year = self.year if self.year else datetime.now.year()
            month = self.month if self.month else datetime.now.month()
            return f"{year:04}.{month:02}"
        elif self.style == "oneup":
            pattern = re.compile(f"{self.repo_name_prefix}(.+)")
            cur_suffix = pattern.search(self.latest_repo).group(1)
            return cur_suffix

    def unmount_oldest_repos(self):
        """
        Take the oldest repos from the list and remove them, only retaining
        the number chosen in the config under "keep".
        """
        s = slice(0, len(self.repo_list) - self.keep)
        print(f"Repo list: {self.repo_list}")
        for repo in self.repo_list[s]:
            print(f"Removing repo {repo}")
            self.es_client.snapshot.delete_repository(name=repo)

    def get_repos(self) -> list[object]:
        """
        Get the complete list of repos and return just the ones whose names
        begin with our prefix.

        :returns:   The repos.
        :rtype:     list[object]
        """
        repos = self.es_client.snapshot.get_repository()
        pattern = re.compile(self.repo_name_prefix)
        return [repo for repo in repos if pattern.search(repo)]

    def rotate(self) -> None:
        """
        Perform our high-level steps in sequence.
        """
        if self.create_new_bucket():
            self.create_new_repo()
            self.update_ilm_policies()
            self.unmount_oldest_repos()
        else:
            logging.warning(f"Could not create bucket {self.new_bucket_name}")
            sys.exit(1)


@click.command()
@click.argument("year", type=int, required=False, default=datetime.now().year)
@click.argument("month", type=int, required=False, default=datetime.now().month)
@click.option("--debug", is_flag=True, hidden=True)
@click.option(
    "--verbose",
    "-v",
    is_flag=True,
    help="Display extra debugging output during execution",
)
@click.option(
    "--elasticsearch",
    type=str,
    default=os.environ.get("DEEPFREEZE_ELASTICSEARCH"),
    required=True,
    help="URL to use when connecting to elasticsearch (https://elasticsearch.local:9200)",
)
@click.option(
    "--ca",
    type=str,
    default=os.environ.get("DEEPFREEZE_CA"),
    required=True,
    help="path to ca cert file",
)
@click.option(
    "--username",
    type=str,
    default=os.environ.get("DEEPFREEZE_USERNAME"),
    required=True,
    help="username for elasticsearch connection",
)
@click.password_option(hidden=True)
@click.option(
    "--repo_name_prefix",
    type=str,
    default=os.environ.get("DEEPFREEZE_REPO_NAME_PREFIX"),
    required=True,
    help="prefix for naming rotating repositories",
)
@click.option(
    "--bucket_name_prefix",
    type=str,
    default=os.environ.get("DEEPFREEZE_BUCKET_NAME_PREFIX"),
    required=True,
    help="prefix for naming buckets",
)
@click.option(
    "--style",
    type=click.Choice(["oneup", "monthly"]),
    default=os.environ.get("DEEPFREEZE_STYLE"),
    required=True,
    help="suffix can be one-up like indices or date-based (YYYY.MM)",
)
@click.option(
    "--base_path",
    type=str,
    default=os.environ.get("DEEPFREEZE_BASE_PATH"),
    required=True,
    help="base path in the bucket to use for searchable snapshots",
)
@click.option(
    "--canned_acl",
    type=click.Choice(
        [
            "private",
            "public-read",
            "public-read-write",
            "authenticated-read",
            "log-delivery-write",
            "bucket-owner-read",
            "bucket-owner-full-control",
        ]
    ),
    default=os.environ.get("DEEPFREEZE_CANNED_ACL"),
    required=True,
    help="Canned ACL as defined by AWS",
)
@click.option(
    "--storage_class",
    type=click.Choice(
        [
            "standard",
            "reduced_redundancy",
            "standard_ia",
            "intelligent_tiering",
            "onezone_ia",
        ]
    ),
    default=os.environ.get("DEEPFREEZE_STORAGE_CLASS"),
    required=True,
    help="Storage class as defined by AWS",
)
@click.option(
    "--keep",
    type=int,
    default=os.environ.get("DEEPFREEZE_KEEP"),
    required=True,
    help="How many repositories should remain mounted?",
)
@click.help_option("--help", "-?")
@click.version_option()
def deepfreeze(
    year,
    month,
    debug,
    verbose,
    elasticsearch,
    ca,
    username,
    password,
    repo_name_prefix,
    bucket_name_prefix,
    style,
    base_path,
    canned_acl,
    storage_class,
    keep,
):
    """
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

    Do not set DEEPFREEZE_PASSWORD as an environment variable. The only way to
    securely provide the password for the elasticsearch username is on the
    command line using secure entry, and so that's what we do.
    """
    Deepfreeze(
        year,
        month,
        debug,
        verbose,
        elasticsearch,
        ca,
        username,
        password,
        repo_name_prefix,
        bucket_name_prefix,
        style,
        base_path,
        canned_acl,
        storage_class,
        keep,
    ).rotate()


if __name__ == "__main__":
    deepfreeze()
