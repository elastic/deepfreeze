# #!/usr/bin/env python3

from pydantic import field_validator, AnyUrl, FilePath
from pydantic_settings import BaseSettings, SettingsConfigDict
from pathlib import Path
import yaml


class Config(BaseSettings):
    elasticsearch: AnyUrl
    ca: FilePath
    username: str
    password: str
    repo_name_prefix: str
    bucket_name_prefix: str
    style: str
    base_path: Path
    canned_acl: str
    storage_class: str
    keep: int

    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="APP_",
    )

    @field_validator('username', 'password')
    @classmethod
    def check_no_spaces(cls, v: str) -> str:
        if ' ' in v:
            raise ValueError('must not contain spaces')
        return v

    @field_validator('repo_name_prefix', 'bucket_name_prefix')
    @classmethod
    def check_trailing_dash(cls, v: str) -> str:
        if v[-1] != '-':
            raise ValueError('must end in "-"')
        return v

    @field_validator('style')
    @classmethod
    def check_style(cls, v: str) -> str:
        if v not in ['monthly', 'oneup']:
            raise ValueError('style must be one of monthly, oneup')
        return v

    @field_validator('canned_acl')
    @classmethod
    def check_canned_acl(cls, v: str) -> str:
        if v not in [
            'private',
            'public-read',
            'public-read-write',
            'authenticated-read',
            'log-delivery-write',
            'bucket-owner-read',
            'bucket-owner-full-control'
        ]:
            raise ValueError('unknown value for canned_acl')
        return v

    @field_validator('storage_class')
    @classmethod
    def check_storage_class(cls, v: str) -> str:
        if v not in [
            'standard',
            'reduced_redundancy',
            'standard_ia',
            'intelligent_tiering',
            'onezone_ia'
        ]:
            raise ValueError('unknown value for storage_class')
        return v

    @classmethod
    def load_yaml_settings(cls):
        with open("rotate-monthly-repository.yml", "r") as f:
            return yaml.safe_load(f)

    @classmethod
    def settings_customise_sources(cls, settings_cls, init_settings, env_settings, dotenv_settings, file_secret_settings):
        return (
            init_settings,
            env_settings,
            dotenv_settings,
            file_secret_settings,
            cls.load_yaml_settings,
        )


if __name__ == "__main__":

    # Instantiate the settings
    settings = Config()

    print(f"elasticsearch = {settings.elasticsearch}")
    print(f"ca = {settings.ca}")
    print(f"username = {settings.username}")
    print(f"password = {settings.password}")
    print(f"repo_name_prefix = {settings.repo_name_prefix}")
    print(f"bucket_name_prefix = {settings.bucket_name_prefix}")
    print(f"style = {settings.style}")
    print(f"base_path = {settings.base_path}")
    print(f"canned_acl = {settings.canned_acl}")
    print(f"storage_class = {settings.storage_class}")
    print(f"keep = {settings.keep}")
