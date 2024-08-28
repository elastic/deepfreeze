#!/usr/bin/env python3
#
import argparse
import json
import request
import yaml


class Processor:
    """
    The Processor is responsible for managing the repository rotation given
    a config file of user-managed options and settings.
    """
    def __init__(self, config) -> None:
        self.policies_url = config['url']['policies']

    def create_new_repo(self):
        pass

    def unmount_oldest_repo(self):
        pass

    def update_ilm_policies(self):
        rv = requests.get(self.policies_url)
        pass

    def process(self) -> None:
        repo_list = self.get_repos()
        # Check to ensure the new repo isn't already defined
        self.create_new_repo(name)
        self.update_ilm_policies(name)
        self.unmount_oldest_repo(repo_list)


def main(config):
    Processor(config).process()
    

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', '-c', dest=config,
                        default='/etc/rotate-monthly-repository.yml',
                        help='alternate config file (default: /etc/rotate-monthly-repository.yml)')
    args=parser.parse_args()

    with open(configfile, 'r') as file:
        config = yaml.safe_load(file)
    
    main(config)
