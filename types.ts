
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
  aiSuggestion?: string;
}

export enum GeminiModel {
  FLASH = 'gemini-3-flash-preview',
  PRO = 'gemini-3-pro-preview'
}

export interface GlobalSettings {
  githubToken: string;
  geminiApiKey: string;
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
