import { z } from "zod";

const schema = z.object({
  file_path: z.string().describe("path"),
  content: z.string().describe("content"),
});

console.log("zod version:", z.string().constructor.name);
console.log("_def keys:", Object.keys(schema._def));
console.log("_def.typeName:", schema._def.typeName);
console.log("_def.shape:", typeof schema._def.shape);
console.log("~standard:", JSON.stringify(schema["~standard"]?.version));

// Try what AI SDK does
const shape = schema._def.shape?.();
console.log("shape keys:", shape ? Object.keys(shape) : "SHAPE IS FALSY");
console.log("shape.file_path:", shape?.file_path?._def?.typeName);
