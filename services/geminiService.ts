
import { GoogleGenAI, Type } from "@google/genai";
import { GeminiModel } from "../types";

export async function getTranslationSuggestions(
  model: GeminiModel,
  apiKey: string,
  sourceLang: string,
  targetLang: string,
  texts: { key: string; value: string }[]
) {
  const ai = new GoogleGenAI({ apiKey: apiKey });
  
  try {
    const response = await ai.models.generateContent({
      model,
      contents: `Translate the following ${sourceLang} strings to ${targetLang}. 
      Provide the translations in a JSON object where keys match the input keys. 
      Be concise and context-aware.
      Input: ${JSON.stringify(texts)}`,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: texts.reduce((acc: any, item) => {
            acc[item.key] = { type: Type.STRING };
            return acc;
          }, {}),
        },
      },
    });
    try {
      return JSON.parse(response.text);
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
