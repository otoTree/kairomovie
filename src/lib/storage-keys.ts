import path from "path"

function normalizeRelativePath(inputPath: string) {
  const trimmed = inputPath.trim()
  if (!trimmed) {
    throw new Error("path 不能为空")
  }
  const normalized = path.posix.normalize(trimmed.replaceAll("\\", "/"))
  if (normalized.startsWith("/") || normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error("path 非法")
  }
  return normalized
}

export function getUserObjectKey(userId: string, relativePath: string) {
  const clean = normalizeRelativePath(relativePath)
  return `users/${userId}/${clean}`
}

export function getProjectObjectKey(projectId: string, relativePath: string) {
  const clean = normalizeRelativePath(relativePath)
  return `projects/${projectId}/${clean}`
}

export function getProjectAssetKey(projectId: string, relativePath: string) {
  const clean = normalizeRelativePath(relativePath)
  return `projects/${projectId}/assets/${clean}`
}

export function getProjectArtifactKey(projectId: string, taskId: string, relativePath: string) {
  const clean = normalizeRelativePath(relativePath)
  return `projects/${projectId}/artifacts/${taskId}/${clean}`
}

