import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function askClaude(systemPrompt, userPrompt, maxTokens = 1024) {
  const message = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });
  return message.content.map((block) => block.text ?? "").join("");
}
