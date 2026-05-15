import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * shadcn / ai-elements canonical class merger. clsx normalizes a mixed
 * argument list (strings, conditionals, arrays, objects); twMerge
 * resolves conflicting Tailwind utilities so the *last* one wins
 * (e.g., `cn("p-2", "p-4")` → `"p-4"`).
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
