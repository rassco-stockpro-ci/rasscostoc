import type { Express } from "express";
import type { Server } from "http";

/**
 * Vite Development Server Setup
 * Handles development and production static file serving
 * Temporary implementation - to be moved from existing structure
 */

export async function setupVite(app: Express, server: Server): Promise<void> {
  // Import existing vite setup temporarily
  const { setupVite: legacySetupVite } = await import("@core/utils/vite");
  return legacySetupVite(app, server);
}

export async function serveStatic(app: Express): Promise<void> {
  // Import existing static serving temporarily  
  const { serveStatic: legacyServeStatic } = await import("@core/utils/static");
  return legacyServeStatic(app);
}