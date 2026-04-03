import fs from 'fs';
import path from 'path';

type PackageMetadata = {
  name?: string;
  version?: string;
};

export type ProjectInfo = {
  name: string;
  version: string;
  lastBuildAt: string | null;
  buildCommitSha: string | null;
  buildCommitShortSha: string | null;
  buildRunNumber: string | null;
  buildRefName: string | null;
};

function readPackageMetadata(): PackageMetadata {
  const packageJsonPath = path.join(__dirname, '../package.json');
  const rawPackageJson = fs.readFileSync(packageJsonPath, 'utf8');
  return JSON.parse(rawPackageJson) as PackageMetadata;
}

function normalizeMetadataValue(value?: string): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

const packageMetadata = readPackageMetadata();

export function getProjectInfo(): ProjectInfo {
  const buildCommitSha = normalizeMetadataValue(process.env.BUILD_COMMIT_SHA);

  return {
    name: packageMetadata.name || 'volleyball-play-analyzer',
    version: packageMetadata.version || 'unknown',
    lastBuildAt: normalizeMetadataValue(process.env.BUILD_TIMESTAMP),
    buildCommitSha,
    buildCommitShortSha: buildCommitSha ? buildCommitSha.slice(0, 7) : null,
    buildRunNumber: normalizeMetadataValue(process.env.BUILD_RUN_NUMBER),
    buildRefName: normalizeMetadataValue(process.env.BUILD_REF_NAME),
  };
}
