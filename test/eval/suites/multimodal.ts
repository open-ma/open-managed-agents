import type { EvalTask } from "../types.js";
import { DEFAULT_TOOLS, DEFAULT_SYSTEM } from "../types.js";
import { all, idleNoError, includes, toolUsed } from "../../../packages/shared/src/index.js";

// 64x64 PNG: red square in white border. Used to validate the multimodal
// Read tool pipeline end-to-end (image → tool result with ContentBlock[] →
// model receives image → answers correctly).
const RED_BOX_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAaElEQVR4nO3PsRGAMBADwe+/aVMB" +
  "EcHy49NcAdo5yzf6wNcF0AugF0DvHTDzrwLoAugC6ALoAugC6ALoAugC6ALoAugC6ALoAugC6ALo" +
  "AugC6ALoAugC6ALoAujuAyxZAL0AegH01gMeqBHjtLUqYeAAAAAASUVORK5CYII=";

// 1-page PDF containing the single word "DOLPHIN". Used to validate the
// multimodal Read tool's PDF path: agent decodes base64 → reads file →
// Read tool emits document ContentBlock → Claude reads the PDF → answers.
const DOLPHIN_PDF_B64 =
  "JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4K" +
  "ZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4K" +
  "ZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAg" +
  "MCA2MTIgNzkyXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAw" +
  "IFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA0NSAvRmlsdGVyIC9GbGF0ZURl" +
  "Y29kZSA+PgpzdHJlYW0KeJxzClHQdzNUMLFQCElTMDQwUDAB4pAUBQ0Xf58AD08/TYWQLAXXEACs" +
  "nAkWCmVuZHN0cmVhbQplbmRvYmoKNSAwIG9iago8PCAvVHlwZSAvRm9udCAvU3VidHlwZSAvVHlw" +
  "ZTEgL0Jhc2VGb250IC9IZWx2ZXRpY2EgPj4KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1" +
  "MzUgZiAKMDAwMDAwMDAxNSAwMDAwMCBuIAowMDAwMDAwMDY0IDAwMDAwIG4gCjAwMDAwMDAxMjEg" +
  "MDAwMDAgbiAKMDAwMDAwMDI0NyAwMDAwMCBuIAowMDAwMDAwMzYzIDAwMDAwIG4gCnRyYWlsZXIK" +
  "PDwgL1NpemUgNiAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKNDMzCiUlRU9GCg==";

export const multimodalSuite: EvalTask[] = [
  // T6.1 — Image vision (validates Read tool's multimodal output pipeline)
  {
    id: "T6.1-image-vision",
    category: "tool-use", // reuse existing category — the suite registry handles it
    difficulty: "medium",
    description: "Read an image file and identify its dominant color (multimodal pipeline)",
    agentConfig: {
      system:
        "You are a vision-capable assistant. When asked to read an image, use the read tool and " +
        "directly observe the image content. Be concise.",
      tools: DEFAULT_TOOLS,
    },
    turns: [
      {
        message:
          "Step 1: decode this base64 to /workspace/img.png:\n```\n" +
          RED_BOX_PNG_B64 +
          "\n```\n\nUse bash:\n```\npython3 -c \"import base64; open('/workspace/img.png','wb').write(base64.b64decode('" +
          RED_BOX_PNG_B64 +
          "'))\"\n```\n\nStep 2: use the read tool on /workspace/img.png\n\nStep 3: tell me what dominant color you see in the image. Answer in one word.",
        verify: () => ({ status: "pass", message: "advisory only" }),
      },
    ],
    // Scorer: agent must use read tool on the png AND its message must mention "red".
    // includes() defaults to case-insensitive, so "Red", "RED", "red" all pass.
    scorer: all(
      toolUsed("read"),
      // The agent's reply text should contain "red" (the dominant color)
      includes("red"),
      idleNoError(),
    ),
  },
  // T6.2 — PDF document (validates Read tool's PDF → document ContentBlock pipeline)
  {
    id: "T6.2-pdf-vision",
    category: "tool-use",
    difficulty: "medium",
    description: "Read a PDF file and identify the single word it contains (multimodal pipeline)",
    agentConfig: {
      system:
        "You are a document-capable assistant. When asked to read a PDF, use the read tool and " +
        "directly observe the document content. Be concise.",
      tools: DEFAULT_TOOLS,
    },
    turns: [
      {
        message:
          "Step 1: decode this base64 to /workspace/dolphin.pdf:\n```\n" +
          DOLPHIN_PDF_B64 +
          "\n```\n\nUse bash:\n```\npython3 -c \"import base64; open('/workspace/dolphin.pdf','wb').write(base64.b64decode('" +
          DOLPHIN_PDF_B64 +
          "'))\"\n```\n\nStep 2: use the read tool on /workspace/dolphin.pdf\n\nStep 3: tell me the single word that appears in the PDF. Answer in one word, all uppercase.",
        verify: () => ({ status: "pass", message: "advisory only" }),
      },
    ],
    // Scorer: agent must use read tool on the pdf AND its message must mention "DOLPHIN".
    scorer: all(
      toolUsed("read"),
      includes("dolphin"),
      idleNoError(),
    ),
  },
  // T6.3 — PDF via file_id (validates POST /v1/files → message file_id reference
  // → server-side resolver inlines base64 → Claude reads the PDF). This is the
  // Anthropic Files-API ↔ Messages-API binding equivalent.
  {
    id: "T6.3-pdf-via-file-id",
    category: "tool-use",
    difficulty: "medium",
    description: "Reference an uploaded PDF by file_id (server-side resolver path)",
    agentConfig: {
      system:
        "You are a document-capable assistant. When the user attaches a PDF, " +
        "read its content and answer concisely.",
      tools: DEFAULT_TOOLS,
    },
    setupUploads: [
      {
        filename: "dolphin.pdf",
        content: DOLPHIN_PDF_B64,
        encoding: "base64",
        media_type: "application/pdf",
      },
    ],
    turns: [
      {
        message: ({ fileIds }) => [
          {
            type: "text",
            text: "What single word appears in the attached PDF? Answer in one word, all uppercase.",
          },
          {
            type: "document",
            source: {
              type: "file",
              file_id: fileIds[0],
              media_type: "application/pdf",
            },
          },
        ],
        verify: () => ({ status: "pass", message: "advisory only" }),
      },
    ],
    scorer: all(
      includes("dolphin"),
      idleNoError(),
    ),
  },
] as EvalTask[];
