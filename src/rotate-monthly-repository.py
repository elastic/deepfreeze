#!/usr/bin/env python3
#
import argparse
import json
import request
import yaml
from dataclasses import dataclass


@dataclass
class Processor:
    """
    The Processor is responsible for managing the repository rotation given
    a config file of user-managed options and settings.
    """
    def __init__(self, config: dict[str, object]) -> None:
        repo_name_pattern = config['repo_name_pattern']
        bucket_name_pattern = config['bucket_name_pattern'] \
            if 'bucket_name_pattern' in config else repo_name_pattern
        # Initialize attributes
        self.repo_name = repo_name_pattern.format(year=year, month=month)
        self.bucket_name = bucket_name_pattern.format(year=year, month=month)
        self.policies_url = config['urls']['policies']

        repo_list = self.get_repos()
        repo_names = get_repo_names(repo_list)
        # TODO: Check to ensure the new repo isn't already defined
        if self.repo_name in repo_names:
            raise Exception(f"Requested repo name {self.repo_name} already exists!")
        self.oldest_repo = repo_list[-1]
        self.newest_repo = repo_list[1]

    def create_new_repo(self):
        # Create a new repo using self.repo_name and self.bucket_name
        pass

    def unmount_oldest_repo(self):
        # Time to call the unmount API on self.oldest_repo
        pass

    def update_ilm_policies(self):
        rv = requests.get(self.policies_url)
        # Go through these looking for any occurrences of self.newest_repo
        # and change those to use self.repo_name instead.
        pass

    def process(self) -> None:
        self.create_new_repo()
        self.update_ilm_policies()
        self.unmount_oldest_repo()

    def get_repos(self) -> list[object]:

        return []


def get_repo_names(dict[]) -> list[str]:
    """
    Helper function to extract repository names from the repo list.
    """
    names = []


    return names


def main(year: int, month: int, config):
    Processor(config).process()
    

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', '-c', dest=config,
                        default='/etc/rotate-monthly-repository.yml',
                        help='alternate config file (default: /etc/rotate-monthly-repository.yml)')
    parser.add_argument('year', metavar='YEAR', type=int, help='Year for the new repo')
    parser.add_argument('month', metavar='MONTH', type=int, help='Month for the new repo')
    args=parser.parse_args()

    with open(configfile, 'r') as file:
        config = yaml.safe_load(file)
    
    main(args.year, args.month, config)
