# Changelog

## v0.2.21...v0.2.22

[compare changes](https://github.com/univo/univo/compare/v0.2.21...v0.2.22)

### 🩹 Fixes

- **indexer:** Ensure height metadata is cleaned up ([#69](https://github.com/univo/univo/pull/69))

### ❤️ Contributors

- Sam Potter ([@sam-potter](https://github.com/sam-potter))

## v0.2.20...v0.2.21

[compare changes](https://github.com/univo/univo/compare/v0.2.20...v0.2.21)

### 🩹 Fixes

- **realtime:** Fix AbortController ([#67](https://github.com/univo/univo/pull/67))

### ❤️ Contributors

- Sam Potter ([@sam-potter](https://github.com/sam-potter))

## v0.2.19...v0.2.20

[compare changes](https://github.com/univo/univo/compare/v0.2.19...v0.2.20)

### 🩹 Fixes

- **realtime:** Fix infinite abort signal ([#65](https://github.com/univo/univo/pull/65))

### ❤️ Contributors

- Sam Potter ([@sam-potter](https://github.com/sam-potter))

## v0.2.18...v0.2.19

[compare changes](https://github.com/univo/univo/compare/v0.2.18...v0.2.19)

### 🚀 Enhancements

- **indexer:** Increase timeout when finalizing heads ([#60](https://github.com/univo/univo/pull/60))
- **actions:** Add support for actions ([#63](https://github.com/univo/univo/pull/63))

### 🩹 Fixes

- **wss:** Healthcheck fails to reinitialise socket transport ([#59](https://github.com/univo/univo/pull/59))
- **realtime:** Use interval polling for finalization ([#61](https://github.com/univo/univo/pull/61))
- **indexer:** Simplify finalization strategy ([#62](https://github.com/univo/univo/pull/62))

### ❤️ Contributors

- Sam Potter ([@sam-potter](https://github.com/sam-potter))

## v0.2.18

[compare changes](https://github.com/univo/univo/compare/v0.2.17...v0.2.18)

### 🚀 Enhancements

- **indexer:** Improve reorg handling ([#55](https://github.com/univo/univo/pull/55))
- **events:** Make storage delete required ([#57](https://github.com/univo/univo/pull/57))

### 🩹 Fixes

- **indexer:** Remove unused method public_writeUnfinalizedHeads ([#56](https://github.com/univo/univo/pull/56))

### ❤️ Contributors

- Sam Potter ([@sam-potter](https://github.com/sam-potter))

## v0.2.17

[compare changes](https://github.com/univo/univo/compare/v0.2.16...v0.2.17)

### 🚀 Enhancements

- **transport:** Increase default timeout ([#52](https://github.com/univo/univo/pull/52))
- **realtime:** Simplify unfinalized head delivery ([#53](https://github.com/univo/univo/pull/53))

### ❤️ Contributors

- Sam Potter ([@sam-potter](https://github.com/sam-potter))

## v0.2.16

[compare changes](https://github.com/univo/univo/compare/v0.2.15...v0.2.16)

### 🚀 Enhancements

- **realtime:** Implement local chain pruning ([#48](https://github.com/univo/univo/pull/48))
- **indexer:** Implement public_writeUnfinalizedHead ([#50](https://github.com/univo/univo/pull/50))

### 🩹 Fixes

- **cli:** Fix univo dev command ([#47](https://github.com/univo/univo/pull/47))
- **cli:** Use url safe base64 for univo dev ([#49](https://github.com/univo/univo/pull/49))

### 🏡 Chore

- **server:** Refactor HTTP handler ([#45](https://github.com/univo/univo/pull/45))
- **filter:** Remove matchFilter from public API ([#46](https://github.com/univo/univo/pull/46))

### ❤️ Contributors

- Sam Potter ([@sam-potter](https://github.com/sam-potter))

## v0.2.15

[compare changes](https://github.com/univo/univo/compare/v0.2.14...v0.2.15)

### 🚀 Enhancements

- **storage:** Migrate metadata storage adapter ([#43](https://github.com/univo/univo/pull/43))

### ❤️ Contributors

- Sam Potter ([@sam-potter](https://github.com/sam-potter))

## v0.2.14

[compare changes](https://github.com/univo/univo/compare/v0.2.13...v0.2.14)

### 🩹 Fixes

- **head:** Add parent hash to result type ([#41](https://github.com/univo/univo/pull/41))

### ❤️ Contributors

- Sam Potter ([@sam-potter](https://github.com/sam-potter))

## v0.2.13

[compare changes](https://github.com/univo/univo/compare/v0.2.12...v0.2.13)

### 🩹 Fixes

- **errors:** Return error results instead of throwing in `private_writeEventsAndGetKeys` ([#39](https://github.com/univo/univo/pull/39))

### ❤️ Contributors

- Sam Potter ([@sam-potter](https://github.com/sam-potter))

## v0.2.12

[compare changes](https://github.com/univo/univo/compare/v0.2.11...v0.2.12)

### 🚀 Enhancements

- **transport:** Add local transport for RPC ([#36](https://github.com/univo/univo/pull/36))
- **keys:** Use provided RPC methods for public_writeEventsAndGetKeys ([#37](https://github.com/univo/univo/pull/37))

### 🏡 Chore

- **examples:** Pin univo version for examples ([#35](https://github.com/univo/univo/pull/35))

### ❤️ Contributors

- Sam Potter ([@sam-potter](https://github.com/sam-potter))

## v0.2.11

[compare changes](https://github.com/univo/univo/compare/v0.2.10...v0.2.11)

### 🩹 Fixes

- **rpc:** Ensure RPC errors are propagated ([#33](https://github.com/univo/univo/pull/33))

### ❤️ Contributors

- Sam Potter ([@sam-potter](https://github.com/sam-potter))

## v0.2.10

[compare changes](https://github.com/univo/univo/compare/v0.2.9...v0.2.10)

### 🚀 Enhancements

- **timeout:** Add default timeout to RPC requests ([#31](https://github.com/univo/univo/pull/31))

### ❤️ Contributors

- Sam Potter ([@sam-potter](https://github.com/sam-potter))

## v0.2.9

[compare changes](https://github.com/univo/univo/compare/v0.2.8...v0.2.9)

### 🚀 Enhancements

- **correctness:** Ensure heads are unfinalized for public_writeUnfinalizedHeads ([#29](https://github.com/univo/univo/pull/29))

### ❤️ Contributors

- Sam Potter ([@sam-potter](https://github.com/sam-potter))

## v0.2.8

[compare changes](https://github.com/univo/univo/compare/v0.2.7...v0.2.8)

### 🩹 Fixes

- **client-sync:** Prevent client out-of-sync issue ([#27](https://github.com/univo/univo/pull/27))

### ❤️ Contributors

- Sam Potter ([@sam-potter](https://github.com/sam-potter))

## v0.2.7

[compare changes](https://github.com/univo/univo/compare/v0.2.6...v0.2.7)

### 🚀 Enhancements

- **retry-recovery:** Increase retry success rate when finalizing heads ([#25](https://github.com/univo/univo/pull/25))

### ❤️ Contributors

- Sam Potter ([@sam-potter](https://github.com/sam-potter))

## v0.2.6

[compare changes](https://github.com/univo/univo/compare/v0.2.5...v0.2.6)

### 🚀 Enhancements

- **memory:** Reduce memory usage of public_getFinalizedHeight ([#23](https://github.com/univo/univo/pull/23))

### ❤️ Contributors

- Sam Potter ([@sam-potter](https://github.com/sam-potter))

## v0.2.5

[compare changes](https://github.com/univo/univo/compare/v0.2.4...v0.2.5)

### 🩹 Fixes

- **correctness:** Fix finalisation at chain initialisation ([#21](https://github.com/univo/univo/pull/21))

### 🏡 Chore

- **examples:** Update realtime example ([#12](https://github.com/univo/univo/pull/12))

### ❤️ Contributors

- Sam Potter ([@sam-potter](https://github.com/sam-potter))

## v0.2.4

[compare changes](https://github.com/univo/univo/compare/v0.2.3...v0.2.4)

### 🩹 Fixes

- **finalized-height:** Ensure public_getFinalizedHeight never returns unfinalized height ([#19](https://github.com/univo/univo/pull/19))

### ❤️ Contributors

- Sam Potter ([@sam-potter](https://github.com/sam-potter))

## v0.2.3

[compare changes](https://github.com/univo/univo/compare/v0.2.2...v0.2.3)

### 🩹 Fixes

- **assert:** Remove assert utility ([#17](https://github.com/univo/univo/pull/17))

### ❤️ Contributors

- Sam Potter ([@sam-potter](https://github.com/sam-potter))

## v0.2.2

[compare changes](https://github.com/univo/univo/compare/v0.2.1...v0.2.2)

### 🚀 Enhancements

- **rpc:** Export RPC types ([#15](https://github.com/univo/univo/pull/15))

### ❤️ Contributors

- Sam Potter ([@sam-potter](https://github.com/sam-potter))

## v0.2.1

[compare changes](https://github.com/univo/univo/compare/v0.2.0...v0.2.1)

### 🩹 Fixes

- **assert:** Fix missing assert import ([#13](https://github.com/univo/univo/pull/13))

### ❤️ Contributors

- Sam Potter ([@sam-potter](https://github.com/sam-potter))

## v0.2.0

[compare changes](https://github.com/univo/univo/compare/v0.1.19...v0.2.0)

### 🚀 Enhancements

- **deletions:** Improve support for handling chain reorganisations ([#8](https://github.com/univo/univo/pull/8))
- **metadata:** Add KV metadata storage ([#9](https://github.com/univo/univo/pull/9))
- **correctness:** Move correctness inside metadata storage ([#10](https://github.com/univo/univo/pull/10))

### ❤️ Contributors

- Sam Potter ([@sam-potter](https://github.com/sam-potter))

## v0.1.19

[compare changes](https://github.com/univo/univo/compare/v0.1.18...v0.1.19)

### 🚀 Enhancements

- **dropped-subscriptions:** Ensure dropped subscriptions reinitialise ([#7](https://github.com/univo/univo/pull/7))

### ❤️ Contributors

- Sam Potter ([@sam-potter](https://github.com/sam-potter))

## v0.1.18

[compare changes](https://github.com/univo/univo/compare/v0.1.17...v0.1.18)

## v0.1.17

[compare changes](https://github.com/univo/univo/compare/v0.1.16...v0.1.17)

## v0.1.16

[compare changes](https://github.com/univo/univo/compare/v0.1.15...v0.1.16)

## v0.1.15

