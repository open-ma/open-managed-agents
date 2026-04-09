# TODO

## Custom Sandbox Dockerfile
Create a custom Dockerfile matching Anthropic's container spec. Currently using `@cloudflare/sandbox` SDK default image which is missing:
- Go 1.22+, Rust 1.77+/cargo, Java 21+/maven/gradle, Ruby 3.3+/gem, PHP 8.3+/composer
- ripgrep, tmux/screen, ssh/scp, cmake
- PostgreSQL client (psql), Redis client (redis-cli)
- Python should be 3.12+ (currently 3.11)
- GCC should be 13+ (currently 11)

Update `wrangler.jsonc` to point `image` to `./Dockerfile.sandbox` instead of SDK default.

## Session Resources
- GitHub repository mounting: clone repo into /workspace on session init
- File uploads: accept file_id in session resources, mount into container

## Multimodal Content in Messages
- Support image content blocks in user.message: `{ type: "image", source: { type: "base64" | "url" | "file", ... } }`
- Support document content blocks: `{ type: "document", source: { type: "base64" | "url" | "file", ... } }`
- PDF support: pass PDFs as document content to Claude via ai-sdk
- Vision: pass images to Claude for analysis
- Files API integration: reference uploaded files in messages via file_id

## Memory Search Optimization
- Integrate Cloudflare AI Search / Vectorize for semantic memory search
- Current implementation uses KV substring match (O(N) scan)
- Wrangler config: `[[ai_search]] binding = "SEARCH" id = "memory-search"`

## Streaming within steps
- Switch from `generateText` to `streamText` for token-by-token streaming
- Emit content_block_delta SSE events for real-time text output

## Console Enhancements
- YAML/JSON agent config editor (like Anthropic's)
- Agent template library
- Session trace/timeline view (vs current chat view)
- Memory stores management page
