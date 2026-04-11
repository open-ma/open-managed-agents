# TODO

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

## Console Enhancements
- YAML/JSON agent config editor (like Anthropic's)
- Agent template library
- Session trace/timeline view (vs current chat view)
- Memory stores management page
