# @openma/sdk

## 1.0.0-beta.1

### Patch Changes

- 7629a91: Expose typed Model Card management and Pi provider metadata through the SDK,
  align model catalog discovery across Node and Cloudflare, and document the
  runtime semantics of effort, speed, and custom Pi model configuration.

## 1.0.0-beta.0

### Major Changes

- 68d2772: Replace the independent Managed Agents client with a composition facade over
  `@anthropic-ai/sdk`, and isolate OpenMA product extensions under `client.oma`.

## 0.1.0

### Minor Changes

- f72a33f: Add a dreams resource with automatic Managed Agents dreaming beta headers.
