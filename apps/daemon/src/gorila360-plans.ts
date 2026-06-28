import type { FastifyInstance } from "fastify";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";

// Gorila360 plans are an optional preset. Configure with ORQUESTER_GORILA360_PLANS_DIR,
// or it derives from ORQUESTER_GORILA360_ROOT. Unset => the endpoint returns [].
const PLANS_DIR =
  process.env.ORQUESTER_GORILA360_PLANS_DIR ??
  (process.env.ORQUESTER_GORILA360_ROOT
    ? join(process.env.ORQUESTER_GORILA360_ROOT, "frontend/docs/superpowers/plans")
    : "");

export interface Gorila360PlanSummary {
  id: string;
  name: string;
  filename: string;
  path: string;
  updatedAt: string;
}

function parseTitle(content: string, filename: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  return match?.[1].trim() ?? filename;
}

export async function listGorila360Plans(): Promise<Gorila360PlanSummary[]> {
  if (!PLANS_DIR) {
    return [];
  }

  const entries = await readdir(PLANS_DIR, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile() && extname(e.name) === ".md");

  const plans = await Promise.all(
    files.map(async (file) => {
      const path = join(PLANS_DIR, file.name);
      const content = await readFile(path, "utf8").catch(() => "");
      const mtime = (await stat(path).catch(() => ({ mtime: new Date(0) }))).mtime;

      return {
        id: file.name.replace(/\.md$/, ""),
        name: parseTitle(content, file.name),
        filename: file.name,
        path,
        updatedAt: mtime.toISOString()
      };
    })
  );

  return plans.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function registerGorila360PlanRoutes(app: FastifyInstance): void {
  app.get("/api/gorila360/plans", async (_request, reply): Promise<Gorila360PlanSummary[] | void> => {
    try {
      return await listGorila360Plans();
    } catch (error) {
      return reply.code(500).send({
        code: "PLANS_ERROR",
        message: error instanceof Error ? error.message : "Failed to list Gorila360 plans."
      });
    }
  });
}
