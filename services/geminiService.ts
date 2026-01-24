
import { GoogleGenAI, Type } from "@google/genai";
import { GeminiModel } from "../types";

export async function getTranslationSuggestions(
  model: GeminiModel,
  apiKey: string,
  sourceLang: string,
  targetLang: string,
  texts: { key: string; value: string }[],
  additionalIntstructions = ""
) {
  const ai = new GoogleGenAI({ apiKey: apiKey });
  const isGemma = model.startsWith('gemma');
  const isGemini = model.startsWith('gemini');
  const schema = {
    type: Type.OBJECT,
    properties: texts.reduce((acc: any, item) => {
      acc[item.key] = { type: Type.STRING };
      return acc;
    }, {}),
  }
  
  try {
    const response = await ai.models.generateContent({
      model,
      contents: `Translate the following ${sourceLang} strings to ${targetLang}. 
      Provide the translations in a JSON object where keys match the input keys. 
      Be concise and context-aware.
      You SHOULD NOT include any other text outside the JSON object.${
      additionalIntstructions ? `\nAdditional Instructions: [${additionalIntstructions}]` : ""}${
      isGemini ? "" : `\nOutput only JSON under this schema: ${JSON.stringify(schema)}`}
      Input: ${JSON.stringify(texts)}`,
      config: isGemini ? {
        responseMimeType: "application/json",
        responseSchema: schema,
      } : undefined,
    });

    console.log("Raw Gemini response:", response);
    try {
      if (isGemini) return JSON.parse(response.text);
      else return JSON.parse(response.text.replaceAll("```json","").replaceAll("```",""));
    } catch (e) {
      console.error("Failed to parse Gemini response", e);
      console.error("Response text:", response.text);
      return {};
    }
  } catch (e) {
    console.error("Failed to generate content", e);
    return {};
  }
}
