export type BucketLayout = {
  usersPrefix: string
  projectsPrefix: string
  tempPrefix: string
}

export type LifecycleRule = {
  id: string
  prefix: string
  expireDays: number
}

export function getRecommendedBucketLayout(): BucketLayout {
  return {
    usersPrefix: "users/",
    projectsPrefix: "projects/",
    tempPrefix: "temp/",
  }
}

export function getRecommendedLifecycleRules(): LifecycleRule[] {
  return [
    { id: "temp-expire-7d", prefix: "temp/", expireDays: 7 },
    { id: "project-artifacts-expire-90d", prefix: "projects/", expireDays: 90 },
  ]
}

