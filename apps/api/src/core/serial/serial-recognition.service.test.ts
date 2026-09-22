import { describe, expect, it, vi } from "vitest";
import { SerialRecognitionService } from "@core/serial/serial-recognition.service";

describe("SerialRecognitionService — Central Serial Engine", () => {
  describe("normalizeRawBarcode", () => {
    it("trims, uppercases, and strips SN:/dashes/spaces", () => {
      expect(SerialRecognitionService.normalizeRawBarcode("  sn: ncd-100253066  ")).toBe(
        "NCD100253066"
      );
    });

    it("strips GS1 ]C1 symbology prefix", () => {
      expect(SerialRecognitionService.normalizeRawBarcode("]C1NCD100253066")).toBe("NCD100253066");
    });

    it("returns empty for blank input", () => {
      expect(SerialRecognitionService.normalizeRawBarcode("")).toBe("");
      expect(SerialRecognitionService.normalizeRawBarcode(null as any)).toBe("");
    });
  });

  describe("buildStoredSerialCandidates", () => {
    it("includes cleaned, stripped alphabetic prefix, and recognition result", async () => {
      const tx = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([
          {
            id: "n950",
            nameAr: "N950",
            nameEn: "N950",
            category: "devices",
            isActive: true,
            requiresSerial: true,
            serialPrefix: "NCC,NCD",
            serialLength: 9,
            serialRegex: "^(NCC|NCD)[0-9]{9}$",
          },
        ]),
      };

      const candidates = await SerialRecognitionService.buildStoredSerialCandidates(
        "NCD100253066",
        "n950",
        tx
      );

      expect(candidates).toContain("NCD100253066");
      expect(candidates).toContain("100253066");
      // Regression: the canonical Central Serial Engine representation must
      // be first so downstream callers never select a legacy stripped form
      // by a secondary heuristic such as shortest-string selection.
      expect(candidates[0]).toBe("NCD100253066");
    });

    it("puts the OCR-corrected Saudi ICCID canonical form first", async () => {
      const typo = "9996606099020521896";
      const fixed = "8996606099020521896";
      const tx = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([
          {
            id: "lebaraSim",
            nameAr: "شرائح ليبارا",
            nameEn: "libar1",
            category: "sim",
            isActive: true,
            requiresSerial: true,
            serialPrefix: "89966",
            serialLength: 19,
            serialRegex: "^89966[0-9]{14}$",
          },
        ]),
      };

      const candidates = await SerialRecognitionService.buildStoredSerialCandidates(typo, undefined, tx);
      expect(candidates[0]).toBe(fixed);
    });

    it("keeps numeric SIM prefix (89966) in stored candidate", async () => {
      const iccid = "8996606099020521804";
      const tx = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([
          {
            id: "mobilySim",
            nameAr: "موبايلي",
            nameEn: "Mobily",
            category: "sims",
            isActive: true,
            requiresSerial: true,
            serialPrefix: "89966",
            serialLength: 19,
            serialRegex: "^89966[0-9]{14}$",
          },
        ]),
      };

      const candidates = await SerialRecognitionService.buildStoredSerialCandidates(
        iccid,
        "mobilySim",
        tx
      );

      expect(candidates).toContain(iccid);
      expect(candidates.every((c) => c.startsWith("89966") || c === iccid)).toBe(true);
    });

    it("expands OCR typo 99966… to 89966… for Saudi ICCID lookup", async () => {
      const typo = "9996606099020521896";
      const fixed = "8996606099020521896";
      expect(SerialRecognitionService.expandSaudiIccidTypoCandidates(typo)).toEqual([fixed]);

      const tx = {
        select: vi.fn().mockReturnThis(),
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([
          {
            id: "lebaraSim",
            nameAr: "شرائح ليبارا",
            nameEn: "libar1",
            category: "sim",
            isActive: true,
            requiresSerial: true,
            serialPrefix: "89966",
            serialLength: 19,
            serialRegex: "^89966[0-9]{14}$",
          },
        ]),
      };

      const candidates = await SerialRecognitionService.buildStoredSerialCandidates(typo, undefined, tx);
      expect(candidates).toContain(fixed);
      expect(candidates).toContain(typo);
    });
  });
});
