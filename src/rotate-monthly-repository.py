#!/usr/bin/env python3
#
import argparse
import json
import logging
import requests
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

        self.new_repo_name = self.config.repo_name_pattern.format(
            year=self.args.year,
            month=self.args.month)
        self.new_bucket_name = self.config.bucket_name_pattern.format(
            year=self.args.year,
            month=self.args.month)

        self.repo_list = self.get_repos()
        if self.new_repo_name in self.repo_list:
            raise Exception(f"Requested repo name {self.new_repo_name} "
                            "already exists!")

        netloc = f'{self.config.host}:{self.config.port}'

        self.policies_url = urlunsplit((
            self.config.scheme,
            netloc,
            self.config.policy_ep,
            '',
            '',
        ))
        self.snapshot_repo_url = urlunsplit((
            self.config.scheme,
            netloc,
            f"{self.config.repo_ep}/{{name}}",
            '',
            ''
        ))

        self.session = requests.Session()
        self.session.auth = (self.config.username, self.config.password)

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
        print("Creating repo")
        repo = {
            "type": "s3",
            "settings": {
                "bucket": self.new_bucket_name,
                "base_path": self.config.base_path,
                "canned_acl": self.config.canned_acl,
                "storage_class": self.config.storage_class
            }
        }
        headers = {
            "Content-Type": "application/json"
        }
        self.session.put(self.snapshot_repo_url.format(name=self.new_repo_name),
                         data=repo,
                         headers=headers,
                         verify=False)

    def update_ilm_policies(self):
        policies = self.session.get(self.policies_url, verify=False).json()
        updated_policies = {}
        for policy in policies:
            # Go through these looking for any occurrences of self.newest_repo
            # and change those to use self.new_repo_name instead.
            p = policies[policy]['policy']['phases']
            updated = False
            for phase in p:
                if 'searchable_snapshot' in p[phase]['actions']:
                    print(f"repo = {p[phase]['actions']['searchable_snapshot']['snapshot_repository']}")
                    if p[phase]['actions']['searchable_snapshot']['snapshot_repository'] == self.newest_repo:
                        p[phase]['actions']['searchable_snapshot']['snapshot_repository'] == self.new_repo_name
                        updated = True
            if updated:
                updated_policies.append(policies[policy]['policy'])

        # Now, submit the updated policies to _ilm/policy/<policyname>
        for policy in updated_policies:
            payload = json.dumps(policy)
            print(payload)

    def unmount_oldest_repo(self):
        # Time to call the unmount API on self.oldest_repo
        pass

    def get_repos(self) -> list[object]:
        print("Getting repo list")
        list = self.session.get(
                       self.snapshot_repo_url.format(name=self.new_repo_name),
                       verify=False)
        return list.json()

    def process(self) -> None:
        if self.create_new_bucket():
            self.create_new_repo()
            self.update_ilm_policies()
            self.unmount_oldest_repo()
        else:
            print(f"Could not create bucket {self.new_bucket_name}")
            sys.exit(1)


def get_repo_names(repos) -> list[str]:
    """
    Helper function to extract repository names from the repo list.
    """
    names = []

    return names


def main(args):
    Processor(args).process()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument('year', metavar='YEAR', type=int,
                        help='Year for the new repo')
    parser.add_argument('month', metavar='MONTH', type=int,
                        help='Month for the new repo')
    args = parser.parse_args()

    main(args)
