from dataclasses import dataclass

@dataclass
class Config(dict):
    """
    This class describes the configuration elements set in rotate-monthly-repository.yml
    """
    def __init__(self, config: dict[str, object]) -> None:
        super().__init__(config)

if __name__ == "__main__":

    test = {
        "foo": "one",
        "bar": "two"
    }

    c = Config(test)
    if c.foo() != "one" or c.bar() != "two":
        raise Exception(f"Whoops! foo={c.foo()} and bar={c.bar()}")