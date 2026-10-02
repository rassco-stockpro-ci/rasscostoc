import express, { type Express } from "express";
import fs from "fs";
import path from "path";

/**
 * Production static serving of the built portal (dist/public). Kept apart
 * from ./vite (the development server) so the production bundle never
 * imports the dev-only `vite` package.
 */
export function serveStatic(app: Express) {
  const distPath = path.resolve(import.meta.dirname, "public");

  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  app.use(express.static(distPath, {
    setHeaders: (res) => {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    }
  }));

  // fall through to index.html if the file doesn't exist
  app.use("*", (req, res) => {
    // Production parity (e8c481e): an unmatched /api/* request must never
    // receive the SPA's index.html — that masks a missing API route as a
    // fake "200 text/html" success. Answer a real JSON 404 instead.
    if (req.originalUrl.startsWith("/api/")) {
      return res.status(404).json({
        success: false,
        message: "API endpoint not found",
      });
    }

    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
