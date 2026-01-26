
export interface GitHubConfig {
  owner: string;
  repo: string;
  branch: string;
  sourcePath: string;
  targetPath: string;
}

export interface TranslationRow {
  key: string;
  sourceValue: string;
  targetValue: string;
  originalTargetValue: string;
  pastSourceValue: string;
  aiSuggestion?: string;
}

export enum GeminiModel {
  'G3-FLASH-PRE' = 'gemini-3-flash-preview',
  'G3-PRO-PRE' = 'gemini-3-pro-preview',
  'G2.5-FLASH' = 'gemini-2.5-flash',
  'G2.5-PRO' = 'gemini-2.5-pro',
  'GA3-27B-IT' = 'gemma-3-27b-it',
}

export interface GlobalSettings {
  githubToken: string;
  geminiApiKey: string;
  suggestionChunkSize: number;
}

export interface Project {
  id: string;
  name: string;
  config: GitHubConfig;
  rows: TranslationRow[];
  selectedModel: GeminiModel;
  lastUpdated: number;
  originalTargetData: Record<string, ValueType>;
}

export interface GlobalState {
  projects: Project[];
  activeProjectId: string | null;
  settings: GlobalSettings;
}

export type ValueType = string | number | boolean;
