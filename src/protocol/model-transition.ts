import { isVisionNativeModel, type GlmMessage } from "../llm/glm-client.js";

export type ModelTransitionCheck = { ok: true } | {
  ok: false; reason: "retained_images"; message: string;
};

export function checkModelTransition(
  messages: readonly GlmMessage[], targetModel: string,
): ModelTransitionCheck {
  if (isVisionNativeModel(targetModel)) return { ok: true };
  const hasImages = messages.some(message => message.role === "user" && Array.isArray(message.content) &&
    message.content.some(part => part.type === "image_url"));
  if (!hasImages) return { ok: true };
  return { ok: false, reason: "retained_images",
    message: "This session retains native images that the selected model cannot accept. Keep an image-capable model or start a text-only session with a textual description." };
}
