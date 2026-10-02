import type { Express, Request, Response } from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { log } from "@core/utils/log";

export function registerSduiFiltersRoutes(app: Express): void {
  app.get("/api/mobile/v1/screens/custody/filters", async (req: Request, res: Response) => {
    try {
      // 1. Resolve external configuration file path (outside dist)
      const configPath = process.env.MOBILE_SDUI_FILTER_CONFIG_PATH
        ? path.resolve(process.env.MOBILE_SDUI_FILTER_CONFIG_PATH)
        : path.resolve(process.cwd(), "config/mobile-sdui-filters.json");

      if (!fs.existsSync(configPath)) {
        log(`[SDUI Filters API] Config file not found at ${configPath}`);
        return res.status(500).json({
          success: false,
          error: "SDUI configuration file missing",
        });
      }

      let rawConfig: any;
      try {
        const rawContent = fs.readFileSync(configPath, "utf8");
        rawConfig = JSON.parse(rawContent);
      } catch (err: any) {
        log(`[SDUI Filters API] Malformed config JSON: ${err.message}`);
        return res.status(500).json({
          success: false,
          error: "Invalid SDUI configuration format",
        });
      }

      // If configuration file contains wrapped payload, extract inner data
      const payload = rawConfig.data ? rawConfig.data : rawConfig;

      // 2. Validate Runtime Schema & Limits
      const jsonString = JSON.stringify(payload);
      if (Buffer.byteLength(jsonString, "utf8") > 51200) {
        log(`[SDUI Filters API] Payload exceeds 50KB limit`);
        return res.status(500).json({
          success: false,
          error: "SDUI payload size exceeds maximum limit",
        });
      }

      if (
        typeof payload.schemaVersion !== "number" ||
        typeof payload.configVersion !== "number" ||
        typeof payload.issuedAt !== "string" ||
        typeof payload.expiresAt !== "string" ||
        typeof payload.keyId !== "string" ||
        typeof payload.minAppVersion !== "string" ||
        typeof payload.screenId !== "string" ||
        !Array.isArray(payload.filters)
      ) {
        log(`[SDUI Filters API] Schema validation failed: missing required top-level fields`);
        return res.status(500).json({
          success: false,
          error: "SDUI schema validation failed",
        });
      }

      if (payload.filters.length > 20) {
        log(`[SDUI Filters API] Filters count ${payload.filters.length} exceeds max limit of 20`);
        return res.status(500).json({
          success: false,
          error: "SDUI filters count exceeds limit",
        });
      }

      // Check dates (expiresAt and issuedAt)
      const expiresTs = Date.parse(payload.expiresAt);
      if (isNaN(expiresTs) || expiresTs <= Date.now()) {
        log(`[SDUI Filters API] Config expired or invalid expiresAt: ${payload.expiresAt}`);
        return res.status(500).json({
          success: false,
          error: "SDUI configuration expired or invalid date",
        });
      }

      const issuedTs = Date.parse(payload.issuedAt);
      if (isNaN(issuedTs) || issuedTs > Date.now() + 60000) {
        log(`[SDUI Filters API] Config issuedAt in the future: ${payload.issuedAt}`);
        return res.status(500).json({
          success: false,
          error: "SDUI configuration issuedAt invalid",
        });
      }

      for (const filter of payload.filters) {
        if (!filter.id || typeof filter.id !== "string" || filter.id.length > 36) {
          return res.status(500).json({ success: false, error: "Invalid filter ID" });
        }
        if (!filter.label || typeof filter.label !== "string" || filter.label.length > 50) {
          return res.status(500).json({ success: false, error: "Invalid filter label" });
        }
        if (typeof filter.enabled !== "boolean" || typeof filter.order !== "number") {
          return res.status(500).json({ success: false, error: "Invalid filter properties" });
        }
      }

      // 3. Resolve fixed Private Key (outside Git)
      const privateKeyPath = process.env.MOBILE_SDUI_ED25519_PRIVATE_KEY_PATH
        ? path.resolve(process.env.MOBILE_SDUI_ED25519_PRIVATE_KEY_PATH)
        : path.resolve(process.cwd(), "config/sdui_ed25519_private.key");

      if (!fs.existsSync(privateKeyPath)) {
        log(`[SDUI Filters API] Private key file missing at ${privateKeyPath}`);
        return res.status(500).json({
          success: false,
          error: "SDUI signing key missing",
        });
      }

      let privateKey: crypto.KeyObject;
      try {
        const keyPemOrDer = fs.readFileSync(privateKeyPath);
        privateKey = crypto.createPrivateKey(keyPemOrDer);
      } catch (keyErr: any) {
        log(`[SDUI Filters API] Failed to parse private key: ${keyErr.message}`);
        return res.status(500).json({
          success: false,
          error: "Invalid SDUI signing key",
        });
      }

      // 4. Canonicalize JSON (sort keys recursively)
      const sortKeys = (obj: any): any => {
        if (Array.isArray(obj)) return obj.map(sortKeys);
        if (obj !== null && typeof obj === "object") {
          return Object.keys(obj)
            .sort()
            .reduce((acc: any, key: string) => {
              acc[key] = sortKeys(obj[key]);
              return acc;
            }, {});
        }
        return obj;
      };

      const canonicalJson = JSON.stringify(sortKeys(payload));

      // 5. Sign Canonical JSON with fixed Ed25519 Private Key
      const signatureBuffer = crypto.sign(null, Buffer.from(canonicalJson, "utf8"), privateKey);
      const signatureHex = signatureBuffer.toString("hex");

      // 6. Compute ETag
      const etagHash = crypto.createHash("md5").update(canonicalJson + signatureHex).digest("hex");
      const etag = `W/"sdui-v${payload.configVersion}-${etagHash.substring(0, 8)}"`;

      // 7. Check ETag match for 304 Not Modified
      const clientEtag = req.headers["if-none-match"];
      if (clientEtag && clientEtag === etag) {
        res.setHeader("ETag", etag);
        return res.status(304).end();
      }

      // 8. Send signed response
      res.setHeader("ETag", etag);
      res.setHeader("Content-Type", "application/json");
      return res.status(200).json({
        success: true,
        signature: signatureHex,
        data: payload,
      });
    } catch (err: any) {
      log(`[SDUI Filters API] Internal error: ${err.message}`);
      return res.status(500).json({
        success: false,
        error: "Internal SDUI error",
      });
    }
  });
}
