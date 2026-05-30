# Quick Start with TypeScript – dYdX Documentation

> Source: https://docs.dydx.xyz/interaction/client/quick-start-ts

This guide will walk you through the steps to set up and start using the dYdX API TypeScript library.

## Install Node and npm

Choose and install [node](https://nodejs.org/en/download) for your system.

## Clone the dydx client repo

```
git clone https://github.com/dydxprotocol/v4-clients.git
```

## Run an example

Go to the TypeScript client library.

```
cd v4-clients/v4-client-js
```

Install and use required node version using `nvm`

```
nvm install
nvm use
```

Install and build the examples

```
npm install
npm run build
```

Now, we can run an example file. Let's run `example/accounts_endpoint.js` file.

```
node ../build/examples/account_endpoints.js
```

**Now, you can play around with all the available examples. Happy trading!**

## JavaScript Package

The JavaScript/TypeScript client is also available through the npm [package](https://www.npmjs.com/package/@dydxprotocol/v4-client-js) `v4-client-js`.

### Installation

```
npm i @dydxprotocol/v4-client-js
```
