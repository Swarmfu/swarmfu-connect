# @swarmfu/connect-protocol

The contract between game adapters, the `swarmfu` bridge and Swarmfu's backend:
- **Game events:** lanes, reactions and subjects.
- **Adapter manifests**, and the checks run against them.
- **The bridge's wire messages**, and the pairing code format.
- **The file protocol** that connector mods write, and the game packs that read it.
- **`./adapter`:** `createAdapterServer()`, the MCP side of an adapter.

See [swarmfu-connect](https://github.com/Swarmfu/swarmfu-connect) for the mod guide and examples.
