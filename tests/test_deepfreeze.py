from deepfreeze.deepfreeze import Deepfreeze


def test_config():
    freezer = Deepfreeze(
        year="2024",
        month="13",
        debug=False,
        verbose=False,
        elasticsearch="https://192.168.1.151:9200",
        ca="/etc/elasticsearch/certs/http_ca.crt",
        username="elastic",
        password="foo",
        repo_name_prefix="deepfreeze-",
        bucket_name_prefix="deepfreeze-",
        style="monthly",
        base_path="snapshots",
        canned_acl="private",
        storage_class="intelligent_tiering",
        keep=6,
    )

    assert freezer.year == "2024"
    assert freezer.month == "13"
    assert freezer.debug == False
    assert freezer.verbose == False
    assert freezer.elasticsearch == "https://192.168.1.151:9200"
    assert freezer.ca == "/etc/elasticsearch/certs/http_ca.crt"
    assert freezer.username == "elastic"
    assert freezer.password == "foo"
    assert freezer.repo_name_prefix == "deepfreeze-"
    assert freezer.bucket_name_prefix == "deepfreeze-"
    assert freezer.style == "monthly"
    assert freezer.base_path == "snapshots"
    assert freezer.canned_acl == "private"
    assert freezer.storage_class == "intelligent_tiering"
    assert freezer.keep == 6
