#!/usr/bin/env python3
#
import click
import logging
import re
import sys
import boto3
from botocore.exceptions import ClientError
from datetime import datetime
from elasticsearch import Elasticsearch
from config import Config


class Processor:
    """
    The Processor is responsible for managing the repository rotation given
    a config file of user-managed options and settings.
    """
    def __init__(self, args) -> None:
        self.config = Config()
        self.args = args

        self.elasticsearch = Elasticsearch(
            self.config.elasticsearch,
            ca_certs=self.config.ca,
            basic_auth=(self.config.username, self.config.password)
        )

        suffix = self.get_next_suffix()
        self.new_repo_name = f"{self.config.repo_name_prefix}{suffix}"
        self.new_bucket_name = f"{self.config.bucket_name_prefix}{suffix}"

        self.repo_list = self.get_repos()
        self.repo_list.sort()
        self.latest_repo = self.repo_list[-1]

        if self.new_repo_name in self.repo_list:
            raise Exception(f"Requested repo name {self.new_repo_name} "
                            "already exists!")

    def create_new_bucket(self):
        """
        Creates a new bucket.
        """
        try:
            s3 = boto3.client('s3')
            s3.create_bucket(Bucket=self.new_bucket_name)
        except ClientError as e:
            logging.error(e)
            return False
        return True

    def create_new_repo(self):
        """
        Creates a new repo using the previously-created bucket.
        """
        self.elasticsearch.snapshot.create_repository(
            name=self.new_repo_name,
            type="s3",
            settings={
                "bucket": self.new_bucket_name,
                "base_path": self.config.base_path,
                "canned_acl": self.config.canned_acl,
                "storage_class": self.config.storage_class
            }
        )

    def update_ilm_policies(self):
        """
        Loop through all existing IML policies looking for ones which reference
        the latest_repo and update them to use the new repo instead.
        """
        if self.latest_repo == self.new_repo_name:
            print("Already on the latest repo")
            return
            sys.exit(0)
        print(f"Attempting to switch from {self.latest_repo} to "
              f"{self.new_repo_name}")
        policies = self.elasticsearch.ilm.get_lifecycle()
        updated_policies = {}
        for policy in policies:
            # Go through these looking for any occurrences of self.latest_repo
            # and change those to use self.new_repo_name instead.
            p = policies[policy]['policy']['phases']
            updated = False
            for phase in p:
                if 'searchable_snapshot' in p[phase]['actions']:
                    if p[phase]['actions']['searchable_snapshot']['snapshot_repository'] == self.latest_repo:
                        p[phase]['actions']['searchable_snapshot']['snapshot_repository'] = self.new_repo_name
                        updated = True
            if updated:
                updated_policies[policy] = policies[policy]['policy']

        # Now, submit the updated policies to _ilm/policy/<policyname>
        if len(updated_policies.keys()) == 0:
            print("No policies to update")
        else:
            print(f"Updating {len(updated_policies.keys())} policies:")
        for pol in updated_policies.keys():
            print(f"\t{pol}")
            self.elasticsearch.ilm.put_lifecycle(
                name=pol,
                policy=updated_policies[pol]
            )

    def get_next_suffix(self):
        """
        Gets the next suffix, depending on the naming style chosen.
        """
        if self.config.style == "monthly":
            year = self.args.year if self.args.year else datetime.now.year()
            month = self.args.month if self.args.month else datetime.now.month()
            return f"{year:04}.{month:02}"
        elif self.config.style == "oneup":
            pattern = re.compile(f"{self.config.repo_name_prefix}(.+)")
            cur_suffix = pattern.search(self.latest_repo).group(1)
            return cur_suffix

    def unmount_oldest_repos(self):
        """
        Take the oldest repos from the list and remove them, only retaining
        the number chosen in the config under "keep".
        """
        s = slice(0, len(self.repo_list) - self.config.keep)
        print(f"Repo list: {self.repo_list}")
        for repo in self.repo_list[s]:
            print(f"Removing repo {repo}")

    def get_repos(self) -> list[object]:
        """
        Get the complete list of repos and return just the ones whose names
        begin with our prefix.

        :returns:   The repos.
        :rtype:     list[object]
        """
        repos = self.elasticsearch.snapshot.get_repository()
        pattern = re.compile(self.config.repo_name_prefix)
        keepers = []
        for repo in repos.keys():
            if pattern.search(repo):
                keepers.append(repo)
        return keepers

    def process(self) -> None:
        """
        Perform our high-level steps in sequence.
        """
        if self.create_new_bucket():
            self.create_new_repo()
            self.update_ilm_policies()
            self.unmount_oldest_repos()
        else:
            print(f"Could not create bucket {self.new_bucket_name}")
            sys.exit(1)


@click.command()
@click.argument('year', type=int, required=False)
@click.argument('month', type=int, required=False)
def main(year, month):
    """
    deepfreeze handles creating a new bucket, setting up a repository for
    that bucket, updating ILM policies to use the new bucket, and unmounting
    buckets we no longer wish to keep online.

    It uses a configuration stored in /etc/deepfreeze/config.yml. A template
    is provided at /etc/deepfreeze/config.yml.template.

    Optionally, a year and month can be provided. If not, the current year
    and month will be used in naming the next bucket and repository.
    """
    Processor(year, month).process()


if __name__ == "__main__":
    main()
