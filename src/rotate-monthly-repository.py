#!/usr/bin/env python3
#
import argparse
from datetime import datetime
import json
import logging
import re
from elasticsearch import Elasticsearch
import sys
from urllib.parse import urlunsplit
from config import Config
import boto3
from botocore.exceptions import ClientError


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
        print(f"self.repo_list={self.repo_list}")
        self.latest_repo = self.repo_list[-1]

    #     if self.new_repo_name in self.repo_list:
    #         raise Exception(f"Requested repo name {self.new_repo_name} "
    #                         "already exists!")

    def create_new_bucket(self):
        # Create a new bucket, required before we can add a new repo which
        # references it.
        print("Creating bucket")
        try:
            s3 = boto3.client('s3')
            s3.create_bucket(Bucket=self.new_bucket_name)
        except ClientError as e:
            logging.error(e)
            return False
        return True

    def create_new_repo(self):
        # Create a new repo using self.new_repo_name and self.new_bucket_name
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
        policies = self.elasticsearch.ilm.get_lifecycle()
        updated_policies = {}
        for policy in policies:
            print(f"Policy {policy}")
            print(type(policy))
            # Go through these looking for any occurrences of self.latest_repo
            # and change those to use self.new_repo_name instead.
            p = policies[policy]['policy']['phases']
            updated = False
            for phase in p:
                if 'searchable_snapshot' in p[phase]['actions']:
                    if p[phase]['actions']['searchable_snapshot']['snapshot_repository'] == self.latest_repo:
                        p[phase]['actions']['searchable_snapshot']['snapshot_repository'] == self.new_repo_name
                        updated = True
            if updated:
                updated_policies[policy] = policies[policy]['policy']

        # Now, submit the updated policies to _ilm/policy/<policyname>
        for policy in updated_policies.keys():
            payload = json.dumps(updated_policies[policy])
            # Update this policy with the provided payload using self.elasticsearch

    def get_next_suffix(self):
        if self.config.style == "monthly":
            year = self.args.year if self.args.year else datetime.now.year()
            month = self.args.month if self.args.month else datetime.now.month()
            return f"{year:04}.{month:02}"
        elif self.config.style == "oneup":
            pattern = re.compile(f"{self.config.repo_name_prefix}(.+)")
            cur_suffix = pattern.search(cur_repo).group(1)
            return cur_suffix

    def unmount_oldest_repo(self):
        # Time to call the unmount API on self.oldest_repo
        pass

    def get_repos(self) -> list[object]:
        repos = self.elasticsearch.snapshot.get_repository()
        pattern = re.compile(self.config.repo_name_prefix)
        keepers = []
        for repo in repos.keys():
            # If the repo name starts with self.config.repo_name_prefix,
            # add it to the list of ones we care about.
            if pattern.search(repo):
                keepers.append(repo)
        return keepers

    def process(self) -> None:
        if self.create_new_bucket():
            self.create_new_repo()
            self.update_ilm_policies()
            # self.unmount_oldest_repo()
        else:
            print(f"Could not create bucket {self.new_bucket_name}")
            sys.exit(1)


def main(args):
    Processor(args).process()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument('year', metavar='YEAR', type=int,
                        default=datetime.now().year,
                        nargs='?',
                        help='Year for the new repo')
    parser.add_argument('month', metavar='MONTH', type=int,
                        default=datetime.now().month,
                        nargs='?',
                        help='Month for the new repo')
    args = parser.parse_args()

    main(args)
