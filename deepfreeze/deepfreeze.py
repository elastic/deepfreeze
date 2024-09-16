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
from dataclasses import dataclass

logger = logging.getLogger("deepfreeze")
formatter = logging.Formatter("%(levelname)s - %(message)s")
ch = logging.StreamHandler()
ch.setFormatter(formatter)
logger.addHandler(ch)
load_dotenv()


class RepositoryException(Exception):
    pass


@dataclass
class Deepfreeze:
    """
    The Deepfreeze is responsible for managing the repository rotation given
    a config file of user-managed options and settings.
    """

    year: str
    month: str
    debug: bool
    verbose: bool
    elasticsearch: str
    ca: str
    username: str
    password: str
    repo_name_prefix: str
    bucket_name_prefix: str
    style: str
    base_path: str
    canned_acl: str
    storage_class: str
    keep: int

    def setup(self):
        if self.verbose:
            logger.setLevel(level=logging.INFO)
            print("INFO")
        elif self.debug:
            logger.setLevel(level=logging.DEBUG)
            print("DEBUG")
        else:
            logger.setLevel(level=logging.WARNING)
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
        try:
            self.latest_repo = self.repo_list[-1]
        except IndexError:
            raise RepositoryException(
                f"no matching repositories exist for {self.repo_name_prefix}*"
            ) from None

        if self.new_repo_name in self.repo_list:
            raise RepositoryException(
                f"repository {self.repo_name} already exists"
            ) from None

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
        self.create_new_bucket()
        self.create_new_repo()
        self.update_ilm_policies()
        self.unmount_oldest_repos()

    def dump(self):
        """
        Dump the current configuration
        """
        print(f"year: {self.year}")
        print(f"month: {self.month}")
        print(f"debug: {self.debug}")
        print(f"verbose: {self.verbose}")
        print(f"elasticsearch: {self.elasticsearch}")
        print(f"ca: {self.ca}")
        print(f"username: {self.username}")
        print(f"password: {self.password}")
        print(f"repo_name_prefix: {self.repo_name_prefix}")
        print(f"bucket_name_prefix: {self.bucket_name_prefix}")
        print(f"style: {self.style}")
        print(f"base_path: {self.base_path}")
        print(f"canned_acl: {self.canned_acl}")
        print(f"storage_class: {self.storage_class}")
        print(f"keep: {self.keep}")


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
    default=os.environ.get("DEEPFREEZE_CA", "/etc/elasticsearch/certs/http_ca.crt"),
    required=True,
    help="path to ca cert file",
)
@click.option(
    "--username",
    type=str,
    default=os.environ.get("DEEPFREEZE_USERNAME", "elastic"),
    required=True,
    help="username for elasticsearch connection",
)
@click.password_option(hidden=True, default=os.environ.get("DEEPFREEZE_PASSWORD")
@click.option(
    "--repo_name_prefix",
    type=str,
    default=os.environ.get("DEEPFREEZE_REPO_NAME_PREFIX", "deepfreeze-"),
    required=True,
    help="prefix for naming rotating repositories",
)
@click.option(
    "--bucket_name_prefix",
    type=str,
    default=os.environ.get("DEEPFREEZE_BUCKET_NAME_PREFIX", "deepfreeze-"),
    required=True,
    help="prefix for naming buckets",
)
@click.option(
    "--style",
    type=click.Choice(["oneup", "monthly"]),
    default=os.environ.get("DEEPFREEZE_STYLE", "monthly"),
    required=True,
    help="suffix can be one-up like indices or date-based (YYYY.MM)",
)
@click.option(
    "--base_path",
    type=str,
    default=os.environ.get("DEEPFREEZE_BASE_PATH", "snapshots"),
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
    default=os.environ.get("DEEPFREEZE_CANNED_ACL", "private"),
    required=True,
    help="Canned ACL as defined by AWS",
)
@click.option(
    "--keep",
    type=int,
    default=os.environ.get("DEEPFREEZE_KEEP", 6),
    required=True,
    help="How many repositories should remain mounted?",
)
@click.option("--dump", is_flag=True, hidden=True)
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
    dump,
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

    Even though we don't recommend it, you can set DEEPFREEZE_PASSWORD as an
    environment variable if your security posture allows. The only way
    to securely provide the password for the elasticsearch username is on the
    command line using secure entry, and so that's what we do.
    """
    freezer = Deepfreeze(
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
    )
    if dump:
        freezer.dump()
    else:
        freezer.setup()
        freezer.rotate()


if __name__ == "__main__":
    deepfreeze()
