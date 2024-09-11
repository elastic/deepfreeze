# #!/usr/bin/env python3

from pydantic_settings import BaseSettings, SettingsConfigDict
import yaml
# from pydantic.types import SecretStr


class Config(BaseSettings):
    elasticsearch: str
    ca: str
    username: str
    password: str
    repo_name_prefix: str
    bucket_name_prefix: str
    style: str
    policy_ep: str
    repo_ep: str
    base_path: str
    canned_acl: str
    storage_class: str

    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="APP_",
    )

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
    print(f"settings.host = {settings.host}")
    print(f"settings.username = {settings.username}")
    print(f"settings.username = {settings.username}")
    print(f"settings.password = {settings.password}")
    print(f"settings.repo_name_prefix = {settings.repo_name_prefix}")
    print(f"settings.style = {settings.style}")
    print(f"settings.scheme = {settings.scheme}")
    print(f"settings.policy_ep = {settings.policy_ep}")
    print(f"settings.repo_ep = {settings.repo_ep}")
