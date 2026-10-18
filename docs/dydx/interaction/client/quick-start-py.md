# Quick Start with Python – dYdX Documentation

> Source: https://docs.dydx.xyz/interaction/client/quick-start-py

This guide will walk you through the steps to set up and start using the dYdX API Python library.

## Install Python3 and Poetry

Choose and install [Python 3.9+](https://www.python.org/downloads/) and [Poetry](https://python-poetry.org/docs#installing-with-the-official-installer) for your system.

## Clone the dydx client repo

```
git clone https://github.com/dydxprotocol/v4-clients.git
```

## Install all dependencies

Go to the Python client library.

```
cd v4-clients/v4-client-py-v2
```

Install the project dependencies using the following command:

```
poetry install
```

## Run an example

Now, we can run an example file. Let's run `example/accounts_endpoint.py` file.

```
poetry run python -m examples.account_endpoints
```

**Now, you can play around with all the available examples. Happy trading!**

## Python Package

The Python client is also available through the PyPI [package](https://pypi.org/project/dydx-v4-client/) `dydx-v4-client`.

### Installation

```
pip install dydx-v4-client
```
