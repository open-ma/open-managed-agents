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
] as EvalTask[];
