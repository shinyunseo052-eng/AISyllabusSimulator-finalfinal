import { parseSyllabusWithGroq } from "./parseSyllabus";

export async function parseSyllabusRequest(
  text: unknown,
  apiKey: string
): Promise<{ status: number; body: unknown }> {
  if (!apiKey) {
    return { status: 500, body: { error: "Syllabus parsing is not configured." } };
  }
  if (typeof text !== "string" || !text.trim()) {
    return { status: 400, body: { error: "Syllabus text is required." } };
  }
  try {
    return { status: 200, body: await parseSyllabusWithGroq(text, apiKey) };
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Failed to parse syllabus.";
    return { status: 502, body: { error: message } };
  }
}
