import { GitMeta } from "@platos/core/v3";
import { type Prisma } from "~/db.server";

export type GitMetaLinks = {
  /** The cleaned repository URL without any username/password */
  repositoryUrl: string;
  /** The branch name */
  branchName: string;
  /** Link to the specific branch */
  branchUrl: string;
  /** Link to the specific commit */
  commitUrl: string;
  /** Link to the pull request (if available) */
  pullRequestUrl?: string;
  /** The pull request number (if available) */
  pullRequestNumber?: number;
  /** The pull request title (if available) */
  pullRequestTitle?: string;
  /** Link to compare this branch with main */
  compareUrl: string;
  /** Shortened commit SHA (first 7 characters) */
  shortSha: string;
  /** Whether the branch has uncommitted changes */
  isDirty: boolean;
  /** The commit message */
  commitMessage: string;
  /** The commit author */
  commitAuthor: string;

  /** The git provider, e.g., `github` */
  provider?: string;

  source?: "trigger_github_app" | "github_actions" | "local";
  ghUsername?: string;
  ghUserAvatarUrl?: string;
};

export function processGitMetadata(data: Prisma.JsonValue): GitMetaLinks | null {
  if (!data) return null;

  const parsed = GitMeta.safeParse(data);
  if (!parsed.success) {
    return null;
  }

  if (!parsed.data.remoteUrl) {
    return null;
  }

  // Clean the remote URL by removing any username/password and ensuring it's a proper GitHub URL
  const cleanRemoteUrl = (() => {
    try {
      const url = new URL(parsed.data.remoteUrl);
      // Remove any username/password from the URL
      url.username = "";
      url.password = "";
      // Ensure we're using https
      url.protocol = "https:";
      // Remove any trailing .git
      return url.toString().replace(/\.git$/, "");
    } catch (e) {
      // If URL parsing fails, try to clean it manually
      return parsed.data.remoteUrl
        .replace(/^git@github\.com:/, "https://github.com/")
        .replace(/^https?:\/\/[^@]+@/, "https://")
        .replace(/\.git$/, "");
    }
  })();

  if (!parsed.data.commitRef || !parsed.data.commitSha) return null;

  const shortSha = parsed.data.commitSha.slice(0, 7);

  return {
    repositoryUrl: cleanRemoteUrl,
    branchName: parsed.data.commitRef,
    branchUrl: `${cleanRemoteUrl}/tree/${parsed.data.commitRef}`,
    commitUrl: `${cleanRemoteUrl}/commit/${parsed.data.commitSha}`,
    pullRequestUrl: parsed.data.pullRequestNumber
      ? `${cleanRemoteUrl}/pull/${parsed.data.pullRequestNumber}`
      : undefined,
    pullRequestNumber: parsed.data.pullRequestNumber,
    pullRequestTitle: parsed.data.pullRequestTitle,
    compareUrl: `${cleanRemoteUrl}/compare/main...${parsed.data.commitRef}`,
    shortSha,
    isDirty: parsed.data.dirty ?? false,
    commitMessage: parsed.data.commitMessage ?? "",
    commitAuthor: parsed.data.commitAuthorName ?? "",
    provider: parsed.data.provider,
    source: parsed.data.source,
    ghUsername: parsed.data.ghUsername,
    ghUserAvatarUrl: parsed.data.ghUserAvatarUrl,
  };
}
