
import { GitHubConfig } from '../types';

export class GitHubService {
  private config: GitHubConfig;
  private token: string;

  constructor(config: GitHubConfig, token: string) {
    this.config = config;
    this.token = token;
  }

  private async fetchRaw(path: string) {
    const url = `https://api.github.com/repos/${this.config.owner}/${this.config.repo}/contents/${path}?ref=${this.config.branch}`;
    const response = await fetch(url, 
      this.token ? {
        headers: {
          Authorization: `token ${this.token}`,
          Accept: 'application/vnd.github.v3.raw',
        },
      } : {
        headers: {
          Accept: 'application/vnd.github.v3.raw',
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch ${path}: ${response.statusText}`);
    }

    return await response.json();
  }

  async loadFiles() {
    const source = await this.fetchRaw(this.config.sourcePath);
    const target = await this.fetchRaw(this.config.targetPath);
    return { source, target };
  }

  async pushFile(content: string, path: string, message: string) {
    const metadataUrl = `https://api.github.com/repos/${this.config.owner}/${this.config.repo}/contents/${path}?ref=${this.config.branch}`;
    const metadataRes = await fetch(metadataUrl, {
      headers: {
        Authorization: `token ${this.token}`,
      },
    });
    
    if (!metadataRes.ok) throw new Error("Could not find existing file for update.");
    const metadata = await metadataRes.json();

    const updateUrl = `https://api.github.com/repos/${this.config.owner}/${this.config.repo}/contents/${path}`;
    const response = await fetch(updateUrl, {
      method: 'PUT',
      headers: {
        Authorization: `token ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message,
        content: btoa(unescape(encodeURIComponent(content))),
        sha: metadata.sha,
        branch: this.config.branch,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || "Failed to push to GitHub");
    }

    return await response.json();
  }
}
