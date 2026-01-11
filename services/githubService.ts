
import { Octokit } from 'octokit';
import { GitHubConfig } from '../types';
import { bytesToBase64, textToBytes } from '@/utils';

export class GitHubService {
  private config: GitHubConfig;
  private token: string;

  constructor(config: GitHubConfig, token: string) {
    this.config = config;
    this.token = token;
  }

  private async fetchRaw(path: string) {
    const url = `https://api.github.com/repos/${this.config.owner}/${this.config.repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(this.config.branch)}`;
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
    const octokit = new Octokit({ auth: this.token });
    const metadataRes = await (async () => {
      const owner = this.config.owner;
      const repo = this.config.repo;
      const ref = this.config.branch;
      return octokit.request(`GET /repos/${owner}/${repo}/contents/${path}?=${ref}`, {
        owner: owner,
        repo: repo,
        path: path,
        ref: ref
      })
    })();
    
    if (!metadataRes.data) throw new Error("Could not find existing file for update.");
    const metadata = metadataRes.data;
    console.log("File metadata:", metadata);
    
    const updateUrl = `https://api.github.com/repos/${this.config.owner}/${this.config.repo}/contents/${encodeURIComponent(path)}`;
    const response = await fetch(updateUrl, {
      method: 'PUT',
      headers: {
        Authorization: `token ${this.token}`,
        'Content-Type': 'application/vnd.github+json',
      },
      body: JSON.stringify({
        message: message,
        content: bytesToBase64(textToBytes(content)),
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
