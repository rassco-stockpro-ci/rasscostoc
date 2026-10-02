/**
 * DEVELOPMENT ONLY. Imports the dev-only `vite` package and vite.config's
 * dev plugins, so it must only ever be loaded with a dynamic import guarded
 * by the development check (server.ts). Production code uses ./log and
 * ./static, which do not depend on vite.
 */
import { type Express } from "express";
import fs from "fs";
import path from "path";
import { createServer as createViteServer, createLogger } from "vite";
import { type Server } from "http";
import viteConfig from "../../../../../vite.config";
import { nanoid } from "nanoid";

const viteLogger = createLogger();

export async function setupVite(app: Express, server: Server) {
  const serverOptions = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: true as const,
  };

  const vite = await createViteServer({
    ...viteConfig,
    configFile: false,
    customLogger: {
      ...viteLogger,
      error: (msg, options) => {
        viteLogger.error(msg, options);
        process.exit(1);
      },
    },
    server: serverOptions,
    appType: "custom",
  });

  app.use(vite.middlewares);
  app.use("*", async (req, res, next) => {
    const url = req.originalUrl;

    // ROOT FIX (TEMP-SYSTEM-STABILIZATION): an unmatched /api/* request must never
    // fall through to the SPA HTML shell — that silently masks missing/broken API
    // routes as a fake "200 text/html" success to the frontend. Any /api/* request
    // that reaches this wildcard means no route matched it; answer with a real JSON
    // 404 instead.
    if (url.startsWith("/api/")) {
      return res.status(404).json({
        success: false,
        message: "API endpoint not found",
      });
    }

    try {
      const clientTemplate = path.resolve(
        import.meta.dirname,
        "..",
        "..",
        "..",
        "..",
        "..",
        "apps",
        "portal",
        "index.html",
      );

      // always reload the index.html file from disk incase it changes
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`,
      );
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}
