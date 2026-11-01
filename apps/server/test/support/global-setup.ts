import type { TestProject } from 'vitest/node'
import { PgServer, startPgServer } from './pg-server'

let server: PgServer | undefined

export default async function setup(project: TestProject) {
  server = await startPgServer()
  project.provide('pgAdminUrl', server.adminUrl)
  return async () => {
    await server?.stop()
  }
}

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string
  }
}
