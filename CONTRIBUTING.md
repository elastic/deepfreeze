# Contributing to Deepfreeze

All contributions are welcome: ideas, patches, documentation, bug reports,
complaints, etc!

Programming is not a required skill, and there are many ways to help out!
It is more important to us that you are able to contribute.

## Have a Question? Or an Idea or Feature Request?

* File a ticket on [github](https://github.com/elastic/deepfreeze/issues)

## Something Not Working? Found a Bug?

If you think you found a bug, it probably is a bug.

* File it on [github](https://github.com/elastic/deepfreeze/issues)

# Contributing Documentation and Code Changes

If you have a bugfix or new feature that you would like to contribute to
Deepfreeze, and you think it will take more than a few minutes to produce the fix
(ie; write code), it is worth discussing the change with the Deepfreeze users and
developers first! You can reach us via
[github](https://github.com/elastic/deepfreeze/issues).

## Contribution Steps

1. Test your changes! Run the test suite ('pytest --cov=deepfreeze').  Please note
   that this requires an Elasticsearch instance. The tests will try to connect
   to a local elasticsearch instance and run integration tests against it.
   **This will delete all the data stored there!** You can use the env variable
   `TEST_ES_SERVER` to point to a different instance (for example
   'otherhost:9203').
2. Please make sure you have signed our [Contributor License
   Agreement](http://www.elastic.co/contributor-agreement/). We are not
   asking you to assign copyright to us, but to give us the right to distribute
   your code without restriction. We ask this of all contributors in order to
   assure our users of the origin and continuing existence of the code. You
   only need to sign the CLA once.
3. Send a pull request! Push your changes to your fork of the repository and
   [submit a pull
   request](https://help.github.com/articles/using-pull-requests). In the pull
   request, describe what your changes do and mention any bugs/issues related
   to the pull request.
