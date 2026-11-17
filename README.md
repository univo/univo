# univo

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]

Blazing-fast, developer-friendly blockchain indexing software designed to help you extract, transform, and load historical and realtime blockchain data into your own storage systems at scale.

![univo](https://univo.app/img/univo.svg)

Conceptually, indexing software is responsible for synchronising data between a blockchain and some other storage system. The end goal is that your off-chain storage always accurately reflects the latest on-chain state.

univo was forged from years of experience building and maintaining blockchain indexers across the Ethereum ecosystem. It is designed to fit into your existing application and ensures that indexing blockchains remains simple, fast, and affordable as your application grows in scale and complexity.

## Documentation

Visit [univo.app](https://univo.app/docs) for documentation, guides, and the full API reference.

## Support

Join the univo [telegram chat](https://t.me/univo_app) for support or to provide feedback.

## Quickstart

```shell
npm install univo viem
```

```typescript
import { wss } from "univo/transport";
import { realtime } from "univo/realtime";
import { defineStorage } from "univo/metadata";
import { parseAbiItem, toEventSelector } from "viem";
import { memory } from "univo/metadata/adapters/memory";
import { defineIndexer, defineEvent, defineAction } from "univo";

const abi = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

// Define an event that will upsert every ERC20 Transfer for each Ethereum block
const event = defineEvent({
    id: "transfers-erc20-event",

    // Use a filter define the specific blocks we want to index, in this case we only want blocks
    // on Ethereum mainnet where a transaction emitted a `Transfer` event log
    filters: [
        {
            chain: 1, 
            fromBlock: 0, 
            event: toEventSelector(abi) // "0xddf252ad1be2c..."
        }
    ],

    // Define a handler that maps the raw block data into a list of structured transfer events
    handler(block) {
        return block.eth_getBlockReceipts.flatMap(receipt => {
            return receipt.logs.flatMap(log => {
                try {
                    if (log.topics[0] !== toEventSelector(abi)) {
                        return [];
                    }

                    const { args } = decodeEventLog({ data: log.data, topics: log.topics, abi: [abi] });

                    return {
                        block_timestamp: block.eth_getBlockByNumber.timestamp,
                        block_number: block.eth_getBlockByNumber.number,
                        transaction_index: receipt.transactionIndex,
                        log_index: log.logIndex,
                        to_address: args.to,
                        quantity: args.value,
                        from_address: args.from,
                        token_address: log.address,
                    };
                } catch {
                    return [];
                }
            })
        })
    },

    // Define an adapter to store your events anywhere: Postgres, S3, ClickHouse, etc.
    storage: {
        async upsert(transfers) {
            console.log(transfers);
            // [{ to_address: "...", quantity: ..., from_address: "...", token_address: "..." }]
        }

        // Invoked when a chain reorganisation occurs and events must be removed from storage
        async delete(transfers) {
            console.log(transfers);
            // [{ to_address: "...", quantity: ..., from_address: "...", token_address: "..." }]
        }
    }
});

// Define an action to invoke for every ERC20 event that finalizes on-chain
const action = defineAction({
    event,

    id: "transfers-erc20-action",

    handler: async (event) => {
        console.log(event);
        // { to_address: "...", quantity: ..., from_address: "...", token_address: "..." }
    }
});

// NODE_URL is any WebSocket RPC provider e.g. wss://eth-mainnet.g.alchemy.com/v2/YOUR_API_KEY
const node = wss(process.env.NODE_URL);

const indexer = defineIndexer({ 
    events: [event],

    actions: [action],

    // univo stores metadata in any S3 compatible object storage. For this quickstart we will just use an 
    // in-memory store, in production you should use the `s3` or `r2` adapters to ensure that your indexer 
    // operates correctly and can safely recover from downtime.
    metadataStorage: defineStorage({
        adapter: memory(),
    }),

    // Provide a function to load block data in realtime from an RPC node. You can extend this by returning
    // any custom methods you want to provide to your events.
    getBlock: async (head: { chain: `0x${string}`; number: `0x${string}` | "finalized" }) => {
        const [eth_getBlockByNumber, eth_getBlockReceipts] = await Promise.all([
            node.request({ method: "eth_getBlockByNumber", params: [head.number, true] }),
            node.request({ method: "eth_getBlockReceipts", params: [head.number] })
        ]);

        return { 
            eth_chainId: head.chain, 
            eth_getBlockByNumber,
            eth_getBlockReceipts,
        };
    }, 
});

// Begin processing indexer in realtime from the latest block
realtime({ node, indexer });
```

## License

univo is MIT-licensed open-source software.

<!-- Badges -->

[npm-version-src]: https://img.shields.io/npm/v/univo?style=flat&colorA=18181B&colorB=F0DB4F
[npm-version-href]: https://npmjs.com/package/univo
[npm-downloads-src]: https://img.shields.io/npm/dm/univo?style=flat&colorA=18181B&colorB=F0DB4F
[npm-downloads-href]: https://npmjs.com/package/univo
