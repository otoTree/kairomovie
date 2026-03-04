"use client"

import { requestJson } from "@/lib/client-api"

type Project = {
  id: string
  name: string
}

const DEFAULT_PROJECT_NAME = "未命名项目"

export async function ensureDefaultProject(token: string) {
  const projects = await requestJson<Project[]>("/api/v1/projects", { method: "GET" }, token)
  const existing = projects.find((project) => project.name === DEFAULT_PROJECT_NAME) || projects[0]
  if (existing) {
    return existing
  }
  const created = await requestJson<Project>(
    "/api/v1/projects",
    {
      method: "POST",
      body: JSON.stringify({
        name: DEFAULT_PROJECT_NAME,
        description: "系统默认项目",
        settings: {},
      }),
    },
    token
  )
  return created
}
